import { query, execute } from './db.js';
import { currentMonth, expenseMonthlyValues, forecastEnd, chargeFromMonthly } from './utils.js';

export const RECURRENCE_OPTIONS = [
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'quarterly', label: 'Quarterly' },
  { value: 'annual', label: 'Annual' },
  { value: 'one_time', label: 'One-time' },
];
export const recurrenceLabel = r => RECURRENCE_OPTIONS.find(o => o.value === r)?.label || r || '';

// Categories and sub-categories. Sub-categories may be missing on a database a read-only token can't upgrade.
export async function loadCategoryLookups() {
  const categories = await query('SELECT * FROM expense_categories ORDER BY sort_order, name');
  let subcategories = [];
  try {
    subcategories = await query(`SELECT s.*, c.name AS category_name FROM expense_subcategories s
      JOIN expense_categories c ON c.id = s.category_id ORDER BY c.sort_order, s.sort_order, s.name`);
  } catch { /* table not created yet */ }
  return { categories, subcategories };
}

export const categoryOptions = categories => categories.map(c => ({ value: c.id, label: c.name }));

export const subcategoryOptions = (subcategories, categoryId) => [
  { value: null, label: 'None' },
  ...subcategories.filter(s => s.category_id === Number(categoryId)).map(s => ({ value: s.id, label: s.name })),
];

// Rewrites an expense's forecast for a scenario from this month on (or its start month, if later) so that
// each charge is `chargeCents` on `recurrence`. Past months and actuals read from bank statements are kept.
export async function respreadExpense(itemId, scenarioId, chargeCents, recurrence, startMonth, endMonth, rangeEnd) {
  const from = startMonth && startMonth > currentMonth() ? startMonth : currentMonth();
  const end = endMonth || forecastEnd(rangeEnd);
  await execute('DELETE FROM expense_values WHERE expense_item_id = ? AND scenario_id = ? AND is_actual = 0 AND month >= ?',
    [itemId, scenarioId, from]);
  if (end < from) return;
  const vals = recurrence === 'one_time'
    ? (startMonth && startMonth >= from ? expenseMonthlyValues(chargeCents, recurrence, startMonth, end) : [])
    : expenseMonthlyValues(chargeCents, recurrence, from, end);
  for (const v of vals) {
    await execute('INSERT OR IGNORE INTO expense_values (expense_item_id, scenario_id, month, amount, is_actual) VALUES (?,?,?,?,0)',
      [itemId, scenarioId, v.month, v.amount]);
  }
}

// Amount of one charge this month (scenario value, else base value), in cents
export async function currentChargeAmount(item, scenarioId) {
  const rows = await query(`
    SELECT ev.amount FROM expense_values ev JOIN scenarios s ON s.id = ev.scenario_id
    WHERE ev.expense_item_id = ? AND ev.month = ? AND (ev.scenario_id = ? OR s.is_base = 1)
    ORDER BY (ev.scenario_id = ?) DESC LIMIT 1`, [item.id, currentMonth(), scenarioId, scenarioId]);
  return rows.length ? chargeFromMonthly(rows[0].amount, item.recurrence) : 0;
}

const EDITABLE = ['name', 'company', 'charge_label', 'category_id', 'subcategory_id', 'recurrence'];
const NUMERIC = ['category_id', 'subcategory_id'];

// Saves one field of an expense. Moving an expense to another category clears a sub-category that
// belongs to the old one. Changing the recurrence keeps the amount of each charge (a 688.99 monthly
// charge becomes a 688.99 quarterly charge) by rewriting the scenario's forecast from this month on.
// Switching to or from weekly keeps the monthly cost instead: a 2,000 monthly budget becomes about 461.54 a week,
// not 2,000 a week, since a weekly and a monthly bill of the same amount are very different budgets.
export async function updateExpenseField(item, field, value, subcategories = [], scenarioId = null) {
  if (!EDITABLE.includes(field)) throw new Error(`Field ${field} can't be edited here`);
  const v = NUMERIC.includes(field) ? (value === null || value === '' ? null : Number(value)) : value;
  const weeklySwitch = field === 'recurrence' && (v === 'weekly' || item.recurrence === 'weekly');
  if (field === 'recurrence' && scenarioId && v !== item.recurrence && !item.formula && !weeklySwitch) {
    const charge = await currentChargeAmount(item, scenarioId);
    await execute('UPDATE expense_items SET recurrence = ? WHERE id = ?', [v, item.id]);
    if (charge) await respreadExpense(item.id, scenarioId, charge, v, item.start_month, item.end_month);
    return;
  }
  if (field === 'category_id') {
    const sub = subcategories.find(s => s.id === item.subcategory_id);
    if (sub && sub.category_id !== v) {
      await execute('UPDATE expense_items SET category_id = ?, subcategory_id = NULL WHERE id = ?', [v, item.id]);
      return;
    }
  }
  await execute(`UPDATE expense_items SET ${field} = ? WHERE id = ?`, [v, item.id]);
}
