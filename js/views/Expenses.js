import { query, execute } from '../db.js';
import { getBaseScenarioId } from '../schema.js';
import { formatCents, monthLabel, generateMonthRange, currentMonth, ordinalDay } from '../utils.js';
import {
  loadCategoryLookups, categoryOptions, subcategoryOptions, RECURRENCE_OPTIONS, recurrenceLabel, updateExpenseField,
} from '../expenses.js';
import ExpenseModal from '../../components/ExpenseModal.js';
import { loadScenarioEmployees, employeeCost, isEmployedIn, payrollCategory } from '../payroll.js';
import { donutConfig, trendConfig } from '../miniCharts.js';

export default {
  name: 'ExpensesView',
  components: { ExpenseModal },
  setup() {
    const { ref, computed, onMounted, watch, inject, nextTick } = Vue;
    const scenarioId = inject('scenarioId');
    const dateRange = inject('dateRange');
    const settings = inject('settings');
    const toast = inject('toast');

    const items = ref([]);
    const categories = ref([]);
    const subcategories = ref([]);
    const loading = ref(true);
    const search = ref('');
    const categoryFilter = ref('');
    // Expense form: closed, or open on an expense id (null = new expense)
    const modalOpen = ref(false);
    const modalItemId = ref(null);
    const deleteTarget = ref(null);
    const includePayroll = ref(true);
    const employees = ref([]);
    const monthlyExpenses = ref({});
    const spentInRange = ref(new Set());
    const showAll = ref(false);
    const sortCol = ref(null);
    const sortAsc = ref(true);

    const months = computed(() => {
      if (!dateRange.value) return [];
      return generateMonthRange(dateRange.value.start, dateRange.value.end);
    });

    // --- Data loading ---
    const loadCategories = async () => {
      const lookups = await loadCategoryLookups();
      categories.value = lookups.categories;
      subcategories.value = lookups.subcategories;
    };

    const loadItems = async () => {
      // Only the first load shows the spinner; reloads after an edit keep the table in place
      if (!items.value.length) loading.value = true;
      try {
        const sid = scenarioId.value;
        const baseId = await getBaseScenarioId();
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
      const baseId = await getBaseScenarioId();
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
      const spent = new Set();
      Object.values(byKey).forEach(r => {
        totals[r.month] = (totals[r.month] || 0) + r.amount;
        if (r.amount) spent.add(r.expense_item_id);
      });
      monthlyExpenses.value = totals;
      spentInRange.value = spent;
    };

    const load = async () => {
      await Promise.all([loadCategories(), loadItems(), loadEmployees(), loadMonthly()]);
    };
    onMounted(load);
    watch([scenarioId, dateRange], load, { deep: true });

    // --- Filtered rows ---
    // Current during the viewed period: its start/end months overlap the range (a one-time expense: its month is in it)
    const isCurrent = (r) => {
      const { start, end } = dateRange.value;
      if (r.recurrence === 'one_time') return !r.start_month || (r.start_month >= start && r.start_month <= end);
      return (!r.start_month || r.start_month <= end) && (!r.end_month || r.end_month >= start);
    };
    // Hidden by default: not current and no non-zero value anywhere in the viewed period
    const isRelevant = (r) => isCurrent(r) || spentInRange.value.has(r.id);
    const hiddenCount = computed(() => items.value.filter(r => !isRelevant(r)).length);

    const subName = r => subcategories.value.find(sc => sc.id === r.subcategory_id)?.name || '';
    const sortValue = {
      name: r => (r.name || '').toLowerCase(),
      category: r => (r.category_name || '').toLowerCase(),
      subcategory: r => subName(r).toLowerCase(),
      budget: r => r.cur_amount || 0,
      renewal: r => r.renewal_day,
      recurrence: r => ({ monthly: 1, quarterly: 2, annual: 3, one_time: 4 }[r.recurrence] || 9),
      period: r => r.start_month || '',
    };
    const toggleSort = (col) => {
      if (sortCol.value === col) sortAsc.value = !sortAsc.value;
      else { sortCol.value = col; sortAsc.value = true; }
    };

    const filtered = computed(() => {
      let list = showAll.value ? items.value : items.value.filter(isRelevant);
      const [kind, fid] = categoryFilter.value.split(':');
      if (kind === 'c') list = list.filter(r => r.category_id === Number(fid));
      if (kind === 's') list = list.filter(r => r.subcategory_id === Number(fid));
      if (search.value) {
        const q = search.value.toLowerCase();
        list = list.filter(r =>
          (r.name || '').toLowerCase().includes(q) ||
          (r.company || '').toLowerCase().includes(q) ||
          (r.charge_label || '').toLowerCase().includes(q)
        );
      }
      if (!sortCol.value) return list;
      const get = sortValue[sortCol.value];
      const dir = sortAsc.value ? 1 : -1;
      return [...list].sort((a, b) => {
        const va = get(a), vb = get(b);
        // Empty values always go last, whichever the direction
        if (va == null || va === '') return vb == null || vb === '' ? 0 : 1;
        if (vb == null || vb === '') return -1;
        const cmp = typeof va === 'number' ? va - vb : String(va).localeCompare(String(vb));
        return (cmp || (a.name || '').localeCompare(b.name || '')) * dir;
      });
    });

    const columns = [
      { key: 'name', label: 'Expense', align: 'left' },
      { key: 'category', label: 'Category', align: 'left' },
      { key: 'subcategory', label: 'Sub-category', align: 'left' },
      { key: 'budget', label: 'Budget', align: 'right' },
      { key: 'renewal', label: 'Renewal', align: 'left' },
      { key: 'recurrence', label: 'Recurrence', align: 'left' },
      { key: 'period', label: 'Period', align: 'left' },
    ];

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

    // --- Expense form and inline edits ---
    const openAdd = () => { modalItemId.value = null; modalOpen.value = true; };
    const openEdit = (item) => { modalItemId.value = item.id; modalOpen.value = true; };

    const catOptions = computed(() => categoryOptions(categories.value));
    const subOptionsFor = row => subcategoryOptions(subcategories.value, row.category_id);
    const hasSubcategories = computed(() => subcategories.value.length > 0);

    // Saves one cell and updates the row in place, so the table doesn't reload or jump
    const saveField = async (row, field, value) => {
      try {
        await updateExpenseField(row, field, value, subcategories.value);
        if (field === 'category_id') {
          const cat = categories.value.find(c => c.id === Number(value));
          const sub = subcategories.value.find(sc => sc.id === row.subcategory_id);
          row.category_id = Number(value);
          row.category_name = cat?.name || row.category_name;
          if (sub && sub.category_id !== row.category_id) row.subcategory_id = null;
        } else if (field === 'subcategory_id') {
          row.subcategory_id = value === null || value === '' ? null : Number(value);
        } else {
          row[field] = value;
        }
        toast('Saved', 'success');
      } catch (e) {
        toast('Save failed: ' + e.message, 'error');
      }
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
      items, categories, subcategories, loading, search, categoryFilter, filtered,
      modalOpen, modalItemId, months, deleteTarget, load,
      includePayroll, currentPayroll, monthlyTotal, categoryDonut, expensesTrend,
      showAll, hiddenCount, columns, sortCol, sortAsc, toggleSort,
      openAdd, openEdit, confirmDelete, saveField, catOptions, subOptionsFor, subName, hasSubcategories,
      RECURRENCE_OPTIONS, recurrenceLabel, formatCents, monthLabel, ordinalDay,
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
        <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div class="bg-white rounded-xl border border-gray-200 p-5">
            <span class="text-xs font-medium text-gray-500 uppercase tracking-wider">Monthly Expenses</span>
            <div class="text-2xl font-bold text-gray-900 mt-2">{{ formatCents(monthlyTotal) }}</div>
            <div class="text-xs text-gray-400 mt-1">{{ includePayroll ? 'Incl. ' + formatCents(currentPayroll) + ' payroll' : 'Excl. payroll' }}</div>
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

        <!-- Search -->
        <div class="flex items-center gap-4">
          <div class="relative flex-1">
            <i data-lucide="search" class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400"></i>
            <input v-model="search" type="text" placeholder="Search expenses..." class="w-full pl-10 pr-4 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"/>
          </div>
          <select v-model="categoryFilter" aria-label="Filter by category" class="text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500 max-w-[16rem]">
            <option value="">All categories</option>
            <template v-for="c in categories" :key="c.id">
              <option :value="'c:' + c.id">{{ c.name }}</option>
              <option v-for="sc in subcategories.filter(x => x.category_id === c.id)" :key="sc.id" :value="'s:' + sc.id">&nbsp;&nbsp;&nbsp;{{ sc.name }}</option>
            </template>
          </select>
          <button v-if="hiddenCount || showAll" @click="showAll = !showAll" class="text-sm text-indigo-600 hover:text-indigo-800 whitespace-nowrap"
            title="Expenses not current during the viewed period and with no spend in it">
            {{ showAll ? 'Hide ' + hiddenCount + ' not current' : 'Show ' + hiddenCount + ' not current' }}
          </button>
        </div>

        <!-- Table -->
        <div class="bg-white rounded-xl border border-gray-200 overflow-x-auto">
          <table class="w-full text-sm">
            <thead>
              <tr class="bg-gray-50 border-b border-gray-200">
                <th v-for="col in columns" :key="col.key"
                  :aria-sort="sortCol === col.key ? (sortAsc ? 'ascending' : 'descending') : 'none'"
                  :class="['px-4 py-3 text-xs font-medium uppercase', col.align === 'right' ? 'text-right' : 'text-left']">
                  <button @click="toggleSort(col.key)" class="inline-flex items-center gap-1 uppercase select-none hover:text-gray-700"
                    :class="sortCol === col.key ? 'text-gray-900' : 'text-gray-500'">
                    {{ col.label }}<span class="w-3 text-[10px]">{{ sortCol === col.key ? (sortAsc ? '\u25B2' : '\u25BC') : '' }}</span>
                  </button>
                </th>
                <th class="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Actions</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-100">
              <tr v-for="row in filtered" :key="row.id" class="hover:bg-gray-50">
                <td class="px-4 py-3 min-w-[15rem]">
                  <div class="flex items-center gap-2 flex-wrap">
                    <inline-edit :value="row.name" @save="v => saveField(row, 'name', v)">
                      <span class="font-medium text-gray-900" :title="row.charge_label ? 'Charge label: ' + row.charge_label : ''">{{ row.name }}</span>
                    </inline-edit>
                    <span v-if="row.company" class="inline-flex items-center px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 text-xs whitespace-nowrap">{{ row.company }}</span>
                  </div>
                  <div v-if="row.charge_label" class="text-xs text-gray-400 mt-0.5 truncate max-w-[18rem]" :title="row.charge_label">{{ row.charge_label }}</div>
                </td>
                <td class="px-4 py-3 text-gray-600 whitespace-nowrap">
                  <inline-edit :value="row.category_id" :options="catOptions" :display="row.category_name" @save="v => saveField(row, 'category_id', v)"/>
                </td>
                <td class="px-4 py-3 text-gray-600 whitespace-nowrap">
                  <inline-edit :value="row.subcategory_id" :options="subOptionsFor(row)" :display="subName(row)" placeholder="None"
                    :disabled="!hasSubcategories" disabled-title="Sub-categories are not set up on this database yet"
                    @save="v => saveField(row, 'subcategory_id', v)"/>
                </td>
                <td class="px-4 py-3 text-right text-gray-900">
                  <span class="inline-flex items-center gap-1">
                    <i v-if="row.is_formula" data-lucide="function-square" class="w-3 h-3 text-indigo-400"></i>
                    {{ formatCents(row.cur_amount) }}
                  </span>
                </td>
                <td class="px-4 py-3 text-gray-600">{{ ordinalDay(row.renewal_day) }}</td>
                <td class="px-4 py-3 text-gray-600 whitespace-nowrap">
                  <inline-edit :value="row.recurrence" :options="RECURRENCE_OPTIONS" :display="recurrenceLabel(row.recurrence)" @save="v => saveField(row, 'recurrence', v)"/>
                </td>
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
                <td colspan="8" class="px-4 py-8 text-center text-gray-400">No expenses found</td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>

      <expense-modal v-if="modalOpen" :item-id="modalItemId" :categories="categories" :subcategories="subcategories"
        @close="modalOpen = false" @saved="load"/>

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
