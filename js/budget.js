// Computed expenses: an expense whose budget is made of budget lines (fixed amounts and formulas, e.g. DigitalOcean =
// production droplet + test droplet + internal app + storage per customer) or a single formula. The expense stays one
// line for bank statements, Upcoming Charges and reports; only its forecast is computed, as the sum of its lines.
//
// The forecast is written into expense_values, from the current month on (or the expense's start month, if later), in
// every scenario, each with its own customers and payroll. Months with bank-statement actuals are never overwritten,
// and past months keep their values. It is rewritten when an expense is saved, after a ProfitWell sync, when growth
// rates change, when payroll changes, and once a day when the app opens.

import { query, batch } from './db.js';
import { loadMrrSeries } from './profitwell.js';
import { loadScenarioEmployees, employeeCost, isEmployedIn } from './payroll.js';
import { evalFormulaExact } from './formula.js';
import { currentMonth, generateMonthRange, monthlyShare, forecastEnd } from './utils.js';

const DAILY_KEY = 'vintana_budget_recomputed';

export const nameAlias = name => (name || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

// The names a formula can use, totals first. Values are in currency units (not cents).
export const BASE_VARIABLES = ['customers.total', 'mrr.total', 'headcount.total', 'payroll.total'];

// Formula variables for each month of [from, to] in a scenario: { month: { name: value } }
//   customers.total, mrr.total     all product lines (forecast months: grown at each line's planned growth rate)
//   <line>.customers, <line>.mrr   one product line, named after it (e.g. onetake_pro.customers)
//   headcount.total, payroll.total people employed that month and their monthly cost incl. employer contributions
export async function formulaContexts(scenarioId, from, to) {
  const [series, { employees }] = await Promise.all([loadMrrSeries(scenarioId, from, to), loadScenarioEmployees(scenarioId)]);
  const out = {};
  for (const m of series.months) {
    const ctx = {};
    let customers = 0;
    for (const l of series.lines) {
      const v = l.values[m] || {};
      const a = nameAlias(l.line.name);
      if (a) {
        ctx[`${a}.customers`] = (ctx[`${a}.customers`] || 0) + (v.customers || 0);
        ctx[`${a}.mrr`] = (ctx[`${a}.mrr`] || 0) + (v.mrr || 0) / 100;
      }
      customers += v.customers || 0;
    }
    ctx['customers.total'] = customers;
    ctx['mrr.total'] = (series.totals[m] || 0) / 100;
    const staff = employees.filter(e => isEmployedIn(e, m));
    ctx['headcount.total'] = staff.length;
    ctx['payroll.total'] = staff.reduce((s, e) => s + employeeCost(e), 0) / 100;
    out[m] = ctx;
  }
  return out;
}

// Variable names available in a context, totals first
export const variablesOf = ctx => [...BASE_VARIABLES, ...Object.keys(ctx || {}).filter(k => !BASE_VARIABLES.includes(k)).sort()];

// Budget lines by expense: { itemId: [{ id, name, amount (cents, fixed lines), formula (formula lines) }] }
export async function loadBudgetLines() {
  try {
    const rows = await query('SELECT * FROM expense_budget_lines ORDER BY expense_item_id, sort_order, id');
    const out = {};
    rows.forEach(r => (out[r.expense_item_id] ||= []).push(r));
    return out;
  } catch {
    return {}; // table not created yet
  }
}

// Replaces an expense's budget lines. lines: [{ name, amount (cents) | formula }]
export async function saveBudgetLines(itemId, lines) {
  const stmts = [{ sql: 'DELETE FROM expense_budget_lines WHERE expense_item_id = ?', args: [itemId] }];
  lines.forEach((l, i) => stmts.push({
    sql: 'INSERT INTO expense_budget_lines (expense_item_id, name, amount, formula, sort_order) VALUES (?,?,?,?,?)',
    args: [itemId, l.name.trim(), l.formula ? null : Math.round(l.amount || 0), l.formula ? l.formula.trim() : null, i],
  }));
  await batch(stmts);
}

export const isComputed = (item, lines) => !!((item.formula && item.formula.trim()) || (lines && lines.length));

// A budget line's amount in a month, in cents
export const lineAmount = (line, ctx) => (line.formula ? Math.round(evalFormulaExact(line.formula, ctx) * 100) : (line.amount || 0));

// One charge of a computed expense in a month, in cents: the sum of its budget lines, else its formula
export function chargeFor(item, lines, ctx) {
  if (lines && lines.length) return lines.reduce((s, l) => s + lineAmount(l, ctx), 0);
  return Math.round(evalFormulaExact(item.formula, ctx) * 100);
}

// Rewrites the forecast of computed expenses (all of them, or only itemIds), in every scenario. Returns how many.
export async function recomputeComputedExpenses(itemIds = null) {
  const [items, linesBy, scenarios] = await Promise.all([
    query('SELECT id, recurrence, start_month, end_month, formula FROM expense_items WHERE visible = 1'),
    loadBudgetLines(),
    query('SELECT id FROM scenarios'),
  ]);
  const todo = items.filter(i => isComputed(i, linesBy[i.id]) && (!itemIds || itemIds.includes(i.id)));
  if (!todo.length || !scenarios.length) return 0;
  const from0 = currentMonth();
  const to = forecastEnd(null);
  const stmts = [];
  for (const sc of scenarios) {
    const ctxs = await formulaContexts(sc.id, from0, to);
    for (const it of todo) {
      const from = it.start_month && it.start_month > from0 ? it.start_month : from0;
      const end = it.end_month && it.end_month < to ? it.end_month : to;
      stmts.push({ sql: 'DELETE FROM expense_values WHERE expense_item_id = ? AND scenario_id = ? AND is_actual = 0 AND month >= ?',
        args: [it.id, sc.id, from] });
      if (end < from) continue;
      for (const m of generateMonthRange(from, end)) {
        if (it.recurrence === 'one_time' && m !== it.start_month) continue;
        const charge = chargeFor(it, linesBy[it.id], ctxs[m] || {});
        const value = it.recurrence === 'one_time' ? charge : monthlyShare(charge, it.recurrence);
        stmts.push({ sql: 'INSERT OR IGNORE INTO expense_values (expense_item_id, scenario_id, month, amount, is_actual) VALUES (?,?,?,?,0)',
          args: [it.id, sc.id, m, value] });
      }
    }
  }
  for (let i = 0; i < stmts.length; i += 200) await batch(stmts.slice(i, i + 200));
  return todo.length;
}

// Once a day per browser, so formulas follow the months as they pass
export async function recomputeDaily() {
  const today = new Date().toISOString().slice(0, 10);
  try { if (localStorage.getItem(DAILY_KEY) === today) return false; } catch { /* storage unavailable: run */ }
  await recomputeComputedExpenses();
  try { localStorage.setItem(DAILY_KEY, today); } catch { /* storage unavailable */ }
  return true;
}
