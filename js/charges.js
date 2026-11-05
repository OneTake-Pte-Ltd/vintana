import { query } from './db.js';
import { chargeFromMonthly, generateMonthRange, isChargeMonth } from './utils.js';

const pad = n => String(n).padStart(2, '0');
export const monthOf = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const daysIn = (y, m) => new Date(y, m, 0).getDate();

// Expense values for the given months, a scenario value replacing the base value: { "itemId:month": cents }
export async function loadExpenseValues(scenarioId, startMonth, endMonth) {
  const baseRows = await query('SELECT id FROM scenarios WHERE is_base = 1 LIMIT 1');
  const baseId = baseRows[0]?.id || 1;
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
// Recurring expenses need a renewal day to have a date; one-time expenses are charged in their start month
// (on their renewal day, or the 1st when none is set). The amount is one full charge, not the monthly share.
export function computeUpcomingCharges(items, values, days, now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const until = new Date(today.getTime());
  until.setDate(until.getDate() + days);
  const months = generateMonthRange(monthOf(today), monthOf(until));
  const charges = [];

  for (const item of items) {
    const inPeriod = m => (!item.start_month || m >= item.start_month) && (!item.end_month || m <= item.end_month);
    const candidates = item.recurrence === 'one_time'
      ? (item.start_month && months.includes(item.start_month) ? [item.start_month] : [])
      : (item.renewal_day ? months.filter(m => inPeriod(m) && isChargeMonth(item.recurrence, item.start_month, m)) : []);

    for (const month of candidates) {
      const [y, m] = month.split('-').map(Number);
      const date = new Date(y, m - 1, Math.min(item.renewal_day || 1, daysIn(y, m)));
      if (date < today || date > until) continue;
      const monthly = values[`${item.id}:${month}`] || 0;
      const amount = item.recurrence === 'one_time' ? monthly : chargeFromMonthly(monthly, item.recurrence);
      if (!amount) continue;
      charges.push({ ...item, date, month, amount });
    }
  }
  return charges.sort((a, b) => a.date - b.date || b.amount - a.amount);
}

// Last month that a window of `days` from today can reach
export function horizonMonth(days, now = new Date()) {
  return monthOf(new Date(now.getFullYear(), now.getMonth(), now.getDate() + days));
}
