import { query } from './db.js';
import { getBaseScenarioId } from './schema.js';
import { employeeCost, isEmployedIn, payrollCategory, loadScenarioEmployees } from './payroll.js';
import { chargeFromMonthly, generateMonthRange, isChargeMonth, weeklyAnchor, weeklyChargeDates, thresholdCharges } from './utils.js';

const pad = n => String(n).padStart(2, '0');
export const monthOf = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const daysIn = (y, m) => new Date(y, m, 0).getDate();

// Expense values for the given months, a scenario value replacing the base value: { "itemId:month": cents }
export async function loadExpenseValues(scenarioId, startMonth, endMonth) {
  const baseId = await getBaseScenarioId();
  const rows = await query(`
    SELECT expense_item_id, month, amount, scenario_id FROM expense_values
    WHERE scenario_id IN (?, ?) AND month >= ? AND month <= ?
  `, [scenarioId, baseId, startMonth, endMonth]);
  const byKey = {};
  rows.forEach(r => {
    const k = `${r.expense_item_id}:${r.month}`;
    if (!(k in byKey) || r.scenario_id === scenarioId) byKey[k] = r.amount;
  });
  return byKey;
}

// Charges falling between today and today + `days` (inclusive), soonest first.
// Recurring expenses need a renewal day to have a date, and quarterly or annual ones also need a start month
// (their first charge); weekly ones are charged every 7 days from their start month and renewal day (their first
// charge); threshold-billed ones are estimated from their spending rate (estimated: true), starting from their last
// charge in an imported statement (`last_charge_date`) or from today; one-time expenses are charged in their start month
// (on their renewal day, or the 1st when none is set). The amount is one full charge, not the monthly share.
export function computeUpcomingCharges(items, values, days, now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const until = new Date(today.getTime());
  until.setDate(until.getDate() + days);
  const months = generateMonthRange(monthOf(today), monthOf(until));
  const charges = [];

  for (const item of items) {
    const inPeriod = m => (!item.start_month || m >= item.start_month) && (!item.end_month || m <= item.end_month);
    if (item.recurrence === 'threshold') {
      // Billed each time spend reaches the threshold: the dates follow the monthly spend
      const last = item.last_charge_date ? new Date(item.last_charge_date + 'T00:00:00') : null;
      const start = last && last < today ? last : new Date(today.getTime() - 864e5);
      // Months before this one (since the last charge) are not loaded: they spend at this month's rate
      const value = month => (!inPeriod(month) ? 0
        : values[`${item.id}:${month < monthOf(today) ? monthOf(today) : month}`] || 0);
      for (const c of thresholdCharges(item, value, start, until)) {
        if (c.date < today) continue; // due before today: not upcoming any more
        const n = charges.filter(x => x.id === item.id && x.date - c.date === 0).length;
        const day = String(c.date.getDate()).padStart(2, '0');
        charges.push({ ...item, kind: 'expense', key: `e:${item.id}:${c.month}-${day}${n ? '-' + n : ''}`,
          date: c.date, month: c.month, amount: c.amount, estimated: true });
      }
      continue;
    }
    if (item.recurrence === 'weekly') {
      // One charge a week: the weekly amount, from the month's value (the monthly average)
      for (const date of weeklyChargeDates(weeklyAnchor(item), today, until)) {
        const month = monthOf(date);
        if (!inPeriod(month)) continue;
        const amount = chargeFromMonthly(values[`${item.id}:${month}`] || 0, 'weekly');
        if (!amount) continue;
        const day = String(date.getDate()).padStart(2, '0');
        charges.push({ ...item, kind: 'expense', key: `e:${item.id}:${month}-${day}`, date, month, amount });
      }
      continue;
    }
    let candidates = [];
    if (item.recurrence === 'one_time') {
      if (item.start_month && months.includes(item.start_month)) candidates = [item.start_month];
    } else if (item.renewal_day && (item.recurrence === 'monthly' || item.start_month)) {
      // Quarterly and annual expenses are charged only in their start month and every 3 or 12 months after it
      candidates = months.filter(m => inPeriod(m) && isChargeMonth(item.recurrence, item.start_month, m));
    }

    for (const month of candidates) {
      const [y, m] = month.split('-').map(Number);
      const date = new Date(y, m - 1, Math.min(item.renewal_day || 1, daysIn(y, m)));
      if (date < today || date > until) continue;
      const monthly = values[`${item.id}:${month}`] || 0;
      const amount = item.recurrence === 'one_time' ? monthly : chargeFromMonthly(monthly, item.recurrence);
      if (!amount) continue;
      charges.push({ ...item, kind: 'expense', key: `e:${item.id}:${month}`, date, month, amount });
    }
  }
  return charges.sort((a, b) => a.date - b.date || b.amount - a.amount);
}

// --- Runway: how long today's cash covers the upcoming charges ----------------------------------------------------

export const RUNWAY_DAYS = 30;
// Visible expenses, each with the date of its last charge seen in an imported statement (threshold billing starts there)
export const ITEMS_WITH_LAST_CHARGE_SQL = `SELECT ei.*, (SELECT MAX(bt.date) FROM bank_transactions bt
  WHERE bt.expense_item_id = ei.id AND bt.kind = 'expense') AS last_charge_date FROM expense_items ei WHERE ei.visible = 1`;

// Pays the charges of the next RUNWAY_DAYS days (expenses and payroll, `charges`) from `cash`, in date order, with no
// money coming in. If cash can't cover one of them: { unit: 'days', value, runsOutOn, blockedBy } (days until that
// charge). If it covers all of them, the regular runway from the monthly `burn`: { unit: 'weeks' | 'months', value,
// months } (weeks under 2 months), or { unit: 'positive' } when the company isn't burning cash.
// { unit: 'none' } when the cash balance is unknown. Amounts in cents.
export function computeRunway({ cash, charges, burn, now = new Date() }) {
  if (cash === null || cash === undefined) return { unit: 'none' };
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const sorted = [...charges].sort((a, b) => a.date - b.date || b.amount - a.amount);
  const stop = c => ({ unit: 'days', value: Math.max(0, Math.round((c.date - today) / 864e5)), runsOutOn: c.date, blockedBy: c });
  if (cash <= 0) {
    return sorted[0] ? { ...stop(sorted[0]), value: 0, runsOutOn: today } : { unit: 'days', value: 0, runsOutOn: today, blockedBy: null };
  }
  let left = cash;
  for (const c of sorted) {
    if (left < c.amount) return stop(c);
    left -= c.amount;
  }
  if (!(burn > 0)) return { unit: 'positive' };
  const months = cash / burn;
  return months < 2 ? { unit: 'weeks', value: months * 52 / 12, months } : { unit: 'months', value: months, months };
}

// The runway from data already loaded: expense items (with last_charge_date), their values for the next RUNWAY_DAYS
// days, the scenario's people and the settings
export function runwayFromData({ items, values, people, settings, cash, burn, now = new Date() }) {
  const charges = [
    ...computeUpcomingCharges(items, values, RUNWAY_DAYS, now),
    ...computePayrollCharges(people, RUNWAY_DAYS, settings?.payroll_pay_day, settings?.dept_mapping, now),
  ];
  return computeRunway({ cash, charges, burn, now });
}

// Loads what the runway needs for a scenario, then computes it
export async function loadRunway(scenarioId, cash, burn, settings) {
  const now = new Date();
  const [items, values, { employees }] = await Promise.all([
    query(ITEMS_WITH_LAST_CHARGE_SQL),
    loadExpenseValues(scenarioId, monthOf(now), horizonMonth(RUNWAY_DAYS, now)),
    loadScenarioEmployees(scenarioId),
  ]);
  return runwayFromData({ items, values, people: employees, settings, cash, burn, now });
}

// How the runway reads: { value: '9', unit: 'days' }, { value: '6.5', unit: 'weeks' }, { value: '4.2', unit: 'months' }
export function formatRunway(r) {
  if (r.unit === 'days') return { value: String(r.value), unit: r.value === 1 ? 'day' : 'days' };
  if (r.unit === 'weeks') return { value: r.value.toFixed(1), unit: 'weeks' };
  if (r.unit === 'months') return { value: r.value > 999 ? '999+' : r.value.toFixed(1), unit: 'months' };
  return { value: '', unit: '' };
}

// Last month that a window of `days` from today can reach
export function horizonMonth(days, now = new Date()) {
  return monthOf(new Date(now.getFullYear(), now.getMonth(), now.getDate() + days));
}

// Why an expense can't appear on the Upcoming Charges page, or null when it can
export function undatedReason(item, now = new Date()) {
  if (item.end_month && item.end_month < monthOf(now)) return null; // finished: nothing to schedule
  if (item.recurrence === 'one_time') return item.start_month ? null : 'no month';
  if (item.recurrence === 'threshold') return item.billing_threshold > 0 ? null : 'no threshold';
  if (!item.renewal_day) return 'no renewal day';
  if (item.recurrence !== 'monthly' && !item.start_month) return 'no start month';
  return null;
}

// Payroll payments between today and today + `days`: one line per employee and month, salary plus employer
// contributions, paid on `payDay` (null = last day of the month). Uses the scenario's employees.
export function computePayrollCharges(employees, days, payDay, deptMapping, now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const until = new Date(today.getTime());
  until.setDate(until.getDate() + days);
  const out = [];
  for (const month of generateMonthRange(monthOf(today), monthOf(until))) {
    const [y, m] = month.split('-').map(Number);
    const date = new Date(y, m - 1, Math.min(payDay || 31, daysIn(y, m)));
    if (date < today || date > until) continue;
    for (const e of employees) {
      if (!isEmployedIn(e, month)) continue;
      out.push({
        kind: 'payroll',
        key: `p:${e._source === 'scenario' ? 's' + e._scenarioEmployeeId : e.id}:${month}`,
        employee: e,
        name: e.name,
        company: e.department || null,
        charge_label: e.role || null,
        category_name: payrollCategory(e.department, deptMapping),
        recurrence: 'payroll',
        date, month, amount: employeeCost(e),
      });
    }
  }
  return out;
}
