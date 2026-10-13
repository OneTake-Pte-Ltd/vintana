// CSV import/export for expenses and payroll. Imports match existing rows by name
// (case-insensitive) and update them; everything else is created. Rows are validated
// first, and nothing is written if any row has an error.

import { query, execute, batch } from './db.js';
import { getBaseScenarioId } from './schema.js';
import { parseCsv, toCsv, parseAmountToCents, parseMonth } from './csv.js';
import { currentMonth, chargeFromMonthly, expenseMonthlyValues, forecastEnd } from './utils.js';

export const EXPENSE_COLUMNS = ['name', 'company', 'category', 'amount', 'recurrence', 'renewal_day', 'start_month', 'end_month', 'notes'];
export const PAYROLL_COLUMNS = ['name', 'role', 'department', 'monthly_salary', 'employer_tax_pct', 'start_month', 'end_month', 'notes'];

const DEFAULT_CATEGORY = 'Uncategorized / Other';
const RECURRENCE_ALIASES = {
  monthly: 'monthly', month: 'monthly',
  quarterly: 'quarterly', quarter: 'quarterly',
  annual: 'annual', annually: 'annual', yearly: 'annual', year: 'annual',
  one_time: 'one_time', once: 'one_time', onetime: 'one_time',
};
const BATCH_SIZE = 200;

const centsToPlain = c => (c / 100).toFixed(2).replace(/\.00$/, '');
const key = name => name.trim().toLowerCase();

function readRows(text, required) {
  const { headers, rows } = parseCsv(text);
  const missing = required.filter(c => !headers.includes(c));
  if (missing.length) {
    return { errors: [`Missing column${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`] };
  }
  if (rows.length === 0) return { errors: ['The file has no data rows'] };
  return { rows, errors: [] };
}

function checkDuplicateNames(parsed, errors) {
  const seen = new Map();
  for (const p of parsed) {
    const k = key(p.name);
    if (seen.has(k)) errors.push(`Row ${p.line}: "${p.name}" also appears on row ${seen.get(k)}`);
    else seen.set(k, p.line);
  }
}

async function runInChunks(statements) {
  for (let i = 0; i < statements.length; i += BATCH_SIZE) {
    await batch(statements.slice(i, i + BATCH_SIZE));
  }
}

// --- Expenses ---

export async function exportExpensesCsv() {
  const baseId = await getBaseScenarioId();
  const items = await query(`
    SELECT ei.*, ec.name AS category FROM expense_items ei
    JOIN expense_categories ec ON ec.id = ei.category_id
    WHERE ei.visible = 1 ORDER BY ec.sort_order, ei.name`);
  const values = await query(
    'SELECT expense_item_id, month, amount FROM expense_values WHERE scenario_id = ? ORDER BY month', [baseId]);
  const byItem = {};
  values.forEach(v => { (byItem[v.expense_item_id] ||= []).push(v); });

  const now = currentMonth();
  const rows = items.map(item => {
    const vals = byItem[item.id] || [];
    let amount = '';
    if (!item.formula && vals.length) {
      if (item.recurrence === 'one_time') {
        amount = centsToPlain(Math.max(...vals.map(v => v.amount)));
      } else {
        // The current month's value, else the latest one before it, else the first one
        const ref = vals.filter(v => v.month <= now).pop() || vals[0];
        amount = centsToPlain(chargeFromMonthly(ref.amount, item.recurrence));
      }
    }
    return {
      name: item.name, company: item.company, category: item.category, amount,
      recurrence: item.recurrence, renewal_day: item.renewal_day,
      start_month: item.start_month, end_month: item.end_month, notes: item.notes,
    };
  });
  return toCsv(EXPENSE_COLUMNS, rows);
}

export async function importExpensesCsv(text, dateRange) {
  const { rows, errors } = readRows(text, ['name', 'category', 'amount', 'recurrence', 'start_month']);
  if (errors.length) return { errors };

  const existing = await query('SELECT id, name, alias FROM expense_items');
  const existingByName = new Map(existing.map(e => [key(e.name), e]));

  const parsed = rows.map((r, i) => {
    const line = i + 2;
    const rowErrors = [];
    const name = r.name;
    if (!name) rowErrors.push('name is empty');

    const recurrence = RECURRENCE_ALIASES[(r.recurrence || 'monthly').toLowerCase().replace(/[\s-]+/g, '_')];
    if (!recurrence) rowErrors.push(`recurrence "${r.recurrence}" must be monthly, quarterly, annual or one_time`);

    let amount = null;
    if (r.amount !== '') {
      amount = parseAmountToCents(r.amount);
      if (Number.isNaN(amount) || amount < 0) rowErrors.push(`amount "${r.amount}" is not a valid number`);
    } else if (!existingByName.has(key(name || ''))) {
      rowErrors.push('amount is empty');
    }

    const startMonth = parseMonth(r.start_month);
    if (!startMonth) rowErrors.push(`start_month "${r.start_month}" must look like 2025-01`);
    let endMonth = null;
    if (r.end_month) {
      endMonth = parseMonth(r.end_month);
      if (!endMonth) rowErrors.push(`end_month "${r.end_month}" must look like 2025-12`);
      else if (startMonth && endMonth < startMonth) rowErrors.push('end_month is before start_month');
    }

    let renewalDay = null;
    if (r.renewal_day) {
      renewalDay = Number(r.renewal_day);
      if (!Number.isInteger(renewalDay) || renewalDay < 1 || renewalDay > 31) {
        rowErrors.push(`renewal_day "${r.renewal_day}" must be a whole number from 1 to 31`);
      }
    }

    rowErrors.forEach(e => errors.push(`Row ${line}: ${e}`));
    return {
      line, name, company: r.company || null, category: r.category || DEFAULT_CATEGORY,
      amount, recurrence, renewalDay, startMonth, endMonth, notes: r.notes || null,
    };
  });
  checkDuplicateNames(parsed.filter(p => p.name), errors);
  if (errors.length) return { errors };

  // Categories: match by name, create the missing ones at the end of the list
  let categories = await query('SELECT id, name, sort_order FROM expense_categories');
  const catKeys = new Set(categories.map(c => key(c.name)));
  let nextOrder = Math.max(0, ...categories.map(c => c.sort_order)) + 1;
  const newCats = [...new Map(parsed.filter(p => !catKeys.has(key(p.category)))
    .map(p => [key(p.category), p.category])).values()];
  if (newCats.length) {
    await batch(newCats.map(name => ({
      sql: 'INSERT INTO expense_categories (name, sort_order) VALUES (?, ?)', args: [name, nextOrder++],
    })));
    categories = await query('SELECT id, name FROM expense_categories');
  }
  const catId = new Map(categories.map(c => [key(c.name), c.id]));

  const usedAliases = new Set(existing.map(e => e.alias).filter(Boolean));
  const uniqueAlias = (name) => {
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'expense';
    let alias = base;
    for (let n = 2; usedAliases.has(alias); n++) alias = `${base}_${n}`;
    usedAliases.add(alias);
    return alias;
  };

  const baseId = await getBaseScenarioId();
  const horizon = forecastEnd(dateRange?.end);
  const valueStatements = [];
  let created = 0;
  let updated = 0;

  for (const p of parsed) {
    const fields = [p.name, p.company, catId.get(key(p.category)), p.recurrence, p.renewalDay, p.startMonth, p.endMonth, p.notes];
    const match = existingByName.get(key(p.name));
    let itemId;
    if (match) {
      await execute(`UPDATE expense_items SET name=?, company=?, category_id=?, recurrence=?, renewal_day=?,
        start_month=?, end_month=?, notes=? WHERE id=?`, [...fields, match.id]);
      itemId = match.id;
      updated++;
    } else {
      const res = await execute(`INSERT INTO expense_items (name, company, category_id, recurrence, renewal_day,
        start_month, end_month, notes, alias) VALUES (?,?,?,?,?,?,?,?,?)`, [...fields, uniqueAlias(p.name)]);
      itemId = res.lastInsertRowid;
      created++;
    }

    // A blank amount on an existing expense keeps its current monthly values
    if (p.amount === null) continue;
    if (match) {
      await execute('UPDATE expense_items SET formula = NULL WHERE id = ?', [itemId]);
      valueStatements.push({
        sql: 'DELETE FROM expense_values WHERE expense_item_id = ? AND scenario_id = ? AND is_actual = 0',
        args: [itemId, baseId],
      });
    }
    // Actuals already recorded for a month are kept
    for (const v of expenseMonthlyValues(p.amount, p.recurrence, p.startMonth, p.endMonth || horizon)) {
      valueStatements.push({
        sql: 'INSERT OR IGNORE INTO expense_values (expense_item_id, scenario_id, month, amount, is_actual) VALUES (?,?,?,?,0)',
        args: [itemId, baseId, v.month, v.amount],
      });
    }
  }
  await runInChunks(valueStatements);
  return { errors: [], created, updated };
}

// --- Payroll ---

export async function exportPayrollCsv() {
  const employees = await query('SELECT * FROM employees ORDER BY name');
  const rows = employees.map(e => ({
    name: e.name, role: e.role, department: e.department,
    monthly_salary: centsToPlain(e.salary_monthly), employer_tax_pct: e.tax_pct,
    start_month: (e.start_date || '').slice(0, 7), end_month: (e.end_date || '').slice(0, 7),
    notes: e.notes,
  }));
  return toCsv(PAYROLL_COLUMNS, rows);
}

export async function importPayrollCsv(text) {
  const { rows, errors } = readRows(text, ['name', 'monthly_salary', 'start_month']);
  if (errors.length) return { errors };

  const parsed = rows.map((r, i) => {
    const line = i + 2;
    const rowErrors = [];
    if (!r.name) rowErrors.push('name is empty');

    const salary = parseAmountToCents(r.monthly_salary);
    if (Number.isNaN(salary) || salary < 0) rowErrors.push(`monthly_salary "${r.monthly_salary}" is not a valid number`);

    let taxPct = 0;
    if (r.employer_tax_pct) {
      taxPct = parseAmountToCents(r.employer_tax_pct.replace('%', '')) / 100;
      if (Number.isNaN(taxPct) || taxPct < 0) rowErrors.push(`employer_tax_pct "${r.employer_tax_pct}" is not a valid number`);
    }

    const startMonth = parseMonth(r.start_month);
    if (!startMonth) rowErrors.push(`start_month "${r.start_month}" must look like 2025-01`);
    let endMonth = null;
    if (r.end_month) {
      endMonth = parseMonth(r.end_month);
      if (!endMonth) rowErrors.push(`end_month "${r.end_month}" must look like 2025-12`);
      else if (startMonth && endMonth < startMonth) rowErrors.push('end_month is before start_month');
    }

    rowErrors.forEach(e => errors.push(`Row ${line}: ${e}`));
    return {
      line, name: r.name, role: r.role || null, department: r.department || null,
      salary, taxPct, startMonth, endMonth, notes: r.notes || null,
    };
  });
  checkDuplicateNames(parsed.filter(p => p.name), errors);
  if (errors.length) return { errors };

  const existing = await query('SELECT id, name FROM employees');
  const existingByName = new Map(existing.map(e => [key(e.name), e]));
  let created = 0;
  let updated = 0;
  const statements = parsed.map(p => {
    const fields = [p.name, p.role, p.department, p.salary, p.taxPct, p.startMonth, p.endMonth, p.notes];
    const match = existingByName.get(key(p.name));
    if (match) {
      updated++;
      return {
        sql: `UPDATE employees SET name=?, role=?, department=?, salary_monthly=?, tax_pct=?,
          start_date=?, end_date=?, notes=? WHERE id=?`,
        args: [...fields, match.id],
      };
    }
    created++;
    return {
      sql: `INSERT INTO employees (name, role, department, salary_monthly, tax_pct, start_date, end_date, notes)
        VALUES (?,?,?,?,?,?,?,?)`,
      args: fields,
    };
  });
  await runInChunks(statements);
  return { errors: [], created, updated };
}
