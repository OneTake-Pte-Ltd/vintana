import { query, execute } from './db.js';

export const RECURRENCE_OPTIONS = [
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

const EDITABLE = ['name', 'company', 'charge_label', 'category_id', 'subcategory_id', 'recurrence'];
const NUMERIC = ['category_id', 'subcategory_id'];

// Saves one field of an expense. Moving an expense to another category clears a sub-category that
// belongs to the old one.
export async function updateExpenseField(item, field, value, subcategories = []) {
  if (!EDITABLE.includes(field)) throw new Error(`Field ${field} can't be edited here`);
  const v = NUMERIC.includes(field) ? (value === null || value === '' ? null : Number(value)) : value;
  if (field === 'category_id') {
    const sub = subcategories.find(s => s.id === item.subcategory_id);
    if (sub && sub.category_id !== v) {
      await execute('UPDATE expense_items SET category_id = ?, subcategory_id = NULL WHERE id = ?', [v, item.id]);
      return;
    }
  }
  await execute(`UPDATE expense_items SET ${field} = ? WHERE id = ?`, [v, item.id]);
}
