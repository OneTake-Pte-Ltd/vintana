// Bank statements: read a PDF with Claude (through the relay), prepare it for review, save what the person
// confirms, then check the result for discrepancies.
//
// Two views of the same money are kept apart:
// - Cash actuals: every statement line, on the date it hit the bank (bank_transactions). Cash Flow uses these.
// - Run rate: monthly values of each expense (expense_values). A charge from a statement replaces the monthly
//   values of the months it covers (1 for monthly, 3 for quarterly, 12 for annual), marked as actual.
// The PDF itself is never stored: the browser reads it, sends it once, and drops it.

import { query, execute, batch, getCredentials } from './db.js';
import { getBaseScenarioId } from './schema.js';
import {
  getReportingCurrency, addMonths, currentMonth, generateMonthRange, prevMonth, RECURRENCE_MONTHS, formatCents, monthLabelFull, isChargeMonth,
} from './utils.js';
import { loadScenarioEmployees, employeeCost, isEmployedIn } from './payroll.js';
import { loadAccounts, getRate, convert, monthEnd, accountLabel } from './bank.js';
import { streamChat, AssistantError, DEFAULT_MODEL, DEFAULT_RELAY_URL } from './assistant.js';

export const MAX_PDF_BYTES = 24 * 1024 * 1024; // base64 adds a third; the request limit is 32 MB

export const KIND_OPTIONS = [
  { value: 'expense', label: 'Expense' },
  { value: 'salary', label: 'Salary' },
  { value: 'revenue', label: 'Revenue received' },
  { value: 'funding', label: 'Funding (investor)' },
  { value: 'refund', label: 'Supplier refund' },
  { value: 'interest', label: 'Interest' },
  { value: 'tax_refund', label: 'Tax refund (IRAS)' },
  { value: 'other_income', label: 'Other income' },
  { value: 'transfer', label: 'Transfer between own accounts' },
  { value: 'ignore', label: 'Ignore this line' },
];
export const kindLabel = k => KIND_OPTIONS.find(o => o.value === k)?.label || k;

const toCents = n => Math.round(Number(n) * 100);
const baseScenarioId = getBaseScenarioId;

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(new Error('The file could not be read.'));
    reader.readAsDataURL(file);
  });
}

// What Claude needs to match lines to Vintana's own records
export async function buildContext() {
  const baseId = await baseScenarioId();
  const [accounts, providers, categories, emp, planned] = await Promise.all([
    loadAccounts(),
    query(`SELECT ei.id, ei.name, ei.company, ei.charge_label, ei.recurrence, ec.name AS category
           FROM expense_items ei JOIN expense_categories ec ON ec.id = ei.category_id WHERE ei.visible = 1`),
    query('SELECT name FROM expense_categories ORDER BY sort_order'),
    loadScenarioEmployees(baseId),
    query('SELECT id, name, month, amount FROM funding_events WHERE scenario_id = ? AND is_actual = 0', [baseId]).catch(() => []),
  ]);
  return {
    reporting_currency: getReportingCurrency(),
    accounts: accounts.map(a => ({ id: a.id, bank_name: a.bank_name, label: a.label, currency: a.currency })),
    providers,
    categories: categories.map(c => c.name),
    employees: emp.employees.filter(e => e._source !== 'scenario').map(e => ({ id: e.id, name: e.name, role: e.role })),
    planned_funding: planned.map(f => ({ id: f.id, investor: f.name, month: f.month, amount: f.amount / 100 })),
  };
}

// Sends one PDF to the relay and returns the parsed statement. The file contents are dropped when this returns.
export async function readStatement(file, settings, context, signal) {
  if (file.size > MAX_PDF_BYTES) throw new Error(`This PDF is ${(file.size / 1048576).toFixed(1)} MB; the limit is 24 MB. Split it into smaller statements.`);
  let pdf = await fileToBase64(file);
  if (!pdf.startsWith('JVBER')) throw new Error('This file is not a PDF.');
  let result;
  try {
    result = await streamChat({
      relayUrl: settings?.assistant_relay_url || DEFAULT_RELAY_URL,
      token: getCredentials().token,
      path: '/v1/statement',
      body: { model: settings?.assistant_model || DEFAULT_MODEL, pdf, context, file_name: file.name },
      signal,
    });
  } finally {
    pdf = null; // nothing keeps the PDF after this point
  }
  if (result.stopReason === 'refusal') throw new AssistantError('REFUSED', 'Claude declined to read this statement.');
  if (result.stopReason === 'max_tokens') throw new AssistantError('TOO_LONG', 'This statement has too many lines to read in one go. Split it into shorter periods.');
  try {
    return JSON.parse(result.text);
  } catch {
    throw new AssistantError('BAD_OUTPUT', 'The statement could not be read into a usable format. Try again.');
  }
}

// Turns Claude's reading into a review: one row per line, with the decision pre-filled from Claude's matches
export async function prepareReview(parsed, fileName) {
  const accounts = await loadAccounts();
  const account = accounts.find(a => a.id === parsed.matched_account_id)
    || accounts.find(a => a.currency === parsed.currency && a.bank_name.toLowerCase().includes((parsed.bank_name || '').toLowerCase().split(' ')[0]))
    || null;
  const providers = await query('SELECT id, name, company, category_id FROM expense_items WHERE visible = 1');
  const categories = await query('SELECT id, name FROM expense_categories ORDER BY sort_order');
  const catId = name => categories.find(c => c.name.toLowerCase() === (name || '').toLowerCase())?.id
    || categories.find(c => c.name.startsWith('Uncategorized'))?.id || categories[0]?.id;
  const known = id => providers.some(p => p.id === id);

  const rows = (parsed.transactions || []).map((t, i) => {
    const amount = toCents(t.amount);
    const row = {
      key: i, date: t.date, month: (t.date || '').slice(0, 7), description: t.description, counterparty: t.counterparty,
      amount, kind: t.kind, confidence: t.confidence, note: t.note,
      expense_item_id: known(t.expense_item_id) ? t.expense_item_id : null,
      employee_id: t.employee_id ?? null,
      investor_name: t.investor_name || null,
      funding_event_id: t.funding_event_id ?? null,
      // For an expense with no provider yet: add a new one (pre-filled), or pick an existing one
      newProvider: null, saveLabel: false,
    };
    // A suggested "new" provider that already exists by name is that provider: link it instead of duplicating it
    const same = t.suggested_provider && providers.find(p => p.name.trim().toLowerCase() === t.suggested_provider.name.trim().toLowerCase());
    if (row.kind === 'expense' && !row.expense_item_id && same) { row.expense_item_id = same.id; row.saveLabel = true; }
    if (row.kind === 'expense' && !row.expense_item_id) {
      const sp = t.suggested_provider;
      row.newProvider = {
        name: sp?.name || t.counterparty || t.description, company: sp?.company || t.counterparty || '',
        category_id: catId(sp?.category), recurrence: 'monthly',
      };
    }
    row.flagged = needsDecision(row) || !!same || t.confidence === 'low'; // stays in "To check" after it's decided, so it doesn't vanish mid-review
    return row;
  });

  return {
    fileName, parsed, accountId: account?.id ?? null,
    currency: parsed.currency, periodStart: parsed.period_start, periodEnd: parsed.period_end,
    opening: toCents(parsed.opening_balance), closing: toCents(parsed.closing_balance),
    monthEnds: (parsed.month_end_balances || []).map(b => ({ month: b.month, balance: toCents(b.balance) })),
    warnings: parsed.warnings || [], rows,
  };
}

// A row needs a decision when Claude wasn't sure or couldn't link it
export function needsDecision(row) {
  if (row.kind === 'ignore' || row.kind === 'transfer') return false;
  if (row.confidence === 'low') return true;
  if (row.kind === 'expense') return !row.expense_item_id;
  if (row.kind === 'salary') return !row.employee_id;
  if (row.kind === 'funding') return !row.investor_name && !row.funding_event_id;
  return false;
}

// Imports of the same account whose period overlaps this one
export async function findOverlaps(accountId, periodStart, periodEnd) {
  if (!accountId) return [];
  return query(`SELECT * FROM statement_imports WHERE account_id = ? AND period_start <= ? AND period_end >= ?`,
    [accountId, periodEnd, periodStart]);
}

// Undoes an import: its lines, the balances it recorded and the funding events it created.
// Monthly run-rate values it wrote stay as they are (they were the best known values); they are recomputed
// from the remaining lines when another statement covers those months.
export async function deleteImport(importId) {
  const created = await query(`SELECT DISTINCT bt.funding_event_id AS id, fe.notes FROM bank_transactions bt
    JOIN funding_events fe ON fe.id = bt.funding_event_id WHERE bt.import_id = ?`, [importId]);
  const stmts = [];
  for (const f of created) {
    if ((f.notes || '').startsWith('From bank statement')) stmts.push({ sql: 'DELETE FROM funding_events WHERE id = ?', args: [f.id] });
    else {
      // A planned event marked as received: restore its planned month and amount
      const m = (f.notes || '').match(/\s*\[planned:(\d{4}-\d{2}):(-?\d+)\]$/);
      stmts.push(m
        ? { sql: 'UPDATE funding_events SET is_actual = 0, month = ?, amount = ?, notes = ? WHERE id = ?', args: [m[1], Number(m[2]), (f.notes || '').slice(0, m.index) || null, f.id] }
        : { sql: 'UPDATE funding_events SET is_actual = 0 WHERE id = ?', args: [f.id] });
    }
  }
  stmts.push({ sql: 'DELETE FROM bank_transactions WHERE import_id = ?', args: [importId] });
  stmts.push({ sql: "DELETE FROM bank_balances WHERE import_id = ? AND source = 'statement'", args: [importId] });
  stmts.push({ sql: 'DELETE FROM statement_imports WHERE id = ?', args: [importId] });
  await batch(stmts);
}

const uniqueAlias = async (name) => {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'expense';
  const used = new Set((await query('SELECT alias FROM expense_items WHERE alias IS NOT NULL')).map(r => r.alias));
  let alias = base;
  for (let n = 2; used.has(alias); n++) alias = `${base}_${n}`;
  return alias;
};

// Saves a reviewed statement. Returns the import id.
export async function saveReview(review, { replaceImportIds = [] } = {}) {
  const accounts = await loadAccounts();
  const account = accounts.find(a => a.id === review.accountId);
  if (!account) throw new Error('Choose the bank account this statement belongs to.');
  if (review.currency && account.currency !== review.currency) {
    throw new Error(`This statement is in ${review.currency} but ${accountLabel(account)} is in ${account.currency}. Choose the right account, or change the account's currency in Settings.`);
  }
  const reporting = getReportingCurrency();
  const months = [...new Set([...review.rows.map(r => r.month), ...review.monthEnds.map(b => b.month)])].filter(Boolean);
  const rates = {};
  const found = await Promise.all(months.map(m => getRate(m, account.currency, reporting)));
  months.forEach((m, i) => { rates[m] = found[i]; });
  const baseId = await baseScenarioId();

  for (const id of replaceImportIds) await deleteImport(id);

  // Notes Claude made while reading (unreadable parts and the like) are kept with the import's discrepancies
  const readingNotes = review.warnings.map(w => ({ severity: 'warning', title: 'Note from reading the statement', detail: w, fromReading: true }));
  const res = await execute(`INSERT INTO statement_imports (account_id, file_name, period_start, period_end, currency,
    opening_balance, closing_balance, transaction_count, discrepancies) VALUES (?,?,?,?,?,?,?,?,?)`,
    [account.id, review.fileName, review.periodStart, review.periodEnd, account.currency, review.opening, review.closing,
     review.rows.length, JSON.stringify(readingNotes)]);
  const importId = res.lastInsertRowid;

  // New providers (one per distinct name, so two lines from the same new supplier share it)
  const newIds = {};
  for (const r of review.rows) {
    if (r.kind !== 'expense' || r.expense_item_id || !r.newProvider) continue;
    const key = r.newProvider.name.trim().toLowerCase();
    if (!newIds[key]) {
      const ins = await execute(`INSERT INTO expense_items (name, alias, company, charge_label, category_id, recurrence, renewal_day, start_month, notes)
        VALUES (?,?,?,?,?,?,?,?,?)`,
        [r.newProvider.name.trim(), await uniqueAlias(r.newProvider.name), r.newProvider.company || null, r.description,
         r.newProvider.category_id, r.newProvider.recurrence || 'monthly', Number(r.date.slice(8, 10)) || null, r.month,
         `Added from bank statement ${review.fileName}`]);
      newIds[key] = ins.lastInsertRowid;
    }
    r.expense_item_id = newIds[key];
  }
  // Existing providers picked by hand: keep the bank's wording so the next statement matches on its own
  for (const r of review.rows) {
    if (r.saveLabel && r.expense_item_id) {
      await execute('UPDATE expense_items SET charge_label = ? WHERE id = ?', [r.description, r.expense_item_id]);
    }
  }

  // Funding: mark a planned event as received, or record a new one. Actual events apply to every scenario.
  for (const r of review.rows) {
    if (r.kind !== 'funding') continue;
    const amount = convert(r.amount, rates[r.month]);
    if (r.funding_event_id) {
      // Remember the plan, so deleting this import puts it back
      const before = (await query('SELECT month, amount, notes FROM funding_events WHERE id = ?', [r.funding_event_id]))[0];
      const notes = `${before?.notes || ''} [planned:${before?.month}:${before?.amount}]`.trim();
      await execute('UPDATE funding_events SET is_actual = 1, month = ?, amount = ?, notes = ? WHERE id = ?', [r.month, amount, notes, r.funding_event_id]);
    } else {
      const name = r.investor_name ? `SAFE: ${r.investor_name}` : (r.counterparty || 'Funding');
      const ins = await execute('INSERT INTO funding_events (name, month, amount, scenario_id, notes, is_actual) VALUES (?,?,?,?,?,1)',
        [name, r.month, amount, baseId, `From bank statement ${review.fileName}`]);
      r.funding_event_id = ins.lastInsertRowid;
    }
  }

  // Every line is kept, ignored ones too (kind 'ignore'), so the statement still adds up; reports skip them
  const stmts = review.rows.map(r => ({
    sql: `INSERT INTO bank_transactions (import_id, account_id, date, month, description, counterparty, amount, amount_reporting,
          kind, expense_item_id, employee_id, funding_event_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [importId, account.id, r.date, r.month, r.description, r.counterparty, r.amount, convert(r.amount, rates[r.month]),
      r.kind, ['expense', 'refund'].includes(r.kind) ? r.expense_item_id : null,
      r.kind === 'salary' ? r.employee_id : null, r.kind === 'funding' ? r.funding_event_id : null],
  }));
  // A statement that starts on the 1st also tells us the previous month's closing balance; record it unless one is known
  if (review.periodStart?.endsWith('-01')) {
    stmts.push({ sql: `INSERT OR IGNORE INTO bank_balances (account_id, month, balance, source, import_id) VALUES (?,?,?,'statement',?)`,
      args: [account.id, prevMonth(review.periodStart.slice(0, 7)), review.opening, importId] });
  }
  for (const b of review.monthEnds) {
    stmts.push({ sql: `INSERT OR REPLACE INTO bank_balances (account_id, month, balance, source, import_id) VALUES (?,?,?,'statement',?)`,
      args: [account.id, b.month, b.balance, importId] });
  }
  for (let i = 0; i < stmts.length; i += 200) await batch(stmts.slice(i, i + 200));

  const itemIds = [...new Set(review.rows.filter(r => ['expense', 'refund'].includes(r.kind) && r.expense_item_id).map(r => r.expense_item_id))];
  await recomputeRunRate(itemIds, months, baseId);
  return importId;
}

// Run-rate values from statements: the month's charges for an expense, spread over the months they cover.
// Written to the base scenario as actuals; other scenarios' values for those months are removed so the actual shows.
export async function recomputeRunRate(itemIds, months, baseId) {
  if (!itemIds.length || !months.length) return;
  const items = await query(`SELECT id, recurrence FROM expense_items WHERE id IN (${itemIds.map(() => '?').join(',')})`, itemIds);
  const sums = await query(`SELECT expense_item_id AS id, month, -SUM(amount_reporting) AS total FROM bank_transactions
    WHERE expense_item_id IN (${itemIds.map(() => '?').join(',')}) AND month IN (${months.map(() => '?').join(',')})
      AND kind IN ('expense', 'refund')
    GROUP BY expense_item_id, month`, [...itemIds, ...months]);
  const stmts = [];
  for (const s of sums) {
    const item = items.find(i => i.id === s.id);
    const span = item?.recurrence === 'one_time' ? 1 : (RECURRENCE_MONTHS[item?.recurrence] || 1);
    const share = Math.round(s.total / span);
    for (let k = 0; k < span; k++) {
      const m = addMonths(s.month, k);
      stmts.push({ sql: 'INSERT OR REPLACE INTO expense_values (expense_item_id, scenario_id, month, amount, is_actual) VALUES (?,?,?,?,1)', args: [s.id, baseId, m, share] });
      stmts.push({ sql: 'DELETE FROM expense_values WHERE expense_item_id = ? AND month = ? AND scenario_id != ?', args: [s.id, m, baseId] });
    }
  }
  for (let i = 0; i < stmts.length; i += 200) await batch(stmts.slice(i, i + 200));
}

// --- Discrepancies --------------------------------------------------------------------------------------------
// Each: { severity: 'warning'|'info', title, detail, fix?: { label, action, args } }

const fullMonthsIn = (start, end) => generateMonthRange(start.slice(0, 7), end.slice(0, 7))
  .filter(m => start <= `${m}-01` && end >= monthEnd(m));

export async function findDiscrepancies(importId, settings) {
  const imp = (await query('SELECT * FROM statement_imports WHERE id = ?', [importId]))[0];
  if (!imp) return [];
  const accounts = await loadAccounts();
  const account = accounts.find(a => a.id === imp.account_id);
  const cur = account?.currency;
  const money = c => formatCents(c, cur);
  const out = [];
  const lines = await query('SELECT * FROM bank_transactions WHERE import_id = ?', [importId]);

  // 1. Lines don't add up
  const sum = lines.reduce((s, l) => s + l.amount, 0);
  const gap = imp.opening_balance + sum - imp.closing_balance;
  if (Math.abs(gap) > 1) {
    out.push({ severity: 'warning', title: 'The lines don\'t add up to the closing balance',
      detail: `Opening ${money(imp.opening_balance)} plus the lines read (${money(sum)}) gives ${money(imp.opening_balance + sum)}, but the statement closes at ${money(imp.closing_balance)}: a gap of ${money(gap)}. A line may have been misread or left out. Compare with the PDF, then delete this import and read it again.` });
  }

  // 2. Opening balance vs the previous month's recorded closing balance
  const prev = prevMonth(imp.period_start.slice(0, 7));
  const startsOnFirst = imp.period_start.endsWith('-01');
  const prevBal = (await query('SELECT balance, source FROM bank_balances WHERE account_id = ? AND month = ?', [imp.account_id, prev]))[0];
  if (startsOnFirst && prevBal && Math.abs(prevBal.balance - imp.opening_balance) > 1) {
    out.push({ severity: 'warning', title: `Opening balance differs from the end of ${monthLabelFull(prev)}`,
      detail: `This statement opens at ${money(imp.opening_balance)}, but ${monthLabelFull(prev)} ended at ${money(prevBal.balance)}${prevBal.source === 'manual' ? ' (entered by hand)' : ''}. If the earlier figure was typed in, correct it; otherwise a statement may be missing or misread.`,
      fix: { label: `Set end of ${monthLabelFull(prev)} to ${money(imp.opening_balance)}`, action: 'set_balance', args: { accountId: imp.account_id, month: prev, balance: imp.opening_balance } } });
  }

  // 3. Months with no statement for this account, between the first one imported and this one
  const all = await query('SELECT period_start, period_end FROM statement_imports WHERE account_id = ? ORDER BY period_start', [imp.account_id]);
  const covered = new Set(all.flatMap(i => generateMonthRange(i.period_start.slice(0, 7), i.period_end.slice(0, 7))));
  const first = all[0]?.period_start.slice(0, 7);
  const last = all[all.length - 1]?.period_end.slice(0, 7);
  const gaps = first ? generateMonthRange(first, last).filter(m => !covered.has(m)) : [];
  if (gaps.length) {
    out.push({ severity: 'info', title: `No statement yet for ${gaps.map(monthLabelFull).join(', ')}`,
      detail: `${accountLabel(account)} has statements before and after ${gaps.length > 1 ? 'these months' : 'this month'}. Import ${gaps.length > 1 ? 'them' : 'it'} so cash flow and actuals are complete.` });
  }

  const fullMonths = fullMonthsIn(imp.period_start, imp.period_end);
  const baseId = await baseScenarioId();

  // 4. Charges: expected but not seen, different from the forecast, or charged twice
  const items = await query('SELECT * FROM expense_items WHERE visible = 1');
  const seen = await query(`SELECT expense_item_id AS id, month, COUNT(*) AS n, -SUM(amount_reporting) AS total,
      MIN(amount) AS min_a, MAX(amount) AS max_a
    FROM bank_transactions WHERE kind = 'expense' AND expense_item_id IS NOT NULL GROUP BY expense_item_id, month`);
  const seenMap = new Map(seen.map(s => [`${s.id}:${s.month}`, s]));
  const forecastAfter = async (itemId, month) => (await query(`SELECT month, amount FROM expense_values WHERE expense_item_id = ? AND scenario_id = ?
      AND is_actual = 0 AND month > ? ORDER BY month LIMIT 1`, [itemId, baseId, month]))[0];
  const rmoney = c => formatCents(c);

  for (const m of fullMonths) {
    for (const it of items) {
      const active = (!it.start_month || it.start_month <= m) && (!it.end_month || it.end_month >= m);
      if (!active || it.formula) continue;
      const due = it.recurrence === 'one_time' ? it.start_month === m
        : it.recurrence === 'monthly' ? true : (it.start_month && isChargeMonth(it.recurrence, it.start_month, m));
      const s = seenMap.get(`${it.id}:${m}`);
      if (due && !s) {
        // Only when the charge was due in a month this statement fully covers, and no imported account shows it
        out.push({ severity: 'info', title: `${it.name} not charged in ${monthLabelFull(m)}`,
          detail: `It was expected in ${monthLabelFull(m)} but appears in no imported statement. If it's paid from an account you haven't imported yet, import that statement. If it has ended, set an end month.`,
          fix: { label: `End ${it.name} in ${monthLabelFull(prevMonth(m))}`, action: 'end_expense', args: { itemId: it.id, month: prevMonth(m) } } });
      }
      if (!s) continue;
      if (it.recurrence === 'monthly' && s.n > 1 && s.min_a === s.max_a) {
        out.push({ severity: 'warning', title: `${it.name} charged ${s.n} times in ${monthLabelFull(m)}`,
          detail: `${s.n} identical charges of ${money(-s.max_a)}. Check with the supplier for double billing.` });
      }
      const next = await forecastAfter(it.id, m);
      if (next) {
        const span = it.recurrence === 'one_time' ? 1 : (RECURRENCE_MONTHS[it.recurrence] || 1);
        const expected = next.amount * span;
        const diff = s.total - expected;
        if (expected > 0 && Math.abs(diff) > Math.max(100, expected * 0.05)) {
          const pct = Math.round((diff / expected) * 100);
          const newMonthly = Math.round(s.total / span);
          out.push({ severity: 'info', title: `${it.name} cost ${rmoney(s.total)} in ${monthLabelFull(m)}, ${pct > 0 ? '+' : ''}${pct}% vs forecast`,
            detail: `The forecast expects ${rmoney(expected)} per charge. If the new price will last, update the forecast from ${monthLabelFull(next.month)} onwards.`,
            fix: { label: `Use ${rmoney(newMonthly)} a month from ${monthLabelFull(next.month)}`, action: 'update_forecast', args: { itemId: it.id, from: next.month, amount: newMonthly } } });
        }
      }
    }
  }

  // 5. Salaries: different from Payroll, or not paid
  const emp = (await loadScenarioEmployees(baseId)).employees.filter(e => e._source !== 'scenario');
  const paid = await query(`SELECT employee_id AS id, month, -SUM(amount_reporting) AS total FROM bank_transactions
    WHERE kind = 'salary' AND employee_id IS NOT NULL GROUP BY employee_id, month`);
  for (const m of fullMonths) {
    for (const e of emp) {
      if (!isEmployedIn(e, m)) continue;
      const p = paid.find(x => x.id === e.id && x.month === m);
      const expected = employeeCost(e);
      if (!p) {
        if (lines.some(l => l.month === m)) {
          out.push({ severity: 'info', title: `No salary payment to ${e.name} in ${monthLabelFull(m)}`,
            detail: `Payroll expects ${rmoney(expected)}. If ${e.name} is paid from another account, import that statement. If ${e.name} has left, set an end date on the Payroll page.` });
        }
        continue;
      }
      if (Math.abs(p.total - expected) > Math.max(100, expected * 0.01)) {
        const fix = (e.tax_pct || 0) === 0
          ? { label: `Set ${e.name}'s monthly salary to ${rmoney(p.total)}`, action: 'update_salary', args: { employeeId: e.id, salary: p.total } }
          : undefined;
        out.push({ severity: 'info', title: `${e.name} was paid ${rmoney(p.total)} in ${monthLabelFull(m)}`,
          detail: `Payroll expects ${rmoney(expected)}. The payment is recorded as the actual for ${monthLabelFull(m)}. If the change is lasting (a raise, a new rate), update the salary${fix ? '' : ' on the Payroll page'}; if it's a one-off (bonus, partial month), nothing to do.`,
          fix });
      }
    }
  }

  // 6. Actuals Through is behind the months every account now covers
  if (fullMonths.length) {
    const latestFull = fullMonths[fullMonths.length - 1];
    const allCovered = await Promise.all(accounts.map(async a => {
      const imps = await query('SELECT period_start, period_end FROM statement_imports WHERE account_id = ?', [a.id]);
      return imps.some(i => fullMonthsIn(i.period_start, i.period_end).includes(latestFull));
    }));
    const at = settings?.actuals_through;
    if (allCovered.every(Boolean) && (!at || at < latestFull) && latestFull < currentMonth()) {
      out.push({ severity: 'info', title: `Every account now has a statement for ${monthLabelFull(latestFull)}`,
        detail: `"Actuals through" is ${at ? monthLabelFull(at) : 'not set'}. Move it to ${monthLabelFull(latestFull)} so reports treat that month as actual.`,
        fix: { label: `Set actuals through ${monthLabelFull(latestFull)}`, action: 'set_actuals_through', args: { month: latestFull } } });
    } else if (!allCovered.every(Boolean) && accounts.length > 1) {
      const missing = accounts.filter((a, i) => !allCovered[i]).map(accountLabel);
      out.push({ severity: 'info', title: `Total cash for ${monthLabelFull(latestFull)} is incomplete`,
        detail: `No statement covers ${monthLabelFull(latestFull)} yet for ${missing.join(', ')}. Import ${missing.length > 1 ? 'them' : 'it'} to complete cash and actuals for that month.` });
    }
  }

  for (const w of JSON.parse(imp.discrepancies || '[]').filter(d => d.fromReading)) out.push(w);
  await execute('UPDATE statement_imports SET discrepancies = ? WHERE id = ?', [JSON.stringify(out), importId]);
  return out;
}

// Applies a suggested fix. Returns a short confirmation.
export async function applyFix(fix) {
  const a = fix.args;
  switch (fix.action) {
    case 'set_balance':
      await execute(`INSERT OR REPLACE INTO bank_balances (account_id, month, balance, source) VALUES (?,?,?,'manual')`, [a.accountId, a.month, a.balance]);
      return 'Balance updated';
    case 'end_expense':
      await execute('UPDATE expense_items SET end_month = ? WHERE id = ?', [a.month, a.itemId]);
      return 'End month set';
    case 'update_forecast': {
      const baseId = await baseScenarioId();
      await execute('UPDATE expense_values SET amount = ? WHERE expense_item_id = ? AND scenario_id = ? AND is_actual = 0 AND month >= ?', [a.amount, a.itemId, baseId, a.from]);
      return 'Forecast updated';
    }
    case 'update_salary':
      await execute('UPDATE employees SET salary_monthly = ? WHERE id = ?', [a.salary, a.employeeId]);
      return 'Salary updated';
    case 'set_actuals_through':
      await execute('UPDATE settings SET actuals_through = ? WHERE id = 1', [a.month]);
      return 'Actuals through updated';
    default:
      throw new Error('Unknown fix');
  }
}
