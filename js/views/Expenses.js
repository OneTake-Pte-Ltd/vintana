import { query, execute } from '../db.js';
import {
  formatCents, monthLabel, generateMonthRange, currentMonth, ordinalDay,
  chargeFromMonthly, expenseMonthlyValues, forecastEnd, isChargeMonth,
} from '../utils.js';
import { loadScenarioEmployees, employeeCost, isEmployedIn, payrollCategory } from '../payroll.js';
import { donutConfig, trendConfig } from '../miniCharts.js';

export default {
  name: 'ExpensesView',
  setup() {
    const { ref, computed, onMounted, watch, inject, nextTick } = Vue;
    const scenarioId = inject('scenarioId');
    const dateRange = inject('dateRange');
    const settings = inject('settings');
    const toast = inject('toast');

    const items = ref([]);
    const categories = ref([]);
    const loading = ref(true);
    const search = ref('');
    const showModal = ref(false);
    const editingItem = ref(null);
    const deleteTarget = ref(null);
    const saving = ref(false);
    const includePayroll = ref(true);
    const employees = ref([]);
    const monthlyExpenses = ref({});

    const months = computed(() => {
      if (!dateRange.value) return [];
      return generateMonthRange(dateRange.value.start, dateRange.value.end);
    });

    const blankForm = () => ({
      name: '', alias: '', company: '', charge_label: '',
      category_id: null, formula: '', entryMode: 'manual', amount: '',
      recurrence: 'monthly', renewal_day: null,
      start_month: dateRange.value?.start || '', end_month: '', notes: '',
    });
    const form = ref(blankForm());
    const editValues = ref({});

    // --- Data loading ---
    const loadCategories = async () => {
      categories.value = await query('SELECT * FROM expense_categories ORDER BY sort_order');
    };

    const loadItems = async () => {
      loading.value = true;
      try {
        const sid = scenarioId.value;
        const baseRows = await query('SELECT id FROM scenarios WHERE is_base = 1 LIMIT 1');
        const baseId = baseRows[0]?.id || 1;
        const rows = await query(`
          SELECT ei.*, ec.name AS category_name,
            COALESCE(sv.amount, bv.amount, 0) AS cur_amount,
            CASE WHEN ei.formula IS NOT NULL AND ei.formula != '' THEN 1 ELSE 0 END AS is_formula
          FROM expense_items ei
          JOIN expense_categories ec ON ec.id = ei.category_id
          LEFT JOIN expense_values sv ON sv.expense_item_id = ei.id AND sv.scenario_id = ? AND sv.month = ?
          LEFT JOIN expense_values bv ON bv.expense_item_id = ei.id AND bv.scenario_id = ? AND bv.month = ?
          WHERE ei.visible = 1
          ORDER BY ec.sort_order, ei.name
        `, [sid, currentMonth(), baseId, currentMonth()]);
        items.value = rows;
      } catch (e) {
        toast('Failed to load expenses: ' + e.message, 'error');
      } finally {
        loading.value = false;
      }
    };

    const loadEmployees = async () => {
      try { employees.value = (await loadScenarioEmployees(scenarioId.value)).employees; }
      catch (e) { toast('Failed to load payroll: ' + e.message, 'error'); }
    };

    // Expense total per month over the visible range; a scenario value replaces the base value
    const loadMonthly = async () => {
      if (!months.value.length) return;
      const sid = scenarioId.value;
      const baseRows = await query('SELECT id FROM scenarios WHERE is_base = 1 LIMIT 1');
      const baseId = baseRows[0]?.id || 1;
      const rows = await query(`
        SELECT ev.expense_item_id, ev.month, ev.amount, ev.scenario_id
        FROM expense_values ev
        JOIN expense_items ei ON ei.id = ev.expense_item_id AND ei.visible = 1
        WHERE ev.scenario_id IN (?, ?) AND ev.month >= ? AND ev.month <= ?
      `, [sid, baseId, dateRange.value.start, dateRange.value.end]);
      const byKey = {};
      rows.forEach(r => {
        const k = `${r.expense_item_id}:${r.month}`;
        if (!byKey[k] || r.scenario_id === sid) byKey[k] = r;
      });
      const totals = {};
      Object.values(byKey).forEach(r => { totals[r.month] = (totals[r.month] || 0) + r.amount; });
      monthlyExpenses.value = totals;
    };

    const load = async () => {
      await loadCategories();
      await Promise.all([loadItems(), loadEmployees(), loadMonthly()]);
    };
    onMounted(load);
    watch([scenarioId, dateRange], load, { deep: true });

    // --- Filtered rows ---
    const filtered = computed(() => {
      if (!search.value) return items.value;
      const q = search.value.toLowerCase();
      return items.value.filter(r =>
        (r.name || '').toLowerCase().includes(q) ||
        (r.company || '').toLowerCase().includes(q) ||
        (r.charge_label || '').toLowerCase().includes(q)
      );
    });

    // --- KPI cards ---
    const catColors = { 'Cost of Goods Sold (COGS)': '#6366f1', 'Research & Development': '#8b5cf6', 'Sales & Marketing': '#ec4899', 'General & Administrative': '#f59e0b', 'Uncategorized / Other': '#94a3b8' };
    // Short names keep the donut legend inside its card
    const catShort = { 'Cost of Goods Sold (COGS)': 'COGS', 'Research & Development': 'R&D', 'Sales & Marketing': 'S&M', 'General & Administrative': 'G&A', 'Uncategorized / Other': 'Other' };

    const payrollIn = (month) => employees.value
      .filter(e => isEmployedIn(e, month))
      .reduce((s, e) => s + employeeCost(e), 0);
    const currentPayroll = computed(() => payrollIn(currentMonth()));

    const categoryTotals = computed(() => {
      const totals = {};
      items.value.forEach(i => {
        const cat = i.category_name || 'Uncategorized / Other';
        totals[cat] = (totals[cat] || 0) + (i.cur_amount || 0);
      });
      if (includePayroll.value) {
        const deptMap = settings.value?.dept_mapping;
        employees.value.filter(e => isEmployedIn(e, currentMonth())).forEach(e => {
          const cat = payrollCategory(e.department, deptMap);
          totals[cat] = (totals[cat] || 0) + employeeCost(e);
        });
      }
      return totals;
    });

    const monthlyTotal = computed(() => Object.values(categoryTotals.value).reduce((a, b) => a + b, 0));

    const categoryDonut = computed(() => {
      const order = categories.value.map(c => c.name);
      const labels = Object.keys(categoryTotals.value)
        .filter(l => categoryTotals.value[l] > 0)
        .sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
      return donutConfig(labels.map(l => catShort[l] || l), labels.map(l => categoryTotals.value[l]), labels.map(l => catColors[l] || '#94a3b8'));
    });

    const expensesTrend = computed(() => trendConfig(
      months.value.map(monthLabel),
      months.value.map(m => (monthlyExpenses.value[m] || 0) + (includePayroll.value ? payrollIn(m) : 0)),
      'Total Expenses',
    ));

    // --- Upcoming renewals ---
    const renewals = computed(() => {
      const today = new Date();
      const in30 = new Date(today.getTime() + 30 * 86400000);
      return items.value
        .filter(i => i.renewal_day && i.recurrence !== 'one_time')
        .map(i => {
          let d = new Date(today.getFullYear(), today.getMonth(), i.renewal_day);
          if (d < today) d = new Date(today.getFullYear(), today.getMonth() + 1, i.renewal_day);
          const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
          return { ...i, renewalDate: d, renewalMonth: month, chargeAmount: chargeFromMonthly(i.cur_amount || 0, i.recurrence) };
        })
        .filter(i => i.renewalDate <= in30 && isChargeMonth(i.recurrence, i.start_month, i.renewalMonth))
        .sort((a, b) => a.renewalDate - b.renewalDate);
    });

    const renewalsTotal = computed(() => renewals.value.reduce((s, r) => s + r.chargeAmount, 0));

    const fmtDate = (d) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

    // --- Modal ---
    const openAdd = () => {
      editingItem.value = null;
      form.value = blankForm();
      if (categories.value.length) form.value.category_id = categories.value[0].id;
      showModal.value = true;
    };

    const openEdit = async (item) => {
      editingItem.value = item;
      form.value = {
        name: item.name, alias: item.alias || '', company: item.company || '',
        charge_label: item.charge_label || '', category_id: item.category_id,
        formula: item.formula || '', entryMode: item.formula ? 'formula' : 'manual',
        amount: item.cur_amount ? (chargeFromMonthly(item.cur_amount, item.recurrence) / 100).toFixed(2) : '',
        recurrence: item.recurrence, renewal_day: item.renewal_day,
        start_month: item.start_month || '', end_month: item.end_month || '',
        notes: item.notes || '',
      };
      // Load monthly values for the spreadsheet
      const sid = scenarioId.value;
      const baseRows = await query('SELECT id FROM scenarios WHERE is_base = 1 LIMIT 1');
      const baseId = baseRows[0]?.id || 1;
      const vals = await query(`
        SELECT m.month, COALESCE(sv.amount, bv.amount) AS amount
        FROM (${months.value.map(m => `SELECT '${m}' AS month`).join(' UNION ALL ')}) m
        LEFT JOIN expense_values sv ON sv.expense_item_id = ? AND sv.scenario_id = ? AND sv.month = m.month
        LEFT JOIN expense_values bv ON bv.expense_item_id = ? AND bv.scenario_id = ? AND bv.month = m.month AND sv.id IS NULL
      `, [item.id, sid, item.id, baseId]);
      const map = {};
      vals.forEach(v => { map[v.month] = v.amount != null ? (v.amount / 100).toFixed(2) : ''; });
      editValues.value = map;
      showModal.value = true;
    };

    const autoAlias = () => {
      if (!editingItem.value) {
        form.value.alias = form.value.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
      }
    };

    const saveExpense = async () => {
      if (!form.value.name || !form.value.category_id) { toast('Name and category are required', 'error'); return; }
      saving.value = true;
      try {
        const f = form.value;
        const formulaVal = f.entryMode === 'formula' ? f.formula : null;
        if (editingItem.value) {
          await execute(`UPDATE expense_items SET name=?, alias=?, company=?, charge_label=?, category_id=?,
            formula=?, recurrence=?, renewal_day=?, start_month=?, end_month=?, notes=? WHERE id=?`,
            [f.name, f.alias, f.company || null, f.charge_label || null, f.category_id,
             formulaVal, f.recurrence, f.renewal_day || null, f.start_month || null, f.end_month || null, f.notes || null, editingItem.value.id]);
        } else {
          const res = await execute(`INSERT INTO expense_items (name, alias, company, charge_label, category_id,
            formula, recurrence, renewal_day, start_month, end_month, notes) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
            [f.name, f.alias, f.company || null, f.charge_label || null, f.category_id,
             formulaVal, f.recurrence, f.renewal_day || null, f.start_month || null, f.end_month || null, f.notes || null]);
          // For manual entry, seed values across date range
          if (f.entryMode === 'manual' && f.amount) {
            const cents = Math.round(parseFloat(f.amount) * 100);
            const itemId = res.lastInsertRowid;
            if (itemId) {
              const start = f.start_month || dateRange.value.start;
              const end = f.end_month || forecastEnd(dateRange.value.end);
              for (const v of expenseMonthlyValues(cents, f.recurrence, start, end)) {
                await execute('INSERT OR REPLACE INTO expense_values (expense_item_id, scenario_id, month, amount, is_actual) VALUES (?,?,?,?,0)',
                  [itemId, scenarioId.value, v.month, v.amount]);
              }
            }
          }
        }
        showModal.value = false;
        toast(editingItem.value ? 'Expense updated' : 'Expense created', 'success');
        await load();
      } catch (e) {
        toast('Save failed: ' + e.message, 'error');
      } finally {
        saving.value = false;
      }
    };

    const saveCellValue = async (itemId, month, val) => {
      const cents = Math.round(parseFloat(val || 0) * 100);
      await execute('INSERT OR REPLACE INTO expense_values (expense_item_id, scenario_id, month, amount, is_actual) VALUES (?,?,?,?,0)',
        [itemId, scenarioId.value, month, cents]);
    };

    const confirmDelete = async () => {
      if (!deleteTarget.value) return;
      try {
        await execute('DELETE FROM expense_items WHERE id = ?', [deleteTarget.value.id]);
        deleteTarget.value = null;
        toast('Expense deleted', 'success');
        await load();
      } catch (e) {
        toast('Delete failed: ' + e.message, 'error');
      }
    };

    return {
      items, categories, loading, search, filtered, showModal, editingItem,
      form, editValues, saving, months, renewals, deleteTarget,
      includePayroll, currentPayroll, monthlyTotal, categoryDonut, expensesTrend, renewalsTotal,
      openAdd, openEdit, autoAlias, saveExpense, saveCellValue, confirmDelete,
      fmtDate, formatCents, monthLabel, ordinalDay,
    };
  },
  template: `
    <div class="space-y-6">
      <div class="flex items-center justify-between">
        <h1 class="text-2xl font-bold text-gray-900">Expenses</h1>
        <div class="flex items-center gap-4">
          <button @click="includePayroll = !includePayroll" role="switch" :aria-checked="includePayroll" class="flex items-center gap-2 text-sm text-gray-600">
            <span :class="['relative inline-flex h-5 w-9 rounded-full transition-colors', includePayroll ? 'bg-indigo-600' : 'bg-gray-200']">
              <span :class="['absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform', includePayroll ? 'translate-x-4' : '']"></span>
            </span>
            Include payroll
          </button>
          <button @click="openAdd" class="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 transition-colors">
            + Add Expense
          </button>
        </div>
      </div>

      <div v-if="loading" class="text-gray-400 py-12 text-center">Loading...</div>

      <template v-else>
        <!-- KPI cards -->
        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <div class="bg-white rounded-xl border border-gray-200 p-5">
            <span class="text-xs font-medium text-gray-500 uppercase tracking-wider">Monthly Expenses</span>
            <div class="text-2xl font-bold text-gray-900 mt-2">{{ formatCents(monthlyTotal) }}</div>
            <div class="text-xs text-gray-400 mt-1">{{ includePayroll ? 'Incl. ' + formatCents(currentPayroll) + ' payroll' : 'Excl. payroll' }}</div>
          </div>
          <div class="bg-white rounded-xl border border-gray-200 p-5">
            <span class="text-xs font-medium text-gray-500 uppercase tracking-wider">Renewals (Next 30 Days)</span>
            <div class="text-2xl font-bold text-gray-900 mt-2">{{ formatCents(renewalsTotal) }}</div>
            <div class="text-xs text-gray-400 mt-1">{{ renewals.length }} renewal{{ renewals.length !== 1 ? 's' : '' }}</div>
          </div>
          <div class="bg-white rounded-xl border border-gray-200 p-5">
            <span class="text-xs font-medium text-gray-500 uppercase tracking-wider">Cost by Category</span>
            <chart-wrapper v-if="categoryDonut.data.labels.length" type="doughnut" :data="categoryDonut.data" :options="categoryDonut.options" height="160px" class="mt-2"/>
            <p v-else class="text-gray-400 text-sm text-center py-8">No expense data</p>
          </div>
          <div class="bg-white rounded-xl border border-gray-200 p-5">
            <span class="text-xs font-medium text-gray-500 uppercase tracking-wider">Expenses Over Time</span>
            <chart-wrapper v-if="expensesTrend.data.labels.length" type="line" :data="expensesTrend.data" :options="expensesTrend.options" height="160px" class="mt-2"/>
            <p v-else class="text-gray-400 text-sm text-center py-8">No trend data</p>
          </div>
        </div>

        <!-- Upcoming Renewals -->
        <div v-if="renewals.length" class="bg-white rounded-xl border border-gray-200 p-4">
          <h3 class="text-sm font-medium text-gray-500 mb-3">Upcoming Renewals (next 30 days)</h3>
          <div class="divide-y divide-gray-100">
            <div v-for="r in renewals" :key="r.id" class="flex items-center justify-between py-2 text-sm">
              <div>
                <span class="font-medium text-gray-900">{{ r.name }}</span>
                <span v-if="r.company" class="text-gray-400 ml-2">{{ r.company }}</span>
              </div>
              <div class="flex items-center gap-4">
                <span class="text-gray-900">{{ formatCents(r.chargeAmount) }}</span>
                <span class="text-gray-500 text-xs">{{ fmtDate(r.renewalDate) }}</span>
              </div>
            </div>
          </div>
        </div>

        <!-- Search -->
        <div class="relative">
          <i data-lucide="search" class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400"></i>
          <input v-model="search" type="text" placeholder="Search expenses..." class="w-full pl-10 pr-4 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"/>
        </div>

        <!-- Table -->
        <div class="bg-white rounded-xl border border-gray-200 overflow-x-auto">
          <table class="w-full text-sm">
            <thead>
              <tr class="bg-gray-50 border-b border-gray-200">
                <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Expense</th>
                <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Category</th>
                <th class="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Budget</th>
                <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Renewal</th>
                <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Recurrence</th>
                <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Period</th>
                <th class="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Actions</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-100">
              <tr v-for="row in filtered" :key="row.id" class="hover:bg-gray-50">
                <td class="px-4 py-3">
                  <div class="font-medium text-gray-900">{{ row.name }}</div>
                  <div v-if="row.company" class="text-xs text-gray-400">{{ row.company }}</div>
                  <div v-if="row.charge_label" class="text-xs text-gray-400 italic">{{ row.charge_label }}</div>
                </td>
                <td class="px-4 py-3 text-gray-600">{{ row.category_name }}</td>
                <td class="px-4 py-3 text-right text-gray-900">
                  <span class="inline-flex items-center gap-1">
                    <i v-if="row.is_formula" data-lucide="function-square" class="w-3 h-3 text-indigo-400"></i>
                    {{ formatCents(row.cur_amount) }}
                  </span>
                </td>
                <td class="px-4 py-3 text-gray-600">{{ ordinalDay(row.renewal_day) }}</td>
                <td class="px-4 py-3 text-gray-600 capitalize">{{ (row.recurrence || '').replace('_', ' ') }}</td>
                <td class="px-4 py-3 text-gray-500 text-xs">
                  {{ row.start_month ? monthLabel(row.start_month) : '' }}
                  <template v-if="row.start_month"> – </template>
                  {{ row.end_month ? monthLabel(row.end_month) : 'Ongoing' }}
                </td>
                <td class="px-4 py-3 text-right">
                  <button @click.stop="openEdit(row)" class="text-indigo-600 hover:text-indigo-800 text-xs mr-2">Edit</button>
                  <button @click.stop="deleteTarget = row" class="text-red-500 hover:text-red-700 text-xs">Delete</button>
                </td>
              </tr>
              <tr v-if="!filtered.length">
                <td colspan="7" class="px-4 py-8 text-center text-gray-400">No expenses found</td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>

      <!-- Add / Edit Modal -->
      <div v-if="showModal" class="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" @click.self="showModal = false">
        <div class="bg-white rounded-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto p-6">
          <h2 class="text-lg font-semibold text-gray-900 mb-4">{{ editingItem ? 'Edit' : 'Add' }} Expense</h2>
          <div class="grid grid-cols-2 gap-4">
            <div>
              <label class="block text-xs font-medium text-gray-500 mb-1">Name *</label>
              <input v-model="form.name" @input="autoAlias" class="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"/>
            </div>
            <div>
              <label class="block text-xs font-medium text-gray-500 mb-1">Alias</label>
              <input v-model="form.alias" class="w-full px-3 py-2 text-sm font-mono border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"/>
            </div>
            <div>
              <label class="block text-xs font-medium text-gray-500 mb-1">Company</label>
              <input v-model="form.company" class="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"/>
            </div>
            <div>
              <label class="block text-xs font-medium text-gray-500 mb-1">Charge Label</label>
              <input v-model="form.charge_label" class="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"/>
            </div>
            <div>
              <label class="block text-xs font-medium text-gray-500 mb-1">Category *</label>
              <select v-model.number="form.category_id" class="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500">
                <option v-for="c in categories" :key="c.id" :value="c.id">{{ c.name }}</option>
              </select>
            </div>
            <div>
              <label class="block text-xs font-medium text-gray-500 mb-1">Recurrence</label>
              <select v-model="form.recurrence" class="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500">
                <option value="monthly">Monthly</option>
                <option value="quarterly">Quarterly</option>
                <option value="annual">Annual</option>
                <option value="one_time">One-time</option>
              </select>
            </div>
            <div>
              <label class="block text-xs font-medium text-gray-500 mb-1">Entry Mode</label>
              <div class="flex gap-2 mt-1">
                <button @click="form.entryMode = 'manual'" :class="['px-3 py-1.5 text-xs rounded-lg border', form.entryMode === 'manual' ? 'bg-indigo-50 border-indigo-300 text-indigo-700' : 'border-gray-200 text-gray-500']">Manual</button>
                <button @click="form.entryMode = 'formula'" :class="['px-3 py-1.5 text-xs rounded-lg border', form.entryMode === 'formula' ? 'bg-indigo-50 border-indigo-300 text-indigo-700' : 'border-gray-200 text-gray-500']">Formula</button>
              </div>
            </div>
            <div>
              <label class="block text-xs font-medium text-gray-500 mb-1">Renewal Day</label>
              <input v-model.number="form.renewal_day" type="number" min="1" max="31" class="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"/>
            </div>
            <div v-if="form.entryMode === 'manual'" class="col-span-2">
              <label class="block text-xs font-medium text-gray-500 mb-1">Amount per charge (EUR)</label>
              <input v-model="form.amount" type="number" step="0.01" placeholder="0.00" class="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"/>
            </div>
            <div v-if="form.entryMode === 'formula'" class="col-span-2">
              <label class="block text-xs font-medium text-gray-500 mb-1">Formula</label>
              <input v-model="form.formula" placeholder="e.g. customers.total * 5" class="w-full px-3 py-2 text-sm font-mono border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"/>
            </div>
            <div>
              <label class="block text-xs font-medium text-gray-500 mb-1">Start Month</label>
              <input v-model="form.start_month" type="month" class="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"/>
            </div>
            <div>
              <label class="block text-xs font-medium text-gray-500 mb-1">End Month</label>
              <input v-model="form.end_month" type="month" class="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"/>
            </div>
            <div class="col-span-2">
              <label class="block text-xs font-medium text-gray-500 mb-1">Notes</label>
              <textarea v-model="form.notes" rows="2" class="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"></textarea>
            </div>
          </div>

          <!-- Monthly values spreadsheet (edit mode only) -->
          <div v-if="editingItem && form.entryMode === 'manual'" class="mt-4">
            <label class="block text-xs font-medium text-gray-500 mb-2">Monthly Values</label>
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
                      <input
                        :value="editValues[m] || ''"
                        @blur="e => { editValues[m] = e.target.value; saveCellValue(editingItem.id, m, e.target.value); }"
                        type="number" step="0.01"
                        class="w-20 px-1.5 py-1 text-xs text-right border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-indigo-400"
                      />
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <div class="flex justify-end gap-3 mt-6">
            <button @click="showModal = false" class="px-4 py-2 text-sm border border-gray-200 rounded-lg hover:bg-gray-50">Cancel</button>
            <button @click="saveExpense" :disabled="saving" class="px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50">
              {{ saving ? 'Saving...' : (editingItem ? 'Update' : 'Create') }}
            </button>
          </div>
        </div>
      </div>

      <!-- Delete Confirmation -->
      <div v-if="deleteTarget" class="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
        <div class="bg-white rounded-xl p-6 max-w-sm mx-4">
          <h3 class="text-lg font-semibold text-gray-900 mb-2">Delete Expense</h3>
          <p class="text-sm text-gray-600 mb-6">Delete <strong>{{ deleteTarget.name }}</strong>? This will also remove all associated monthly values.</p>
          <div class="flex justify-end gap-3">
            <button @click="deleteTarget = null" class="px-4 py-2 text-sm border border-gray-200 rounded-lg hover:bg-gray-50">Cancel</button>
            <button @click="confirmDelete" class="px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700">Delete</button>
          </div>
        </div>
      </div>
    </div>
  `,
};
