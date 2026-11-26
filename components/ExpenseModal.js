import { query, execute } from '../js/db.js';
import { getBaseScenarioId } from '../js/schema.js';
import {
  monthLabel, generateMonthRange, currentMonth, chargeFromMonthly, formatCents, monthlyShare, expenseMonthlyValues, forecastEnd, MULTI_CHARGE,
} from '../js/utils.js';
import { subcategoryOptions, respreadExpense, applyExpensePeriod } from '../js/expenses.js';
import { formulaContexts, variablesOf, loadBudgetLines, saveBudgetLines, recomputeComputedExpenses } from '../js/budget.js';
import { evalFormulaExact, formulaProblem } from '../js/formula.js';

const INPUT = 'w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500';

// Add or edit an expense. Used by the Expenses, Upcoming Charges and Bank Statements pages.
// `itemId` null = add; `prefill` sets fields of a new expense (e.g. from a bank statement line); `scenarioId` writes a
// new expense's forecast to that scenario instead of the selected one. Emits `saved` after a change, `created` with
// the new expense's id, `lookups-changed` after a category or sub-category is added, and `close` when dismissed.
export default {
  name: 'ExpenseModal',
  props: {
    itemId: { type: Number, default: null },
    categories: { type: Array, default: () => [] },
    subcategories: { type: Array, default: () => [] },
    prefill: { type: Object, default: null },
    scenarioId: { type: Number, default: null },
  },
  emits: ['close', 'saved', 'created', 'lookups-changed'],
  setup(props, { emit }) {
    const { ref, computed, inject, onMounted, watch } = Vue;
    const selectedScenarioId = inject('scenarioId');
    const scenarioId = computed(() => props.scenarioId ?? selectedScenarioId.value);
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
      // A new expense starts this month, renewing on today's date
      recurrence: 'monthly', renewal_day: new Date().getDate(), billing_threshold: '',
      start_month: currentMonth(), end_month: '', notes: '',
      ...(props.prefill || {}),
    });
    const form = ref(blankForm());
    // Switching to or from weekly or threshold billing converts the amount so the monthly cost stays the same (2,000 a month is about
    // 461.54 a week); between the other recurrences the amount per charge stays as typed
    // (a form loaded or reset, a new object, is not a change made by the person)
    watch(() => [form.value, form.value.recurrence], ([f, now], [prevForm, before]) => {
      if (f !== prevForm) return;
      if (!before || now === before || (!MULTI_CHARGE.includes(now) && !MULTI_CHARGE.includes(before))) return;
      if (f.amount === '' || f.amount == null || Number.isNaN(parseFloat(f.amount))) return;
      const monthly = before === 'one_time' ? Math.round(parseFloat(f.amount) * 100) : monthlyShare(Math.round(parseFloat(f.amount) * 100), before);
      f.amount = ((now === 'one_time' ? monthly : chargeFromMonthly(monthly, now)) / 100).toFixed(2);
    });
    // Categories and sub-categories: the ones passed in, plus any added from this form
    const cats = ref([...props.categories]);
    const subs = ref([...props.subcategories]);
    watch(() => props.categories, v => { cats.value = [...v]; });
    watch(() => props.subcategories, v => { subs.value = [...v]; });
    const subOptions = computed(() => subcategoryOptions(subs.value, form.value.category_id));
    const hasSubcategories = computed(() => subs.value.length > 0);

    // --- Adding a category or sub-category without leaving the form ---
    const NEW = '__new__';
    const adding = ref(null); // 'category' | 'subcategory' while its name is being typed
    const newName = ref('');
    const startAdding = what => { adding.value = what; newName.value = ''; };
    const onCategorySelect = e => {
      if (e.target.value === NEW) { e.target.value = String(form.value.category_id ?? ''); startAdding('category'); return; }
      form.value.category_id = Number(e.target.value);
      onCategoryChange();
    };
    const onSubcategorySelect = e => {
      if (e.target.value === NEW) { e.target.value = String(form.value.subcategory_id ?? ''); startAdding('subcategory'); return; }
      form.value.subcategory_id = e.target.value === '' ? null : Number(e.target.value);
    };
    const addLookup = async () => {
      const name = newName.value.trim();
      if (!name) return;
      try {
        if (adding.value === 'category') {
          if (cats.value.some(c => c.name.toLowerCase() === name.toLowerCase())) { toast('That category already exists', 'error'); return; }
          const order = Math.max(0, ...cats.value.map(c => c.sort_order || 0)) + 1;
          const res = await execute('INSERT INTO expense_categories (name, sort_order) VALUES (?, ?)', [name, order]);
          cats.value.push({ id: res.lastInsertRowid, name, sort_order: order });
          form.value.category_id = res.lastInsertRowid;
          form.value.subcategory_id = null;
        } else {
          const catId = form.value.category_id;
          const siblings = subs.value.filter(sc => sc.category_id === catId);
          if (siblings.some(sc => sc.name.toLowerCase() === name.toLowerCase())) { toast('That sub-category already exists in this category', 'error'); return; }
          const order = Math.max(0, ...siblings.map(sc => sc.sort_order || 0)) + 1;
          const res = await execute('INSERT INTO expense_subcategories (category_id, name, sort_order) VALUES (?, ?, ?)', [catId, name, order]);
          subs.value.push({ id: res.lastInsertRowid, category_id: catId, name, sort_order: order,
            category_name: cats.value.find(c => c.id === catId)?.name });
          form.value.subcategory_id = res.lastInsertRowid;
        }
        toast(adding.value === 'category' ? 'Category added' : 'Sub-category added', 'success');
        adding.value = null;
        emit('lookups-changed');
      } catch (e) {
        toast('Add failed: ' + e.message, 'error');
      }
    };

    // --- Formula and budget lines: computed from this month's customers, MRR and payroll (budget.js) ---
    const formulaCtx = ref(null); // null until loaded; formulas are then checked against its names
    const formulaVars = computed(() => variablesOf(formulaCtx.value || {}));
    const budgetLines = ref([]); // [{ name, kind: 'amount' | 'formula', amount (text), formula }]
    const showProblems = ref(false);
    const evalNow = formula => Math.round(evalFormulaExact(formula, formulaCtx.value || {}) * 100);
    const lineNow = l => (l.kind === 'formula' ? evalNow(l.formula) : Math.round((parseFloat(l.amount) || 0) * 100));
    const budgetTotal = computed(() => budgetLines.value.reduce((s, l) => s + lineNow(l), 0));
    const formulaCheck = f => formulaProblem(f, formulaCtx.value ? formulaVars.value : null);
    const lineProblem = l => {
      if (!l.name.trim()) return 'Give this budget line a name.';
      if (l.kind === 'formula') return formulaCheck(l.formula);
      return l.amount === '' || Number.isNaN(parseFloat(l.amount)) ? 'Enter an amount.' : null;
    };
    const addLine = () => budgetLines.value.push({ name: '', kind: 'amount', amount: '', formula: '' });
    const removeLine = i => budgetLines.value.splice(i, 1);
    const linesPayload = () => budgetLines.value.map(l => ({ name: l.name, formula: l.kind === 'formula' ? l.formula : null,
      amount: l.kind === 'formula' ? null : Math.round(parseFloat(l.amount) * 100) }));
    formulaContexts(scenarioId.value, currentMonth(), currentMonth())
      .then(c => { formulaCtx.value = c[currentMonth()] || {}; }).catch(() => { formulaCtx.value = null; });

    const baseScenarioId = getBaseScenarioId;
    // Amount, recurrence and period as loaded, to tell whether the forecast needs rewriting on save
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
        original = { amount: '', recurrence: item.recurrence, start_month: item.start_month || '', end_month: item.end_month || '' };
        form.value = {
          name: item.name, alias: item.alias || '', company: item.company || '',
          charge_label: item.charge_label || '', category_id: item.category_id,
          subcategory_id: item.subcategory_id ?? null,
          formula: item.formula || '', entryMode: item.formula ? 'formula' : 'manual',
          amount: item.cur_amount ? (chargeFromMonthly(item.cur_amount, item.recurrence) / 100).toFixed(2) : '',
          recurrence: item.recurrence, renewal_day: item.renewal_day,
          billing_threshold: item.billing_threshold ? (item.billing_threshold / 100).toFixed(2) : '',
          start_month: item.start_month || '', end_month: item.end_month || '',
          notes: item.notes || '',
        };
        original.amount = form.value.amount;
        const lines = (await loadBudgetLines())[props.itemId] || [];
        budgetLines.value = lines.map(l => ({ name: l.name, kind: l.formula ? 'formula' : 'amount',
          amount: l.formula ? '' : (l.amount / 100).toFixed(2), formula: l.formula || '' }));
        if (lines.length) form.value.entryMode = 'budget';
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

    // Threshold in cents, only for an expense billed at a threshold
    const thresholdCents = f => {
      const c = Math.round(parseFloat(f.billing_threshold) * 100);
      return f.recurrence === 'threshold' && c > 0 ? c : null;
    };

    const save = async () => {
      const f = form.value;
      if (!f.name || !f.category_id) { toast('Name and category are required', 'error'); return; }
      if (f.start_month && f.end_month && f.end_month < f.start_month) { toast('The end month is before the start month', 'error'); return; }
      if (f.recurrence === 'threshold' && !thresholdCents(f)) { toast('Enter the amount at which this provider bills you', 'error'); return; }
      if (f.entryMode === 'budget') {
        showProblems.value = true;
        if (!budgetLines.value.length) { toast('Add at least one budget line, or switch to Manual', 'error'); return; }
        if (budgetLines.value.some(lineProblem)) { toast('Some budget lines need fixing', 'error'); return; }
      }
      if (f.entryMode === 'formula') {
        const p = formulaCheck(f.formula);
        if (p) { toast(p, 'error'); return; }
      }
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
          await execute('UPDATE expense_items SET billing_threshold=? WHERE id=?', [thresholdCents(f), props.itemId]);
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
          // Budget lines are kept only in that mode; a formula or budget lines recompute the forecast in every scenario
          await saveBudgetLines(props.itemId, f.entryMode === 'budget' ? linesPayload() : []);
          if (f.entryMode !== 'manual') await recomputeComputedExpenses([props.itemId]);
          // A new start or end month: forecast values outside the period are removed from the selected scenario, and
          // months it gained are filled with the current amount (a respread above has already filled them)
          if ((f.start_month || '') !== original?.start_month || (f.end_month || '') !== original?.end_month) {
            const fill = f.entryMode === 'manual' && !changed && cents !== null && !Number.isNaN(cents) ? cents : null;
            await applyExpensePeriod(props.itemId, scenarioId.value, {
              start: f.start_month || null, end: f.end_month || null,
              oldStart: original?.start_month || null, oldEnd: original?.end_month || null,
              chargeCents: fill, recurrence: f.recurrence, rangeEnd: dateRange.value?.end,
            });
          }
        } else {
          const res = await execute(`INSERT INTO expense_items (name, alias, company, charge_label, category_id,
            formula, recurrence, renewal_day, start_month, end_month, notes) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
            [f.name, f.alias, f.company || null, f.charge_label || null, f.category_id,
             formulaVal, f.recurrence, f.renewal_day || null, f.start_month || null, f.end_month || null, f.notes || null]);
          const itemId = res.lastInsertRowid;
          if (itemId) emit('created', itemId);
          if (itemId && sub) await execute('UPDATE expense_items SET subcategory_id=? WHERE id=?', [sub, itemId]);
          if (itemId && thresholdCents(f)) await execute('UPDATE expense_items SET billing_threshold=? WHERE id=?', [thresholdCents(f), itemId]);
          if (itemId && f.entryMode === 'budget') await saveBudgetLines(itemId, linesPayload());
          if (itemId && f.entryMode !== 'manual') await recomputeComputedExpenses([itemId]);
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
      INPUT, loading, saving, editing, form, cats, NEW, adding, newName, startAdding, onCategorySelect, onSubcategorySelect, addLookup, editValues, months, subOptions, hasSubcategories, formatCents,
      formulaCtx, formulaVars, budgetLines, budgetTotal, lineNow, lineProblem, showProblems, addLine, removeLine, evalNow, formulaCheck,
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
              <select :value="String(form.category_id ?? '')" @change="onCategorySelect" :class="INPUT" aria-label="Category">
                <option v-for="c in cats" :key="c.id" :value="String(c.id)">{{ c.name }}</option>
                <option :value="NEW">+ New category...</option>
              </select>
            </div>
            <div>
              <label class="block text-xs font-medium text-gray-500 mb-1">Sub-category</label>
              <select :value="form.subcategory_id === null || form.subcategory_id === undefined ? '' : String(form.subcategory_id)" @change="onSubcategorySelect"
                :class="INPUT" :disabled="!hasSubcategories" aria-label="Sub-category">
                <option v-for="o in subOptions" :key="String(o.value)" :value="o.value === null ? '' : String(o.value)">{{ o.label }}</option>
                <option v-if="form.category_id" :value="NEW">+ New sub-category...</option>
              </select>
            </div>
            <div v-if="adding" class="col-span-2 rounded-lg border border-indigo-200 bg-indigo-50/50 p-3">
              <label class="block text-xs font-medium text-gray-700 mb-1">
                {{ adding === 'category' ? 'New category' : 'New sub-category in ' + (cats.find(c => c.id === form.category_id)?.name || 'this category') }}
              </label>
              <div class="flex gap-2">
                <input v-model="newName" @keydown.enter.prevent="addLookup" @keydown.esc.stop="adding = null" :class="INPUT" placeholder="Name"
                  :aria-label="adding === 'category' ? 'New category name' : 'New sub-category name'"/>
                <button type="button" @click="addLookup" :disabled="!newName.trim()" class="px-3 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-40">Add</button>
                <button type="button" @click="adding = null" class="px-3 py-2 text-sm border border-gray-200 rounded-lg hover:bg-gray-50 bg-white">Cancel</button>
              </div>
            </div>
            <div>
              <label class="block text-xs font-medium text-gray-500 mb-1">Recurrence</label>
              <select v-model="form.recurrence" :class="INPUT">
                <option value="weekly">Weekly</option>
                <option value="threshold">Billed at a threshold</option>
                <option value="monthly">Monthly</option>
                <option value="quarterly">Quarterly</option>
                <option value="annual">Annual</option>
                <option value="one_time">One-time</option>
              </select>
            </div>
            <div v-if="form.recurrence === 'threshold'">
              <label class="block text-xs font-medium text-gray-500 mb-1">Billed each time spend reaches</label>
              <input v-model="form.billing_threshold" type="number" step="0.01" min="0" placeholder="e.g. 200" :class="INPUT"/>
              <p class="text-[11px] text-gray-400 mt-1">Charge dates are estimated from the monthly spend: a bigger budget means more frequent charges.</p>
            </div>
            <div v-else>
              <label class="block text-xs font-medium text-gray-500 mb-1">Renewal Day</label>
              <input v-model.number="form.renewal_day" type="number" min="1" max="31" :class="INPUT"/>
            </div>
            <div>
              <label class="block text-xs font-medium text-gray-500 mb-1">Entry Mode</label>
              <div class="flex gap-2 mt-1">
                <button @click="form.entryMode = 'manual'" :class="['px-3 py-1.5 text-xs rounded-lg border', form.entryMode === 'manual' ? 'bg-indigo-50 border-indigo-300 text-indigo-700' : 'border-gray-200 text-gray-500']">Manual</button>
                <button @click="form.entryMode = 'formula'" :class="['px-3 py-1.5 text-xs rounded-lg border', form.entryMode === 'formula' ? 'bg-indigo-50 border-indigo-300 text-indigo-700' : 'border-gray-200 text-gray-500']">Formula</button>
                <button @click="form.entryMode = 'budget'; if (!budgetLines.length) addLine()" :class="['px-3 py-1.5 text-xs rounded-lg border', form.entryMode === 'budget' ? 'bg-indigo-50 border-indigo-300 text-indigo-700' : 'border-gray-200 text-gray-500']"
                  title="Split the budget into lines (fixed amounts or formulas); the expense stays one line for bank statements">Budget lines</button>
              </div>
            </div>
            <div v-if="form.entryMode === 'manual'">
              <label class="block text-xs font-medium text-gray-500 mb-1">{{ form.recurrence === 'threshold' ? 'Monthly spend' : 'Amount per charge' }}</label>
              <input v-model="form.amount" type="number" step="0.01" placeholder="0.00" :class="INPUT"/>
            </div>
            <div v-if="form.entryMode === 'formula'">
              <label class="block text-xs font-medium text-gray-500 mb-1">Formula <span class="font-normal text-gray-400">(amount per charge)</span></label>
              <formula-input v-model="form.formula" :variables="formulaVars"/>
              <p v-if="form.formula && formulaCheck(form.formula)" class="text-[11px] text-red-600 mt-1">{{ formulaCheck(form.formula) }}</p>
              <p v-else-if="form.formula" class="text-[11px] text-gray-500 mt-1">This month: {{ formatCents(evalNow(form.formula)) }}. Recomputed for each month from the forecast.</p>
            </div>
            <div v-if="form.entryMode === 'budget'">
              <label class="block text-xs font-medium text-gray-500 mb-1">{{ form.recurrence === 'threshold' ? 'Monthly spend' : 'Amount per charge' }} <span class="font-normal text-gray-400">(this month)</span></label>
              <div class="px-3 py-2 text-sm rounded-lg bg-gray-50 border border-gray-100 font-semibold text-gray-900 tabular-nums">{{ formatCents(budgetTotal) }}</div>
            </div>
            <div v-if="form.entryMode === 'budget'" class="col-span-2 rounded-lg border border-gray-200 p-3">
              <div class="flex items-baseline justify-between gap-3 flex-wrap mb-2">
                <span class="text-xs font-medium text-gray-700">Budget lines</span>
                <span class="text-[11px] text-gray-400">Fixed amounts, or formulas recomputed each month (e.g. customers.total * 0.4). Bank statements still see one expense.</span>
              </div>
              <div v-for="(l, i) in budgetLines" :key="i" class="mb-2">
                <div class="flex items-start gap-2 flex-wrap sm:flex-nowrap">
                  <input v-model="l.name" placeholder="e.g. Production droplet" :aria-label="'Budget line ' + (i + 1) + ' name'" :class="INPUT + ' sm:flex-1 min-w-[9rem]'"/>
                  <select v-model="l.kind" :aria-label="'Budget line ' + (i + 1) + ' type'" class="px-2 py-2 text-sm border border-gray-200 rounded-lg bg-white">
                    <option value="amount">Amount</option><option value="formula">Formula</option>
                  </select>
                  <input v-if="l.kind === 'amount'" v-model="l.amount" type="number" step="0.01" placeholder="0.00" :aria-label="'Budget line ' + (i + 1) + ' amount'"
                    class="w-28 px-3 py-2 text-sm text-right border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"/>
                  <formula-input v-else v-model="l.formula" :variables="formulaVars" class="flex-1 min-w-[12rem]"/>
                  <span class="w-24 pt-2 text-right text-sm text-gray-700 tabular-nums" :title="l.kind === 'formula' ? 'This month' : ''">{{ formatCents(lineNow(l)) }}</span>
                  <button type="button" @click="removeLine(i)" class="pt-2 text-gray-400 hover:text-red-500" :aria-label="'Remove budget line ' + (i + 1)">
                    <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg>
                  </button>
                </div>
                <p v-if="(showProblems || (l.kind === 'formula' && l.formula)) && lineProblem(l)" class="text-[11px] text-red-600 mt-1">{{ lineProblem(l) }}</p>
              </div>
              <button type="button" @click="addLine" class="text-xs text-indigo-600 hover:text-indigo-800">+ Add budget line</button>
            </div>
            <div>
              <label class="block text-xs font-medium text-gray-500 mb-1">Start Month</label>
              <month-picker v-model="form.start_month" block aria-label="Start month"/>
              <p v-if="form.recurrence === 'annual' || form.recurrence === 'quarterly'" class="text-[11px] text-gray-400 mt-1">The month of the first charge; renewals follow every {{ form.recurrence === 'annual' ? '12' : '3' }} months.</p>
              <p v-else-if="form.recurrence === 'weekly'" class="text-[11px] text-gray-400 mt-1">With the renewal day, the date of the first charge; the next ones follow every 7 days.</p>
            </div>
            <div>
              <label class="block text-xs font-medium text-gray-500 mb-1">End Month</label>
              <month-picker v-model="form.end_month" block clearable placeholder="Ongoing" aria-label="End month"/>
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
