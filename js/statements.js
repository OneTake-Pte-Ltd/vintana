// Bank statements: read a PDF with the assistant's model (through the relay), prepare it for review, save what the person
// confirms, then check the result for discrepancies.
//
// Two views of the same money are kept apart:
// - Cash actuals: every statement line, on the date it hit the bank (bank_transactions). Cash Flow uses these.
// - Run rate: monthly values of each expense (expense_values). A charge from a statement replaces the monthly
//   values of the months it covers (1 for monthly, 3 for quarterly, 12 for annual), marked as actual.
// The PDF itself is never stored: the browser reads it, sends it once, and drops it. Claude reads the PDF itself;
// for an OpenAI-compatible model the browser first turns it into text (and images of scanned pages), see pdfText.js.

import { query, execute, batch, getCredentials } from './db.js';
import { getBaseScenarioId } from './schema.js';
import {
  getReportingCurrency, addMonths, currentMonth, generateMonthRange, prevMonth, RECURRENCE_MONTHS, formatCents, monthLabelFull, isChargeMonth, ordinalDay,
  weeklyAnchor, weeklyChargeDatesIn, chargeFromMonthly, monthlyShare,
} from './utils.js';
import { loadScenarioEmployees, employeeCost, isEmployedIn } from './payroll.js';
import { respreadExpense } from './expenses.js';
import { loadAccounts, getRate, convert, monthEnd, accountLabel } from './bank.js';
import { streamChat, AssistantError, assistantChoice, DEFAULT_RELAY_URL } from './assistant.js';
import { pdfToMarkdown } from './pdfText.js';

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

// What the model needs to match lines to Vintana's own records
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
    employees: emp.employees.filter(e => e._source !== 'scenario')
      .map(e => ({ id: e.id, name: e.name, role: e.role, charge_label: e.charge_label || null })),
    planned_funding: planned.map(f => ({ id: f.id, investor: f.name, month: f.month, amount: f.amount / 100 })),
  };
}

// Sends one statement to the relay and returns the parsed statement, with read_by set to the model that read it.
// The file contents are dropped when this returns.
// `onProgress({ phase, lines })` reports how far reading has got: 'preparing' (turning the PDF into text), 'sending',
// then 'reading' with the number of transactions read so far.
export async function readStatement(file, settings, context, signal, onProgress = () => {}) {
  if (file.size > MAX_PDF_BYTES) throw new Error(`This PDF is ${(file.size / 1048576).toFixed(1)} MB; the limit is 24 MB. Split it into smaller statements.`);
  const { provider, model } = assistantChoice(settings);
  if (!model) throw new AssistantError('MODEL_NOT_ALLOWED', 'No model is chosen for the assistant. Pick one in Settings > Assistant.');
  let body;
  if (provider === 'openai') {
    if (!(await isPdf(file))) throw new Error('This file is not a PDF.');
    onProgress({ phase: 'preparing', lines: 0 });
    const { markdown, pages } = await pdfToMarkdown(file);
    body = { provider, model, markdown, pages, context, file_name: file.name };
  } else {
    const pdf = await fileToBase64(file);
    if (!pdf.startsWith('JVBER')) throw new Error('This file is not a PDF.');
    body = { provider, model, pdf, context, file_name: file.name };
  }
  let result;
  onProgress({ phase: 'sending', lines: 0 });
  // Count transactions as the model writes them: each one has a "date" key. Only the new text is scanned.
  let lines = 0, scanned = 0;
  const onText = text => {
    const from = Math.max(0, scanned - 8);
    const added = (text.slice(from).match(/"date"\s*:/g) || []).length
      - (text.slice(from, scanned).match(/"date"\s*:/g) || []).length;
    scanned = text.length;
    lines += added;
    onProgress({ phase: 'reading', lines });
  };
  try {
    result = await streamChat({
      onText,
      relayUrl: settings?.assistant_relay_url || DEFAULT_RELAY_URL,
      token: getCredentials().token,
      path: '/v1/statement',
      body,
      signal,
    });
  } finally {
    body = null; // nothing keeps the statement after this point
  }
  if (result.stopReason === 'refusal') throw new AssistantError('REFUSED', 'The model declined to read this statement.');
  if (result.stopReason === 'max_tokens') throw new AssistantError('TOO_LONG', 'This statement has too many lines to read in one go. Split it into shorter periods.');
  let parsed;
  try {
    // Some models wrap JSON in a code fence even when asked not to
    parsed = JSON.parse(result.text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
  } catch {
    throw new AssistantError('BAD_OUTPUT', 'The statement could not be read into a usable format. Try again, or pick another model in Settings > Assistant.');
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.transactions)) {
    throw new AssistantError('BAD_OUTPUT', 'The model\'s reading of this statement is incomplete. Try again, or pick another model in Settings > Assistant.');
  }
  parsed.read_by = result.servedBy || model;
  return parsed;
}

async function isPdf(file) {
  const head = new Uint8Array(await file.slice(0, 5).arrayBuffer());
  return String.fromCharCode(...head) === '%PDF-';
}

// Turns the model's reading into a review: one row per line, with the decision pre-filled from its matches
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
  const RECURRENCES = ['weekly', 'monthly', 'quarterly', 'annual', 'one_time'];

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
      const name = sp?.name || t.counterparty || t.description;
      row.newProvider = {
        name, company: distinctCompany(name, sp?.company ?? t.counterparty),
        category_id: catId(sp?.category), subcategory_id: null,
        // Unknown recurrence: a one-off is the safer guess (hotels, travel, meals)
        recurrence: RECURRENCES.includes(sp?.recurrence) ? sp.recurrence : 'one_time',
      };
    }
    row.flagged = needsDecision(row) || !!same || t.confidence === 'low'; // stays in "To check" after it's decided, so it doesn't vanish mid-review
    return row;
  });

  return {
    fileName, parsed, readBy: parsed.read_by || null, accountId: account?.id ?? null,
    currency: parsed.currency, periodStart: parsed.period_start, periodEnd: parsed.period_end,
    opening: toCents(parsed.opening_balance), closing: toCents(parsed.closing_balance),
    monthEnds: (parsed.month_end_balances || []).map(b => ({ month: b.month, balance: toCents(b.balance) })),
    warnings: parsed.warnings || [], rows,
  };
}

// The company of a new provider, unless it only repeats the provider's name
export function distinctCompany(name, company) {
  const c = (company || '').trim();
  return c && c.toLowerCase() !== (name || '').trim().toLowerCase() ? c : '';
}

// A row needs a decision when the model wasn't sure or couldn't link it
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

  // Notes the model made while reading (unreadable parts and the like) are kept with the import's discrepancies
  const readingNotes = review.warnings.map(w => ({ type: 'mismatch', severity: 'warning', title: 'Note from reading the statement', detail: w, fromReading: true }));
  const res = await execute(`INSERT INTO statement_imports (account_id, file_name, period_start, period_end, currency,
    opening_balance, closing_balance, transaction_count, discrepancies, read_by) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [account.id, review.fileName, review.periodStart, review.periodEnd, account.currency, review.opening, review.closing,
     review.rows.length, JSON.stringify(readingNotes), review.readBy]);
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
         r.newProvider.category_id, r.newProvider.recurrence || 'one_time', Number(r.date.slice(8, 10)) || null, r.month,
         `Added from bank statement ${review.fileName}`]);
      newIds[key] = ins.lastInsertRowid;
      if (r.newProvider.subcategory_id) {
        await execute('UPDATE expense_items SET subcategory_id = ? WHERE id = ?', [r.newProvider.subcategory_id, newIds[key]]);
      }
    }
    r.expense_item_id = newIds[key];
  }
  // Providers and people picked by hand: keep the bank's wording so the next statement matches on its own
  for (const r of review.rows) {
    if (!r.saveLabel) continue;
    if (['expense', 'refund'].includes(r.kind) && r.expense_item_id) {
      await execute('UPDATE expense_items SET charge_label = ? WHERE id = ?', [r.description, r.expense_item_id]);
    } else if (r.kind === 'salary' && r.employee_id) {
      await execute('UPDATE employees SET charge_label = ? WHERE id = ?', [r.description, r.employee_id]);
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
// Each: { type, severity: 'warning'|'info', title, detail, fixes?: [{ label, action, args }] }
// type: 'mismatch' (the bank and Vintana disagree), 'missing' (something expected was not found)
// or 'suggestion' (nothing wrong; a step that would help). Older imports stored `fix` instead of `fixes`.
export const discrepancyType = d => d.type
  || (d.severity === 'warning' ? 'mismatch' : d.fix?.action === 'set_actuals_through' ? 'suggestion' : 'missing');
export const discrepancyFixes = d => d.fixes || (d.fix ? [d.fix] : []);

const NAMES = { monthly: 'monthly', quarterly: 'quarterly', annual: 'annual' };
// Fixes that switch an expense to a longer recurrence, charged `charge` (reporting cents) from `month`
const longerRecurrences = (it, month, charge) => ['quarterly', 'annual']
  .filter(r => RECURRENCE_MONTHS[r] > (RECURRENCE_MONTHS[it.recurrence] || 1))
  .map(r => ({ label: `Make ${it.name} ${NAMES[r]} (${formatCents(charge)} from ${monthLabelFull(month)})`, action: 'set_recurrence',
    args: { itemId: it.id, recurrence: r, month, charge } }));

// Days between a charge and the nearest renewal day (in its month or the one before or after), signed:
// positive when the charge came later than the renewal day
export function chargeDayOffset(date, renewalDay) {
  const actual = new Date(date + 'T00:00:00');
  let best = null;
  for (const k of [-1, 0, 1]) {
    const y = actual.getFullYear(), m = actual.getMonth() + k;
    const expected = new Date(y, m, Math.min(renewalDay, new Date(y, m + 1, 0).getDate()));
    const off = Math.round((actual - expected) / 864e5);
    if (best === null || Math.abs(off) < Math.abs(best)) best = off;
  }
  return best;
}
const DAY_TOLERANCE = 3; // banks often post a charge a few days late (weekends, processing)

// Days between a charge and the nearest date of a weekly schedule anchored on `anchor`, signed, from -3 to 3
export function weeklyDayOffset(date, anchor) {
  const diff = Math.round((new Date(date + 'T00:00:00') - anchor) / 864e5);
  const r = ((diff % 7) + 7) % 7;
  return r > 3 ? r - 7 : r;
}
const weekday = iso => new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'long' });

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
    out.push({ type: 'mismatch', severity: 'warning', title: 'The lines don\'t add up to the closing balance',
      detail: `Opening ${money(imp.opening_balance)} plus the lines read (${money(sum)}) gives ${money(imp.opening_balance + sum)}, but the statement closes at ${money(imp.closing_balance)}: a gap of ${money(gap)}. A line may have been misread or left out. Compare with the PDF, then delete this import and read it again.` });
  }

  // 2. Opening balance vs the previous month's recorded closing balance
  const prev = prevMonth(imp.period_start.slice(0, 7));
  const startsOnFirst = imp.period_start.endsWith('-01');
  const prevBal = (await query('SELECT balance, source FROM bank_balances WHERE account_id = ? AND month = ?', [imp.account_id, prev]))[0];
  if (startsOnFirst && prevBal && Math.abs(prevBal.balance - imp.opening_balance) > 1) {
    out.push({ type: 'mismatch', severity: 'warning', title: `Opening balance differs from the end of ${monthLabelFull(prev)}`,
      detail: `This statement opens at ${money(imp.opening_balance)}, but ${monthLabelFull(prev)} ended at ${money(prevBal.balance)}${prevBal.source === 'manual' ? ' (entered by hand)' : ''}. If the earlier figure was typed in, correct it; otherwise a statement may be missing or misread.`,
      fixes: [{ label: `Set end of ${monthLabelFull(prev)} to ${money(imp.opening_balance)}`, action: 'set_balance', args: { accountId: imp.account_id, month: prev, balance: imp.opening_balance } }] });
  }

  // 3. Months with no statement for this account, between the first one imported and this one
  const all = await query('SELECT period_start, period_end FROM statement_imports WHERE account_id = ? ORDER BY period_start', [imp.account_id]);
  const covered = new Set(all.flatMap(i => generateMonthRange(i.period_start.slice(0, 7), i.period_end.slice(0, 7))));
  const first = all[0]?.period_start.slice(0, 7);
  const last = all[all.length - 1]?.period_end.slice(0, 7);
  const gaps = first ? generateMonthRange(first, last).filter(m => !covered.has(m)) : [];
  if (gaps.length) {
    out.push({ type: 'missing', severity: 'info', title: `No statement yet for ${gaps.map(monthLabelFull).join(', ')}`,
      detail: `${accountLabel(account)} has statements before and after ${gaps.length > 1 ? 'these months' : 'this month'}. Import ${gaps.length > 1 ? 'them' : 'it'} so cash flow and actuals are complete.` });
  }

  const fullMonths = fullMonthsIn(imp.period_start, imp.period_end);
  const baseId = await baseScenarioId();

  // 4. Charges: expected but not seen, different from the forecast, or charged twice
  const items = await query('SELECT * FROM expense_items WHERE visible = 1');
  const seen = await query(`SELECT expense_item_id AS id, month, COUNT(*) AS n, -SUM(amount_reporting) AS total,
      MIN(amount) AS min_a, MAX(amount) AS max_a, MIN(date) AS first_date
    FROM bank_transactions WHERE kind = 'expense' AND expense_item_id IS NOT NULL GROUP BY expense_item_id, month`);
  const seenMap = new Map(seen.map(s => [`${s.id}:${s.month}`, s]));
  const forecastAfter = async (itemId, month) => (await query(`SELECT month, amount FROM expense_values WHERE expense_item_id = ? AND scenario_id = ?
      AND is_actual = 0 AND month > ? ORDER BY month LIMIT 1`, [itemId, baseId, month]))[0];
  const rmoney = c => formatCents(c);
  const longDate = iso => new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'long' });

  // Quarterly and annual charges that came in another month than expected: matched to the nearest expected month
  // (up to 2 months away) that has no charge of its own. One "charged in another month" card replaces that month's
  // "not charged" card.
  const shiftedTo = new Set();     // `${id}:${expected month}`
  const shiftedFrom = new Map();   // `${id}:${month charged}` -> expected month
  for (const s of seen) {
    const it = items.find(i => i.id === s.id);
    if (!it || it.formula || !['quarterly', 'annual'].includes(it.recurrence) || !it.start_month) continue;
    if (isChargeMonth(it.recurrence, it.start_month, s.month)) continue;
    for (const k of [-1, 1, -2, 2]) {
      const e = addMonths(s.month, k);
      if (isChargeMonth(it.recurrence, it.start_month, e) && !seenMap.has(`${it.id}:${e}`) && !shiftedTo.has(`${it.id}:${e}`)) {
        shiftedTo.add(`${it.id}:${e}`);
        shiftedFrom.set(`${it.id}:${s.month}`, e);
        break;
      }
    }
  }

  for (const m of fullMonths) {
    for (const it of items) {
      const s = seenMap.get(`${it.id}:${m}`);
      const expectedIn = shiftedFrom.get(`${it.id}:${m}`);
      if (s && expectedIn) {
        const day = Number(s.first_date.slice(8, 10));
        const span = RECURRENCE_MONTHS[it.recurrence];
        out.push({ type: 'mismatch', severity: 'info', itemId: it.id,
          title: `${it.name} charged in ${monthLabelFull(m)}, expected in ${monthLabelFull(expectedIn)}`,
          detail: `This ${NAMES[it.recurrence]} charge came on ${longDate(s.first_date)}, but its renewal was expected in ${monthLabelFull(expectedIn)}${it.renewal_day ? ` on the ${ordinalDay(it.renewal_day)}` : ''}. If the renewal date has moved, move it so the next charges are expected at the right time.`,
          fixes: [{ label: `Renew every ${span} months from ${monthLabelFull(m)}, on the ${ordinalDay(day)}`, action: 'move_renewal', args: { itemId: it.id, month: m, day } }] });
      }
      const active = (!it.start_month || it.start_month <= m) && (!it.end_month || it.end_month >= m);
      if (!active || it.formula) continue;
      const due = it.recurrence === 'one_time' ? it.start_month === m
        : it.recurrence === 'monthly' ? true : (it.start_month && isChargeMonth(it.recurrence, it.start_month, m));
      if (due && !s && shiftedTo.has(`${it.id}:${m}`)) continue; // charged in a nearby month: reported above
      if (it.recurrence === 'weekly') {
        out.push(...await weeklyDiscrepancies(it, m, s, { forecastAfter, longDate, rmoney }));
        continue;
      }
      if (due && !s) {
        // Only when the charge was due in a month this statement fully covers, and no imported account shows it.
        // If it was charged before, it may renew less often than recorded: offer the longer recurrences that
        // would not expect it this month, anchored on the last charge.
        const last = seen.filter(x => x.id === it.id && x.month < m).sort((a, b) => b.month.localeCompare(a.month))[0];
        const longer = last && it.recurrence !== 'one_time'
          ? longerRecurrences(it, last.month, last.total).filter(f => !isChargeMonth(f.args.recurrence, last.month, m))
          : [];
        out.push({ type: 'missing', severity: 'info', itemId: it.id, title: `${it.name} not charged in ${monthLabelFull(m)}`,
          detail: `It was expected in ${monthLabelFull(m)} but appears in no imported statement.${last ? ` It was last charged ${formatCents(last.total)} in ${monthLabelFull(last.month)}; if it renews less often, change its recurrence.` : ''} If it's paid from an account you haven't imported yet, import that statement. If it has ended, set an end month.`,
          fixes: [...longer, { label: `End ${it.name} in ${monthLabelFull(prevMonth(m))}`, action: 'end_expense', args: { itemId: it.id, month: prevMonth(m) } }] });
      }
      if (!s) continue;
      // Charged on another day than the renewal day (one charge in the month; a moved renewal is reported above)
      if (it.renewal_day && s.n === 1 && !expectedIn) {
        const off = chargeDayOffset(s.first_date, it.renewal_day);
        if (Math.abs(off) > DAY_TOLERANCE) {
          const day = Number(s.first_date.slice(8, 10));
          out.push({ type: 'mismatch', severity: 'info', itemId: it.id,
            title: `${it.name} charged on the ${ordinalDay(day)}, renewal day is the ${ordinalDay(it.renewal_day)}`,
            detail: `The ${monthLabelFull(m)} charge came on ${longDate(s.first_date)}, ${Math.abs(off)} days ${off > 0 ? 'later' : 'earlier'} than expected. If the billing date has changed, update the renewal day so Upcoming Charges show the right date.`,
            fixes: [{ label: `Set the renewal day to the ${ordinalDay(day)}`, action: 'set_renewal_day', args: { itemId: it.id, day } }] });
        }
      }
      if (it.recurrence === 'monthly' && s.n > 1 && s.min_a === s.max_a) {
        out.push({ type: 'mismatch', severity: 'warning', itemId: it.id, title: `${it.name} charged ${s.n} times in ${monthLabelFull(m)}`,
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
          // Much more than expected: often a quarterly or annual charge recorded as monthly
          const muchLarger = s.total >= expected * 2.5 && s.n === 1;
          const longer = muchLarger ? longerRecurrences(it, m, s.total) : [];
          out.push({ type: 'mismatch', severity: 'info', itemId: it.id, title: `${it.name} cost ${rmoney(s.total)} in ${monthLabelFull(m)}, ${pct > 0 ? '+' : ''}${pct}% vs forecast`,
            detail: `The forecast expects ${rmoney(expected)} per charge. ${longer.length ? `A charge this much larger may cover several months: if it renews ${longer.map(f => NAMES[f.args.recurrence]).join(' or ')}, change its recurrence. ` : ''}If the new price will last, update the forecast from ${monthLabelFull(next.month)} onwards.`,
            fixes: [...longer, { label: `Use ${rmoney(newMonthly)} a month from ${monthLabelFull(next.month)}`, action: 'update_forecast', args: { itemId: it.id, from: next.month, amount: newMonthly } }] });
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
          out.push({ type: 'missing', severity: 'info', title: `No salary payment to ${e.name} in ${monthLabelFull(m)}`,
            detail: `Payroll expects ${rmoney(expected)}. If ${e.name} is paid from another account, import that statement. If ${e.name} has left, set an end date on the Payroll page.` });
        }
        continue;
      }
      if (Math.abs(p.total - expected) > Math.max(100, expected * 0.01)) {
        const fix = (e.tax_pct || 0) === 0
          ? { label: `Set ${e.name}'s monthly salary to ${rmoney(p.total)}`, action: 'update_salary', args: { employeeId: e.id, salary: p.total } }
          : undefined;
        out.push({ type: 'mismatch', severity: 'info', title: `${e.name} was paid ${rmoney(p.total)} in ${monthLabelFull(m)}`,
          detail: `Payroll expects ${rmoney(expected)}. The payment is recorded as the actual for ${monthLabelFull(m)}. If the change is lasting (a raise, a new rate), update the salary${fix ? '' : ' on the Payroll page'}; if it's a one-off (bonus, partial month), nothing to do.`,
          fixes: fix ? [fix] : [] });
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
      out.push({ type: 'suggestion', severity: 'info', title: `Every account now has a statement for ${monthLabelFull(latestFull)}`,
        detail: `"Actuals through" is ${at ? monthLabelFull(at) : 'not set'}. Move it to ${monthLabelFull(latestFull)} so reports treat that month as actual.`,
        fixes: [{ label: `Set actuals through ${monthLabelFull(latestFull)}`, action: 'set_actuals_through', args: { month: latestFull } }] });
    } else if (!allCovered.every(Boolean) && accounts.length > 1) {
      const missing = accounts.filter((a, i) => !allCovered[i]).map(accountLabel);
      out.push({ type: 'missing', severity: 'info', title: `Total cash for ${monthLabelFull(latestFull)} is incomplete`,
        detail: `No statement covers ${monthLabelFull(latestFull)} yet for ${missing.join(', ')}. Import ${missing.length > 1 ? 'them' : 'it'} to complete cash and actuals for that month.` });
    }
  }

  for (const w of JSON.parse(imp.discrepancies || '[]').filter(d => d.fromReading)) out.push(w);
  await execute('UPDATE statement_imports SET discrepancies = ? WHERE id = ?', [JSON.stringify(out), importId]);
  return out;
}

// A weekly expense in one month: charges missing, on another weekday, or a different amount. The forecast's
// monthly value is the yearly average, so the expected amount is the weekly charge times the charge dates in
// the month (4 or 5), not the monthly value.
async function weeklyDiscrepancies(it, m, s, { forecastAfter, longDate, rmoney }) {
  const out = [];
  const anchor = weeklyAnchor(it);
  const expectedDates = weeklyChargeDatesIn(anchor, m);
  if (!expectedDates.length) return out; // no first charge date yet, or it starts later in the month
  const dates = s ? (await query(`SELECT date FROM bank_transactions WHERE kind = 'expense' AND expense_item_id = ? AND month = ?
    ORDER BY date`, [it.id, m])).map(r => r.date) : [];
  const n = dates.length, want = expectedDates.length;

  if (n < want) {
    out.push({ type: 'missing', severity: 'info', itemId: it.id,
      title: n ? `${n} of ${want} weekly ${it.name} charges found in ${monthLabelFull(m)}` : `${it.name} not charged in ${monthLabelFull(m)}`,
      detail: `Weekly charges were expected on ${expectedDates.map(longDate).join(', ')}${n ? `; the statements show ${dates.map(longDate).join(', ')}` : ''}. If ${n ? 'some are' : "it's"} paid from an account you haven't imported yet, import that statement.${n ? '' : ' If it has ended, set an end month.'}`,
      fixes: n ? [] : [{ label: `End ${it.name} in ${monthLabelFull(prevMonth(m))}`, action: 'end_expense', args: { itemId: it.id, month: prevMonth(m) } }] });
  }

  // Another weekday: most charges at least 2 days from the schedule (a 1-day posting delay is normal)
  const off = dates.filter(d => Math.abs(weeklyDayOffset(d, anchor)) >= 2);
  if (n && off.length * 2 > n) {
    const first = off[0];
    out.push({ type: 'mismatch', severity: 'info', itemId: it.id,
      title: `${it.name} charged on ${weekday(first)}s, expected on ${weekday(expectedDates[0])}s`,
      detail: `In ${monthLabelFull(m)} the weekly charges came on ${dates.map(longDate).join(', ')}. If the billing day has changed, move the weekly schedule so Upcoming Charges show the right dates.`,
      fixes: [{ label: `Charge weekly from ${longDate(first)}`, action: 'move_renewal', args: { itemId: it.id, month: first.slice(0, 7), day: Number(first.slice(8, 10)) } }] });
  }

  const next = n ? await forecastAfter(it.id, m) : null;
  if (next) {
    const weekly = chargeFromMonthly(next.amount, 'weekly');
    const expected = weekly * n; // compare charge for charge; missing charges are reported above
    const diff = s.total - expected;
    if (expected > 0 && Math.abs(diff) > Math.max(100, expected * 0.05)) {
      const pct = Math.round((diff / expected) * 100);
      const average = Math.round(s.total / n);
      out.push({ type: 'mismatch', severity: 'info', itemId: it.id,
        title: `${it.name} cost ${rmoney(s.total)} in ${monthLabelFull(m)}, ${pct > 0 ? '+' : ''}${pct}% vs forecast`,
        detail: `${n} weekly charge${n !== 1 ? 's' : ''} averaging ${rmoney(average)}, where the forecast expects ${rmoney(weekly)} a week. If the new amount will last, update the forecast from ${monthLabelFull(next.month)} onwards.`,
        fixes: [{ label: `Use ${rmoney(average)} a week from ${monthLabelFull(next.month)}`, action: 'update_forecast', args: { itemId: it.id, from: next.month, amount: monthlyShare(average, 'weekly') } }] });
    }
  }
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
    case 'set_recurrence': {
      // The charge month becomes the anchor of the new recurrence; its charge is spread over the months it covers,
      // and the forecast from then on uses the same charge
      const baseId = await baseScenarioId();
      const item = (await query('SELECT end_month FROM expense_items WHERE id = ?', [a.itemId]))[0];
      await execute('UPDATE expense_items SET recurrence = ?, start_month = ? WHERE id = ?', [a.recurrence, a.month, a.itemId]);
      await recomputeRunRate([a.itemId], [a.month], baseId);
      await respreadExpense(a.itemId, baseId, a.charge, a.recurrence, a.month, item?.end_month || null);
      return `Recurrence changed to ${NAMES[a.recurrence]}`;
    }
    case 'set_renewal_day':
      await execute('UPDATE expense_items SET renewal_day = ? WHERE id = ?', [a.day, a.itemId]);
      return 'Renewal day updated';
    case 'move_renewal':
      // The month charged becomes the anchor: later renewals are expected every 3 or 12 months (or 7 days) from it
      await execute('UPDATE expense_items SET start_month = ?, renewal_day = ? WHERE id = ?', [a.month, a.day, a.itemId]);
      return 'Renewal moved';
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
