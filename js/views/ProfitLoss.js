import { query } from '../db.js';
import { getBaseScenarioId } from '../schema.js';
import { formatCents, monthLabel, generateMonthRange } from '../utils.js';
import { loadCategoryLookups } from '../expenses.js';
import { payrollCategory } from '../payroll.js';

export default {
  name: 'ProfitLossView',
  setup() {
    const { ref, computed, watch, onMounted, inject } = Vue;
    const scenarioId = inject('scenarioId');
    const dateRange = inject('dateRange');
    const settings = inject('settings');
    const toast = inject('toast');

    const loading = ref(true);
    const rows = ref([]);

    // Line order inside each category: alphabetical, or largest total over the viewed period first
    const SORT_KEY = 'vintana_pnl_sort';
    const sortMode = ref((() => { try { return localStorage.getItem(SORT_KEY) === 'amount' ? 'amount' : 'alpha'; } catch { return 'alpha'; } })());
    watch(sortMode, v => { try { localStorage.setItem(SORT_KEY, v); } catch { /* storage unavailable */ } });

    const rowTotal = r => Object.values(r.values || {}).reduce((a, b) => a + b, 0);
    const sortedRows = computed(() => {
      const cmp = sortMode.value === 'amount'
        ? (a, b) => rowTotal(b) - rowTotal(a) || a.label.localeCompare(b.label)
        : (a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' });
      // Inside a category, sub-category blocks (subtotal line + its expenses) and loose lines sort together;
      // the expenses inside each block sort the same way
      const out = [];
      let run = [];
      const flush = () => {
        run.sort((a, b) => cmp(a.row, b.row));
        run.forEach(e => { out.push(e.row); out.push(...e.children.sort(cmp)); });
        run = [];
      };
      for (const r of rows.value) {
        if (r.type === 'subgroup') run.push({ row: r, children: [] });
        else if (r.type === 'item' && r.level === 2) run[run.length - 1].children.push(r);
        else if (r.type === 'item') run.push({ row: r, children: [] });
        else { flush(); out.push(r); }
      }
      flush();
      return out;
    });

    const months = computed(() => {
      const dr = dateRange.value;
      return dr ? generateMonthRange(dr.start, dr.end) : [];
    });

    const isForecast = (m) => {
      const at = settings.value?.actuals_through;
      return at && m > at;
    };

    function overlayValues(base, scen, keyFn) {
      const sMap = new Map();
      for (const v of scen) sMap.set(keyFn(v), v);
      const result = base.map(bv => sMap.get(keyFn(bv)) || bv);
      const bKeys = new Set(base.map(keyFn));
      for (const sv of scen) {
        if (!bKeys.has(keyFn(sv))) result.push(sv);
      }
      return result;
    }

    function emptyMonths() {
      const o = {};
      for (const m of months.value) o[m] = 0;
      return o;
    }

    async function loadData() {
      loading.value = true;
      try {
        const sid = scenarioId.value;
        const ml = months.value;
        if (!sid || !ml.length) { rows.value = []; return; }

        const baseId = await getBaseScenarioId();
        const isBase = sid === baseId;
        const first = ml[0], last = ml[ml.length - 1];
        const valuesOf = (table, scenario) =>
          query(`SELECT * FROM ${table} WHERE scenario_id = ? AND month >= ? AND month <= ?`, [scenario, first, last]);

        // Everything at once; a scenario's values replace the base values
        const [products, revBase, revScen, { subcategories }, expItems, expBase, expScen, employees] = await Promise.all([
          query('SELECT * FROM revenue_products ORDER BY id'),
          valuesOf('revenue_values', baseId),
          isBase ? [] : valuesOf('revenue_values', sid),
          loadCategoryLookups(),
          query(`
            SELECT ei.*, ec.name as category_name, ec.sort_order
            FROM expense_items ei
            JOIN expense_categories ec ON ec.id = ei.category_id
            WHERE ei.visible = 1 ORDER BY ec.sort_order, ei.id`),
          valuesOf('expense_values', baseId),
          isBase ? [] : valuesOf('expense_values', sid),
          query('SELECT * FROM employees'),
        ]);

        // --- Revenue ---
        const revRaw = isBase ? revBase : overlayValues(revBase, revScen, v => `${v.product_id}:${v.month}`);
        const revMap = {};
        for (const v of revRaw) {
          if (!revMap[v.product_id]) revMap[v.product_id] = {};
          revMap[v.product_id][v.month] = v.customers * v.arpu;
        }

        // --- Expenses ---
        const expRaw = isBase ? expBase : overlayValues(expBase, expScen, v => `${v.expense_item_id}:${v.month}`);
        const expMap = {};
        for (const v of expRaw) {
          if (!expMap[v.expense_item_id]) expMap[v.expense_item_id] = {};
          expMap[v.expense_item_id][v.month] = v.amount;
        }

        // --- Payroll ---
        const deptMap = settings.value?.dept_mapping || {};
        const payrollByCat = {};
        for (const m of ml) {
          for (const emp of employees) {
            if (emp.start_date.slice(0, 7) > m) continue;
            if (emp.end_date && emp.end_date.slice(0, 7) < m) continue;
            const cat = payrollCategory(emp.department, deptMap);
            if (!payrollByCat[cat]) payrollByCat[cat] = {};
            payrollByCat[cat][m] = (payrollByCat[cat][m] || 0)
              + Math.round(emp.salary_monthly * (1 + (emp.tax_pct || 0) / 100));
          }
        }

        // --- Build rows ---
        const R = [];

        // Expense lines of one category: under a sub-category subtotal line when they have one, loose otherwise
        const pushCategoryExpenses = (categoryName, catTot) => {
          const inCat = expItems.filter(i => i.category_name === categoryName);
          const lineValues = it => {
            const v = emptyMonths();
            for (const m of ml) { v[m] = (expMap[it.id] || {})[m] || 0; catTot[m] += v[m]; }
            return v;
          };
          for (const sub of subcategories.filter(sc => sc.category_name === categoryName)) {
            const members = inCat.filter(i => i.subcategory_id === sub.id);
            if (!members.length) continue;
            const subRow = { label: sub.name, type: 'subgroup', values: emptyMonths(), indent: true };
            const children = members.map(it => ({ label: it.name, type: 'item', level: 2, values: lineValues(it) }));
            children.forEach(c => { for (const m of ml) subRow.values[m] += c.values[m]; });
            R.push(subRow, ...children);
          }
          const grouped = new Set(subcategories.filter(sc => sc.category_name === categoryName).map(sc => sc.id));
          for (const it of inCat.filter(i => !grouped.has(i.subcategory_id))) {
            R.push({ label: it.name, type: 'item', values: lineValues(it), indent: true });
          }
        };

        // Revenue
        R.push({ label: 'Revenue', type: 'header' });
        const totalRev = emptyMonths();
        for (const p of products) {
          const v = emptyMonths();
          for (const m of ml) { v[m] = (revMap[p.id] || {})[m] || 0; totalRev[m] += v[m]; }
          R.push({ label: p.name, type: 'item', values: v, indent: true });
        }
        R.push({ label: 'Total Revenue', type: 'subtotal', values: totalRev });

        // COGS
        R.push({ label: 'Cost of Goods Sold (COGS)', type: 'header' });
        const totalCOGS = emptyMonths();
        pushCategoryExpenses('Cost of Goods Sold (COGS)', totalCOGS);
        R.push({ label: 'Total COGS', type: 'subtotal', values: totalCOGS });

        // Gross Profit
        const gp = emptyMonths();
        for (const m of ml) gp[m] = totalRev[m] - totalCOGS[m];
        R.push({ label: 'Gross Profit', type: 'total', values: gp });

        // OpEx categories
        const opexCats = [
          { name: 'Research & Development', short: 'R&D' },
          { name: 'Sales & Marketing', short: 'S&M' },
          { name: 'General & Administrative', short: 'G&A' },
          { name: 'Uncategorized / Other', short: 'Other' },
        ];
        const totalOpEx = emptyMonths();

        for (const cat of opexCats) {
          R.push({ label: cat.name, type: 'header' });
          const catTot = emptyMonths();

          // Payroll row (show if any payroll exists for this category)
          if (payrollByCat[cat.name]) {
            const pv = emptyMonths();
            for (const m of ml) { pv[m] = (payrollByCat[cat.name] || {})[m] || 0; catTot[m] += pv[m]; }
            R.push({ label: `${cat.short} Payroll (auto)`, type: 'item', values: pv, indent: true });
          }

          // Expense items in this category
          pushCategoryExpenses(cat.name, catTot);

          for (const m of ml) totalOpEx[m] += catTot[m];
          R.push({ label: `Total ${cat.short}`, type: 'subtotal', values: catTot });
        }

        // Total Operating Expenses
        R.push({ label: 'Total Operating Expenses', type: 'total', values: totalOpEx });

        // Net Income
        const ni = emptyMonths();
        for (const m of ml) ni[m] = gp[m] - totalOpEx[m];
        R.push({ label: 'Net Income (EBITDA)', type: 'total', values: ni });

        rows.value = R;
      } catch (e) {
        toast('Failed to load P&L data: ' + e.message, 'error');
      } finally {
        loading.value = false;
      }
    }

    onMounted(loadData);
    watch([scenarioId, dateRange, settings], loadData, { deep: true });

    const labelBg = (row) => row.type === 'total' ? 'bg-gray-100' : 'bg-white';

    const cellBg = (row, m) => {
      if (row.type === 'total') return 'bg-gray-100';
      return isForecast(m) ? 'bg-blue-50' : 'bg-white';
    };

    return { rows, sortedRows, sortMode, months, loading, isForecast, formatCents, monthLabel, labelBg, cellBg };
  },
  template: `
    <div>
      <div class="flex items-center justify-between flex-wrap gap-3 mb-6">
        <h1 class="text-2xl font-bold text-gray-900">Profit & Loss</h1>
        <div class="flex items-center gap-2 text-sm text-gray-500">
          <span>Sort lines</span>
          <div class="inline-flex rounded-lg border border-gray-200 bg-white p-0.5" role="group" aria-label="Sort lines">
            <button @click="sortMode = 'alpha'" :aria-pressed="sortMode === 'alpha'"
              :class="['px-3 py-1 rounded-md transition-colors', sortMode === 'alpha' ? 'bg-indigo-600 text-white' : 'text-gray-600 hover:bg-gray-50']">A to Z</button>
            <button @click="sortMode = 'amount'" :aria-pressed="sortMode === 'amount'"
              :class="['px-3 py-1 rounded-md transition-colors', sortMode === 'amount' ? 'bg-indigo-600 text-white' : 'text-gray-600 hover:bg-gray-50']"
              title="Largest total over the viewed period first">By amount</button>
          </div>
        </div>
      </div>

      <div v-if="loading" class="text-gray-400 py-12 text-center">Loading...</div>

      <div v-else-if="!rows.length" class="text-gray-400 py-12 text-center">
        No data to display. Add revenue products, expenses, and employees first.
      </div>

      <div v-else class="overflow-x-auto border border-gray-200 rounded-xl bg-white">
        <table class="min-w-max w-full text-sm border-collapse">
          <thead>
            <tr>
              <th class="sticky left-0 z-20 bg-gray-50 px-4 py-2.5 text-left font-semibold text-gray-700 border-b border-r border-gray-200 min-w-[10rem] md:min-w-[220px]">
              </th>
              <th v-for="m in months" :key="m"
                  :class="isForecast(m) ? 'bg-blue-50' : 'bg-gray-50'"
                  class="px-4 py-2.5 text-right font-medium text-gray-700 border-b border-gray-200 whitespace-nowrap min-w-[90px] md:min-w-[120px]">
                <div>{{ monthLabel(m) }}</div>
                <div v-if="isForecast(m)" class="text-xs font-normal text-blue-500">Forecast</div>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, idx) in sortedRows" :key="idx">
              <td class="sticky left-0 z-10 px-4 py-1.5 border-r border-gray-200 whitespace-nowrap"
                  :class="[
                    labelBg(row),
                    row.type === 'header' || row.type === 'subtotal' || row.type === 'total' ? 'font-semibold' : 'font-normal',
                    row.type === 'header' ? 'text-gray-900 pt-4 text-xs uppercase tracking-wide' : '',
                    row.type === 'total' ? 'text-gray-900' : '',
                    row.type === 'subtotal' ? 'text-gray-700' : '',
                    row.type === 'item' ? 'text-gray-600' : '',
                    row.type === 'subgroup' ? 'font-medium text-gray-800' : '',
                    row.level === 2 ? 'pl-12' : row.indent ? 'pl-8' : 'pl-4',
                  ]">
                {{ row.label }}
              </td>
              <td v-for="m in months" :key="m"
                  :class="[
                    cellBg(row, m),
                    row.type === 'header' ? 'pt-4' : '',
                    row.type === 'subtotal' || row.type === 'total' ? 'font-semibold' : '',
                    row.type === 'subgroup' ? 'font-medium' : '',
                    row.type === 'total' ? 'border-t border-gray-300' : '',
                  ]"
                  class="px-4 py-1.5 text-right whitespace-nowrap tabular-nums">
                <template v-if="row.values && row.values[m] !== undefined">
                  <span :class="row.values[m] < 0 ? 'text-red-600' : 'text-gray-900'">
                    {{ formatCents(row.values[m]) }}
                  </span>
                </template>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  `,
};
