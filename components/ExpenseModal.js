import { query, execute } from '../js/db.js';
import { getBaseScenarioId } from '../js/schema.js';
import {
  monthLabel, generateMonthRange, currentMonth, chargeFromMonthly, expenseMonthlyValues, forecastEnd,
} from '../js/utils.js';
import { subcategoryOptions, respreadExpense } from '../js/expenses.js';

const INPUT = 'w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500';

// Add or edit an expense. Used by the Expenses and Upcoming Charges pages.
// `itemId` null = add. Emits `saved` after a change and `close` when dismissed.
export default {
  name: 'ExpenseModal',
  props: {
    itemId: { type: Number, default: null },
    categories: { type: Array, default: () => [] },
    subcategories: { type: Array, default: () => [] },
  },
  emits: ['close', 'saved'],
  setup(props, { emit }) {
    const { ref, computed, inject, onMounted } = Vue;
    const scenarioId = inject('scenarioId');
    const dateRange = inject('dateRange');
    const toast = inject('toast');

    const loading = ref(true);
    const saving = ref(false);
    const editing = computed(() => props.itemId !== null);
    const editValues = ref({});
    const months = computed(() => generateMonthRange(dateRange.value.start, dateRange.value.end));

    const blankForm = () => ({
      name: '', alias: '', company: '', charge_label: '',
      category_id: props.categories[0]?.id || null, subcategory_id: null,
      formula: '', entryMode: 'manual', amount: '',
      recurrence: 'monthly', renewal_day: null,
      start_month: dateRange.value?.start || '', end_month: '', notes: '',
    });
    const form = ref(blankForm());
    const subOptions = computed(() => subcategoryOptions(props.subcategories, form.value.category_id));
    const hasSubcategories = computed(() => props.subcategories.length > 0);

    const baseScenarioId = getBaseScenarioId;
    // Amount and recurrence as loaded, to tell whether the forecast needs rewriting on save
    let original = null;

    onMounted(async () => {
      try {
        if (!editing.value) { form.value = blankForm(); return; }
        const sid = scenarioId.value;
        const baseId = await baseScenarioId();
        const rows = await query(`
          SELECT ei.*, COALESCE(sv.amount, bv.amount, 0) AS cur_amount
          FROM expense_items ei
          LEFT JOIN expense_values sv ON sv.expense_item_id = ei.id AND sv.scenario_id = ? AND sv.month = ?
          LEFT JOIN expense_values bv ON bv.expense_item_id = ei.id AND bv.scenario_id = ? AND bv.month = ?
          WHERE ei.id = ?`, [sid, currentMonth(), baseId, currentMonth(), props.itemId]);
        const item = rows[0];
        if (!item) { toast('This expense no longer exists', 'error'); emit('close'); return; }
        original = { amount: '', recurrence: item.recurrence };
        form.value = {
          name: item.name, alias: item.alias || '', company: item.company || '',
          charge_label: item.charge_label || '', category_id: item.category_id,
          subcategory_id: item.subcategory_id ?? null,
          formula: item.formula || '', entryMode: item.formula ? 'formula' : 'manual',
          amount: item.cur_amount ? (chargeFromMonthly(item.cur_amount, item.recurrence) / 100).toFixed(2) : '',
          recurrence: item.recurrence, renewal_day: item.renewal_day,
          start_month: item.start_month || '', end_month: item.end_month || '',
          notes: item.notes || '',
        };
        original.amount = form.value.amount;
        const vals = await query(`
          SELECT m.month, COALESCE(sv.amount, bv.amount) AS amount
          FROM (${months.value.map(m => `SELECT '${m}' AS month`).join(' UNION ALL ')}) m
          LEFT JOIN expense_values sv ON sv.expense_item_id = ? AND sv.scenario_id = ? AND sv.month = m.month
          LEFT JOIN expense_values bv ON bv.expense_item_id = ? AND bv.scenario_id = ? AND bv.month = m.month AND sv.id IS NULL
        `, [props.itemId, sid, props.itemId, baseId]);
        const map = {};
        vals.forEach(v => { map[v.month] = v.amount != null ? (v.amount / 100).toFixed(2) : ''; });
        editValues.value = map;
      } catch (e) {
        toast('Failed to load expense: ' + e.message, 'error');
      } finally {
        loading.value = false;
      }
    });

    const autoAlias = () => {
      if (!editing.value) form.value.alias = form.value.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    };
    const onCategoryChange = () => {
      if (!subOptions.value.some(o => o.value === form.value.subcategory_id)) form.value.subcategory_id = null;
    };

    const save = async () => {
      const f = form.value;
      if (!f.name || !f.category_id) { toast('Name and category are required', 'error'); return; }
      saving.value = true;
      try {
        const formulaVal = f.entryMode === 'formula' ? f.formula : null;
        const sub = f.subcategory_id || null;
        if (editing.value) {
          await execute(`UPDATE expense_items SET name=?, alias=?, company=?, charge_label=?, category_id=?,
            formula=?, recurrence=?, renewal_day=?, start_month=?, end_month=?, notes=? WHERE id=?`,
            [f.name, f.alias, f.company || null, f.charge_label || null, f.category_id,
             formulaVal, f.recurrence, f.renewal_day || null, f.start_month || null, f.end_month || null, f.notes || null, props.itemId]);
          if (hasSubcategories.value) await execute('UPDATE expense_items SET subcategory_id=? WHERE id=?', [sub, props.itemId]);
          // A new amount or recurrence rewrites the forecast from this month on, keeping past months and actuals
          const toCents = a => (a === '' || a == null ? null : Math.round(parseFloat(a) * 100));
          const cents = toCents(f.amount);
          const changed = cents !== toCents(original?.amount) || f.recurrence !== original?.recurrence;
          if (f.entryMode === 'manual' && changed) {
            if (cents !== null && !Number.isNaN(cents)) {
              await respreadExpense(props.itemId, scenarioId.value, cents, f.recurrence,
                f.start_month || null, f.end_month || null, dateRange.value?.end);
            }
          }
        } else {
          const res = await execute(`INSERT INTO expense_items (name, alias, company, charge_label, category_id,
            formula, recurrence, renewal_day, start_month, end_month, notes) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
            [f.name, f.alias, f.company || null, f.charge_label || null, f.category_id,
             formulaVal, f.recurrence, f.renewal_day || null, f.start_month || null, f.end_month || null, f.notes || null]);
          const itemId = res.lastInsertRowid;
          if (itemId && sub) await execute('UPDATE expense_items SET subcategory_id=? WHERE id=?', [sub, itemId]);
          // For manual entry, seed values across the date range
          if (itemId && f.entryMode === 'manual' && f.amount) {
            const cents = Math.round(parseFloat(f.amount) * 100);
            const start = f.start_month || dateRange.value.start;
            const end = f.end_month || forecastEnd(dateRange.value.end);
            for (const v of expenseMonthlyValues(cents, f.recurrence, start, end)) {
              await execute('INSERT OR REPLACE INTO expense_values (expense_item_id, scenario_id, month, amount, is_actual) VALUES (?,?,?,?,0)',
                [itemId, scenarioId.value, v.month, v.amount]);
            }
          }
        }
        toast(editing.value ? 'Expense updated' : 'Expense created', 'success');
        emit('saved');
        emit('close');
      } catch (e) {
        toast('Save failed: ' + e.message, 'error');
      } finally {
        saving.value = false;
      }
    };

    const saveCellValue = async (month, val) => {
      try {
        const cents = Math.round(parseFloat(val || 0) * 100);
        await execute('INSERT OR REPLACE INTO expense_values (expense_item_id, scenario_id, month, amount, is_actual) VALUES (?,?,?,?,0)',
          [props.itemId, scenarioId.value, month, cents]);
        emit('saved');
      } catch (e) {
        toast('Save failed: ' + e.message, 'error');
      }
    };

    return {
      INPUT, loading, saving, editing, form, editValues, months, subOptions, hasSubcategories,
      autoAlias, onCategoryChange, save, saveCellValue, monthLabel, emit,
    };
  },
  template: `
    <div class="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-2 md:p-4" @click.self="emit('close')" @keydown.esc="emit('close')">
      <div class="bg-white rounded-xl w-full max-w-2xl max-h-[95vh] md:max-h-[90vh] overflow-y-auto p-4 md:p-6" role="dialog" aria-modal="true">
        <h2 class="text-lg font-semibold text-gray-900 mb-4">{{ editing ? 'Edit' : 'Add' }} Expense</h2>
        <div v-if="loading && editing" class="text-gray-400 py-8 text-center">Loading...</div>
        <template v-else>
          <div class="grid grid-cols-2 gap-4">
            <div>
              <label class="block text-xs font-medium text-gray-500 mb-1">Name *</label>
              <input v-model="form.name" @input="autoAlias" :class="INPUT"/>
            </div>
            <div>
              <label class="block text-xs font-medium text-gray-500 mb-1">Alias</label>
              <input v-model="form.alias" :class="INPUT + ' font-mono'"/>
            </div>
            <div>
              <label class="block text-xs font-medium text-gray-500 mb-1">Company</label>
              <input v-model="form.company" :class="INPUT"/>
            </div>
            <div>
              <label class="block text-xs font-medium text-gray-500 mb-1">Charge Label</label>
              <input v-model="form.charge_label" :class="INPUT" placeholder="As it appears on the bank statement"/>
            </div>
            <div>
              <label class="block text-xs font-medium text-gray-500 mb-1">Category *</label>
              <select v-model.number="form.category_id" @change="onCategoryChange" :class="INPUT">
                <option v-for="c in categories" :key="c.id" :value="c.id">{{ c.name }}</option>
              </select>
            </div>
            <div>
              <label class="block text-xs font-medium text-gray-500 mb-1">Sub-category</label>
              <select v-model="form.subcategory_id" :class="INPUT" :disabled="!hasSubcategories">
                <option v-for="o in subOptions" :key="String(o.value)" :value="o.value">{{ o.label }}</option>
              </select>
            </div>
            <div>
              <label class="block text-xs font-medium text-gray-500 mb-1">Recurrence</label>
              <select v-model="form.recurrence" :class="INPUT">
                <option value="monthly">Monthly</option>
                <option value="quarterly">Quarterly</option>
                <option value="annual">Annual</option>
                <option value="one_time">One-time</option>
              </select>
            </div>
            <div>
              <label class="block text-xs font-medium text-gray-500 mb-1">Renewal Day</label>
              <input v-model.number="form.renewal_day" type="number" min="1" max="31" :class="INPUT"/>
            </div>
            <div>
              <label class="block text-xs font-medium text-gray-500 mb-1">Entry Mode</label>
              <div class="flex gap-2 mt-1">
                <button @click="form.entryMode = 'manual'" :class="['px-3 py-1.5 text-xs rounded-lg border', form.entryMode === 'manual' ? 'bg-indigo-50 border-indigo-300 text-indigo-700' : 'border-gray-200 text-gray-500']">Manual</button>
                <button @click="form.entryMode = 'formula'" :class="['px-3 py-1.5 text-xs rounded-lg border', form.entryMode === 'formula' ? 'bg-indigo-50 border-indigo-300 text-indigo-700' : 'border-gray-200 text-gray-500']">Formula</button>
              </div>
            </div>
            <div v-if="form.entryMode === 'manual'">
              <label class="block text-xs font-medium text-gray-500 mb-1">Amount per charge</label>
              <input v-model="form.amount" type="number" step="0.01" placeholder="0.00" :class="INPUT"/>
            </div>
            <div v-if="form.entryMode === 'formula'">
              <label class="block text-xs font-medium text-gray-500 mb-1">Formula</label>
              <input v-model="form.formula" placeholder="e.g. customers.total * 5" :class="INPUT + ' font-mono'"/>
            </div>
            <div>
              <label class="block text-xs font-medium text-gray-500 mb-1">Start Month</label>
              <input v-model="form.start_month" type="month" :class="INPUT"/>
              <p v-if="form.recurrence === 'annual' || form.recurrence === 'quarterly'" class="text-[11px] text-gray-400 mt-1">The month of the first charge; renewals follow every {{ form.recurrence === 'annual' ? '12' : '3' }} months.</p>
            </div>
            <div>
              <label class="block text-xs font-medium text-gray-500 mb-1">End Month</label>
              <input v-model="form.end_month" type="month" :class="INPUT"/>
            </div>
            <div class="col-span-2">
              <label class="block text-xs font-medium text-gray-500 mb-1">Notes</label>
              <textarea v-model="form.notes" rows="2" :class="INPUT"></textarea>
            </div>
          </div>

          <div v-if="editing && form.entryMode === 'manual'" class="mt-4">
            <label class="block text-xs font-medium text-gray-500 mb-2">Monthly Values (saved as you leave each cell)</label>
            <div class="overflow-x-auto border border-gray-200 rounded-lg">
              <table class="text-xs">
                <thead>
                  <tr class="bg-gray-50">
                    <th v-for="m in months" :key="m" class="px-2 py-1.5 text-center font-medium text-gray-500 whitespace-nowrap">{{ monthLabel(m) }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td v-for="m in months" :key="m" class="px-1 py-1">
                      <input :value="editValues[m] || ''"
                        @blur="e => { if (e.target.value !== (editValues[m] || '')) { editValues[m] = e.target.value; saveCellValue(m, e.target.value); } }"
                        type="number" step="0.01"
                        class="w-20 px-1.5 py-1 text-xs text-right border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-indigo-400"/>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <div class="flex justify-end gap-3 mt-6">
            <button @click="emit('close')" class="px-4 py-2 text-sm border border-gray-200 rounded-lg hover:bg-gray-50">Cancel</button>
            <button @click="save" :disabled="saving" class="px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50">
              {{ saving ? 'Saving...' : (editing ? 'Update' : 'Create') }}
            </button>
          </div>
        </template>
      </div>
    </div>
  `,
};
