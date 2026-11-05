import { query } from '../db.js';
import { formatCents, monthLabelFull, currentMonth } from '../utils.js';
import { loadScenarioEmployees } from '../payroll.js';
import {
  loadExpenseValues, computeUpcomingCharges, computePayrollCharges, horizonMonth, undatedReason,
} from '../charges.js';
import {
  loadCategoryLookups, categoryOptions, subcategoryOptions, RECURRENCE_OPTIONS, recurrenceLabel, updateExpenseField,
} from '../expenses.js';
import ExpenseModal from '../../components/ExpenseModal.js';

const WINDOWS = [30, 60, 90];
const pref = (key, fallback) => { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } };
const savePref = (key, v) => { try { localStorage.setItem(key, String(v)); } catch { /* storage unavailable */ } };

export default {
  name: 'UpcomingChargesView',
  components: { ExpenseModal },
  setup() {
    const { ref, computed, onMounted, watch, inject } = Vue;
    const router = VueRouter.useRouter();
    const scenarioId = inject('scenarioId');
    const settings = inject('settings');
    const toast = inject('toast');

    const days = ref(WINDOWS.includes(Number(pref('vintana_upcoming_days'))) ? Number(pref('vintana_upcoming_days')) : 30);
    const includePayroll = ref(pref('vintana_upcoming_payroll', '1') !== '0');
    watch(days, d => savePref('vintana_upcoming_days', d));
    watch(includePayroll, v => savePref('vintana_upcoming_payroll', v ? '1' : '0'));

    const items = ref([]);
    const values = ref({});
    const employees = ref([]);
    const categories = ref([]);
    const subcategories = ref([]);
    const loading = ref(true);
    const modalItemId = ref(null);

    const load = async () => {
      if (!scenarioId.value) return;
      if (!items.value.length) loading.value = true;
      try {
        const [rows, vals, emp, lookups] = await Promise.all([
          query(`
            SELECT ei.*, ec.name AS category_name
            FROM expense_items ei JOIN expense_categories ec ON ec.id = ei.category_id
            WHERE ei.visible = 1`),
          loadExpenseValues(scenarioId.value, currentMonth(), horizonMonth(Math.max(...WINDOWS))),
          loadScenarioEmployees(scenarioId.value),
          loadCategoryLookups(),
        ]);
        items.value = rows;
        values.value = vals;
        employees.value = emp.employees;
        categories.value = lookups.categories;
        subcategories.value = lookups.subcategories;
      } catch (e) {
        toast('Failed to load upcoming charges: ' + e.message, 'error');
      } finally {
        loading.value = false;
      }
    };
    onMounted(load);
    watch(scenarioId, load);

    const expenseCharges = computed(() => computeUpcomingCharges(items.value, values.value, days.value));
    const payrollCharges = computed(() => includePayroll.value
      ? computePayrollCharges(employees.value, days.value, settings.value?.payroll_pay_day, settings.value?.dept_mapping)
      : []);
    const allCharges = computed(() => [...expenseCharges.value, ...payrollCharges.value]);

    // --- Sorting: by date (grouped by month) by default, any column on click ---
    const sortCol = ref('date');
    const sortAsc = ref(true);
    const subName = c => (c.kind === 'expense' && subcategories.value.find(s => s.id === c.subcategory_id)?.name) || '';
    const sortValue = {
      date: c => c.date.getTime(),
      name: c => (c.name || '').toLowerCase(),
      category: c => (c.category_name || '').toLowerCase(),
      subcategory: c => subName(c).toLowerCase(),
      recurrence: c => ({ monthly: 1, quarterly: 2, annual: 3, one_time: 4, payroll: 5 }[c.recurrence] || 9),
      amount: c => c.amount,
    };
    const toggleSort = col => {
      if (sortCol.value === col) sortAsc.value = !sortAsc.value;
      else { sortCol.value = col; sortAsc.value = col !== 'amount'; }
    };
    const charges = computed(() => {
      const get = sortValue[sortCol.value];
      const dir = sortAsc.value ? 1 : -1;
      return [...allCharges.value].sort((a, b) => {
        const va = get(a), vb = get(b);
        if (va === '' && vb !== '') return 1;
        if (vb === '' && va !== '') return -1;
        const cmp = typeof va === 'number' ? va - vb : String(va).localeCompare(String(vb));
        return cmp * dir || a.date - b.date || b.amount - a.amount;
      });
    });
    // Month groups only make sense when the list is in date order
    const groups = computed(() => {
      if (sortCol.value !== 'date') return [{ month: null, charges: charges.value, total: null }];
      const out = [];
      for (const c of charges.value) {
        let g = out[out.length - 1];
        if (!g || g.month !== c.month) { g = { month: c.month, charges: [], total: 0 }; out.push(g); }
        g.charges.push(c);
        g.total += c.amount;
      }
      return out;
    });

    const total = computed(() => allCharges.value.reduce((s, c) => s + c.amount, 0));
    const payrollTotal = computed(() => payrollCharges.value.reduce((s, c) => s + c.amount, 0));
    const largest = computed(() => allCharges.value.reduce((best, c) => (!best || c.amount > best.amount ? c : best), null));
    const nextCharge = computed(() => [...allCharges.value].sort((a, b) => a.date - b.date)[0] || null);

    const undated = computed(() => {
      const r = { 'no renewal day': 0, 'no start month': 0, 'no month': 0 };
      items.value.forEach(i => { const why = undatedReason(i); if (why) r[why]++; });
      return r;
    });

    // --- Opening and editing ---
    const open = c => {
      if (c.kind === 'expense') { modalItemId.value = c.id; return; }
      const e = c.employee;
      router.push({ path: '/payroll', query: { edit: e._source === 'scenario' ? 's' + e._scenarioEmployeeId : String(e.id) } });
    };
    const catOptions = computed(() => categoryOptions(categories.value));
    const subOptionsFor = c => subcategoryOptions(subcategories.value, c.category_id);
    const saveField = async (c, field, value) => {
      const item = items.value.find(i => i.id === c.id);
      if (!item) return;
      try {
        await updateExpenseField(item, field, value, subcategories.value);
        await load();
        toast('Saved', 'success');
      } catch (e) {
        toast('Save failed: ' + e.message, 'error');
      }
    };

    const fmtDate = d => d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
    const daysAway = d => {
      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const n = Math.round((d - today) / 864e5);
      return n === 0 ? 'Today' : n === 1 ? 'Tomorrow' : `In ${n} days`;
    };
    const kindLabel = c => c.kind === 'payroll' ? 'Payroll' : recurrenceLabel(c.recurrence);
    const columns = [
      { key: 'date', label: 'Date' },
      { key: 'name', label: 'Charge' },
      { key: 'category', label: 'Category' },
      { key: 'subcategory', label: 'Sub-category' },
      { key: 'recurrence', label: 'Recurrence' },
      { key: 'amount', label: 'Amount', right: true },
    ];

    return {
      WINDOWS, days, includePayroll, loading, charges, groups, total, payrollTotal, largest, nextCharge, undated,
      columns, sortCol, sortAsc, toggleSort, modalItemId, categories, subcategories, catOptions, subOptionsFor, subName,
      open, saveField, load, RECURRENCE_OPTIONS, formatCents, monthLabelFull, fmtDate, daysAway, kindLabel, recurrenceLabel,
    };
  },
  template: `
    <div class="space-y-6">
      <div class="flex items-center justify-between flex-wrap gap-3">
        <h1 class="text-2xl font-bold text-gray-900">Upcoming Charges</h1>
        <div class="flex items-center gap-4 flex-wrap">
          <button @click="includePayroll = !includePayroll" role="switch" :aria-checked="includePayroll" class="flex items-center gap-2 text-sm text-gray-600">
            <span :class="['relative inline-flex h-5 w-9 rounded-full transition-colors', includePayroll ? 'bg-indigo-600' : 'bg-gray-200']">
              <span :class="['absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform', includePayroll ? 'translate-x-4' : '']"></span>
            </span>
            Include payroll
          </button>
          <div class="inline-flex rounded-lg border border-gray-200 bg-white p-0.5" role="group" aria-label="Time window">
            <button v-for="w in WINDOWS" :key="w" @click="days = w" :aria-pressed="days === w"
              :class="['px-3 py-1.5 text-sm rounded-md transition-colors', days === w ? 'bg-indigo-600 text-white' : 'text-gray-600 hover:bg-gray-50']">
              {{ w }} days
            </button>
          </div>
        </div>
      </div>

      <div v-if="loading" class="text-gray-400 py-12 text-center">Loading...</div>

      <template v-else>
        <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div class="bg-white rounded-xl border border-gray-200 p-5">
            <span class="text-xs font-medium text-gray-500 uppercase tracking-wider">Total (next {{ days }} days)</span>
            <div class="text-2xl font-bold text-gray-900 mt-2">{{ formatCents(total) }}</div>
            <div class="text-xs text-gray-400 mt-1">{{ charges.length }} charge{{ charges.length !== 1 ? 's' : '' }}<template v-if="includePayroll">, incl. {{ formatCents(payrollTotal) }} payroll</template></div>
          </div>
          <div class="bg-white rounded-xl border border-gray-200 p-5">
            <span class="text-xs font-medium text-gray-500 uppercase tracking-wider">Next Charge</span>
            <template v-if="nextCharge">
              <div class="text-2xl font-bold text-gray-900 mt-2">{{ formatCents(nextCharge.amount) }}</div>
              <div class="text-xs text-gray-400 mt-1 truncate">{{ nextCharge.name }} · {{ fmtDate(nextCharge.date) }}</div>
            </template>
            <div v-else class="text-sm text-gray-400 mt-3">None</div>
          </div>
          <div class="bg-white rounded-xl border border-gray-200 p-5">
            <span class="text-xs font-medium text-gray-500 uppercase tracking-wider">Largest Charge</span>
            <template v-if="largest">
              <div class="text-2xl font-bold text-gray-900 mt-2">{{ formatCents(largest.amount) }}</div>
              <div class="text-xs text-gray-400 mt-1 truncate">{{ largest.name }} · {{ fmtDate(largest.date) }}</div>
            </template>
            <div v-else class="text-sm text-gray-400 mt-3">None</div>
          </div>
        </div>

        <div class="bg-white rounded-xl border border-gray-200 overflow-x-auto">
          <table class="w-full text-sm">
            <thead>
              <tr class="bg-gray-50 border-b border-gray-200">
                <th v-for="col in columns" :key="col.key"
                  :aria-sort="sortCol === col.key ? (sortAsc ? 'ascending' : 'descending') : 'none'"
                  :class="['px-4 py-3 text-xs font-medium uppercase', col.right ? 'text-right' : 'text-left']">
                  <button @click="toggleSort(col.key)" class="inline-flex items-center gap-1 uppercase select-none hover:text-gray-700"
                    :class="sortCol === col.key ? 'text-gray-900' : 'text-gray-500'">
                    {{ col.label }}<span class="w-3 text-[10px]">{{ sortCol === col.key ? (sortAsc ? '\\u25B2' : '\\u25BC') : '' }}</span>
                  </button>
                </th>
                <th class="px-4 py-3"><span class="sr-only">Open</span></th>
              </tr>
            </thead>
            <tbody>
              <template v-for="g in groups" :key="g.month || 'all'">
                <tr v-if="g.month" class="bg-gray-50/60 border-b border-gray-100">
                  <td colspan="5" class="px-4 py-2 text-xs font-semibold text-gray-700 uppercase tracking-wide">{{ monthLabelFull(g.month) }}</td>
                  <td class="px-4 py-2 text-right text-xs font-semibold text-gray-700 tabular-nums">{{ formatCents(g.total) }}</td>
                  <td></td>
                </tr>
                <tr v-for="c in g.charges" :key="c.key" @click="open(c)" class="border-b border-gray-100 hover:bg-gray-50 cursor-pointer">
                  <td class="px-4 py-3 whitespace-nowrap">
                    <div class="text-gray-900">{{ fmtDate(c.date) }}</div>
                    <div class="text-xs text-gray-400">{{ daysAway(c.date) }}</div>
                  </td>
                  <td class="px-4 py-3 min-w-[15rem]">
                    <div class="flex items-center gap-2 flex-wrap">
                      <inline-edit v-if="c.kind === 'expense'" :value="c.name" @save="v => saveField(c, 'name', v)">
                        <span class="font-medium text-gray-900" :title="c.charge_label ? 'Charge label: ' + c.charge_label : ''">{{ c.name }}</span>
                      </inline-edit>
                      <span v-else class="font-medium text-gray-900" :title="c.charge_label || ''">{{ c.name }}</span>
                      <span v-if="c.company" :class="['inline-flex items-center px-2 py-0.5 rounded-full text-xs whitespace-nowrap', c.kind === 'payroll' ? 'bg-indigo-50 text-indigo-700' : 'bg-gray-100 text-gray-600']">{{ c.company }}</span>
                    </div>
                    <div v-if="c.charge_label" class="text-xs text-gray-400 mt-0.5 truncate max-w-[18rem]" :title="c.charge_label">{{ c.charge_label }}</div>
                  </td>
                  <td class="px-4 py-3 text-gray-600 whitespace-nowrap">
                    <inline-edit v-if="c.kind === 'expense'" :value="c.category_id" :options="catOptions" :display="c.category_name" @save="v => saveField(c, 'category_id', v)"/>
                    <span v-else title="Set by the employee's department (Settings, department mapping)">{{ c.category_name }}</span>
                  </td>
                  <td class="px-4 py-3 text-gray-600 whitespace-nowrap">
                    <inline-edit v-if="c.kind === 'expense'" :value="c.subcategory_id" :options="subOptionsFor(c)" :display="subName(c)" placeholder="None"
                      :disabled="!subcategories.length" disabled-title="Sub-categories are not set up on this database yet"
                      @save="v => saveField(c, 'subcategory_id', v)"/>
                    <span v-else class="text-gray-400">Salary + employer contributions</span>
                  </td>
                  <td class="px-4 py-3 text-gray-600 whitespace-nowrap">
                    <inline-edit v-if="c.kind === 'expense'" :value="c.recurrence" :options="RECURRENCE_OPTIONS" :display="recurrenceLabel(c.recurrence)" @save="v => saveField(c, 'recurrence', v)"/>
                    <span v-else>Payroll</span>
                  </td>
                  <td class="px-4 py-3 text-right text-gray-900 tabular-nums">{{ formatCents(c.amount) }}</td>
                  <td class="px-2 py-3 text-right">
                    <button @click.stop="open(c)" class="text-indigo-600 hover:text-indigo-800 text-xs whitespace-nowrap">{{ c.kind === 'payroll' ? 'Open in Payroll' : 'Open' }}</button>
                  </td>
                </tr>
              </template>
              <tr v-if="!charges.length">
                <td colspan="7" class="px-4 py-8 text-center text-gray-400">No charges in the next {{ days }} days</td>
              </tr>
            </tbody>
            <tfoot v-if="charges.length">
              <tr class="border-t border-gray-200">
                <td colspan="5" class="px-4 py-3 font-semibold text-gray-900">Total</td>
                <td class="px-4 py-3 text-right font-semibold text-gray-900 tabular-nums">{{ formatCents(total) }}</td>
                <td></td>
              </tr>
            </tfoot>
          </table>
        </div>

        <div v-if="undated['no renewal day'] || undated['no start month'] || undated['no month']" class="text-xs text-gray-500 space-y-0.5">
          <p>Some expenses are not listed because their charge date is unknown. Open them on the Expenses page to complete them:</p>
          <p v-if="undated['no renewal day']">{{ undated['no renewal day'] }} recurring expense{{ undated['no renewal day'] !== 1 ? 's have' : ' has' }} no renewal day.</p>
          <p v-if="undated['no start month']">{{ undated['no start month'] }} quarterly or annual expense{{ undated['no start month'] !== 1 ? 's have' : ' has' }} no start month (the month of the first charge).</p>
          <p v-if="undated['no month']">{{ undated['no month'] }} one-time expense{{ undated['no month'] !== 1 ? 's have' : ' has' }} no month.</p>
        </div>
      </template>

      <expense-modal v-if="modalItemId !== null" :item-id="modalItemId" :categories="categories" :subcategories="subcategories"
        @close="modalItemId = null" @saved="load"/>
    </div>
  `,
};
