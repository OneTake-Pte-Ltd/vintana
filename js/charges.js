import { query } from './db.js';
import { getBaseScenarioId } from './schema.js';
import { employeeCost, isEmployedIn, payrollCategory } from './payroll.js';
import { chargeFromMonthly, generateMonthRange, isChargeMonth } from './utils.js';

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
// (their first charge); one-time expenses are charged in their start month
// (on their renewal day, or the 1st when none is set). The amount is one full charge, not the monthly share.
export function computeUpcomingCharges(items, values, days, now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const until = new Date(today.getTime());
  until.setDate(until.getDate() + days);
  const months = generateMonthRange(monthOf(today), monthOf(until));
  const charges = [];

  for (const item of items) {
    const inPeriod = m => (!item.start_month || m >= item.start_month) && (!item.end_month || m <= item.end_month);
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

// Last month that a window of `days` from today can reach
export function horizonMonth(days, now = new Date()) {
  return monthOf(new Date(now.getFullYear(), now.getMonth(), now.getDate() + days));
}

// Why an expense can't appear on the Upcoming Charges page, or null when it can
export function undatedReason(item, now = new Date()) {
  if (item.end_month && item.end_month < monthOf(now)) return null; // finished: nothing to schedule
  if (item.recurrence === 'one_time') return item.start_month ? null : 'no month';
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
