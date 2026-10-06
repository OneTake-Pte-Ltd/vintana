import { query } from '../db.js';
import { formatCents, monthLabel, generateMonthRange } from '../utils.js';

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

        const baseRows = await query('SELECT id FROM scenarios WHERE is_base = 1 LIMIT 1');
        const baseId = baseRows.length ? baseRows[0].id : 1;
        const isBase = sid === baseId;

        // --- Revenue ---
        const products = await query('SELECT * FROM revenue_products ORDER BY id');
        let revRaw;
        if (isBase) {
          revRaw = await query('SELECT * FROM revenue_values WHERE scenario_id = ?', [sid]);
        } else {
          const [bv, sv] = await Promise.all([
            query('SELECT * FROM revenue_values WHERE scenario_id = ?', [baseId]),
            query('SELECT * FROM revenue_values WHERE scenario_id = ?', [sid]),
          ]);
          revRaw = overlayValues(bv, sv, v => `${v.product_id}:${v.month}`);
        }
        const revMap = {};
        for (const v of revRaw) {
          if (!revMap[v.product_id]) revMap[v.product_id] = {};
          revMap[v.product_id][v.month] = v.customers * v.arpu;
        }

        // --- Expenses ---
        const expItems = await query(`
          SELECT ei.id, ei.name, ec.name as category_name, ec.sort_order
          FROM expense_items ei
          JOIN expense_categories ec ON ec.id = ei.category_id
          WHERE ei.visible = 1 ORDER BY ec.sort_order, ei.id`);
        let expRaw;
        if (isBase) {
          expRaw = await query('SELECT * FROM expense_values WHERE scenario_id = ?', [sid]);
        } else {
          const [bv, sv] = await Promise.all([
            query('SELECT * FROM expense_values WHERE scenario_id = ?', [baseId]),
            query('SELECT * FROM expense_values WHERE scenario_id = ?', [sid]),
          ]);
          expRaw = overlayValues(bv, sv, v => `${v.expense_item_id}:${v.month}`);
        }
        const expMap = {};
        for (const v of expRaw) {
          if (!expMap[v.expense_item_id]) expMap[v.expense_item_id] = {};
          expMap[v.expense_item_id][v.month] = v.amount;
        }

        // --- Payroll ---
        const employees = await query('SELECT * FROM employees');
        const deptMap = settings.value?.dept_mapping || {};
        const payrollByCat = {};
        for (const m of ml) {
          for (const emp of employees) {
            if (emp.start_date.slice(0, 7) > m) continue;
            if (emp.end_date && emp.end_date.slice(0, 7) < m) continue;
            const cat = deptMap[emp.department] || 'Uncategorized / Other';
            if (!payrollByCat[cat]) payrollByCat[cat] = {};
            payrollByCat[cat][m] = (payrollByCat[cat][m] || 0)
              + Math.round(emp.salary_monthly * (1 + (emp.tax_pct || 0) / 100));
          }
        }

        // --- Build rows ---
        const R = [];

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
        for (const it of expItems.filter(i => i.category_name === 'Cost of Goods Sold (COGS)')) {
          const v = emptyMonths();
          for (const m of ml) { v[m] = (expMap[it.id] || {})[m] || 0; totalCOGS[m] += v[m]; }
          R.push({ label: it.name, type: 'item', values: v, indent: true });
        }
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
          for (const it of expItems.filter(i => i.category_name === cat.name)) {
            const v = emptyMonths();
            for (const m of ml) { v[m] = (expMap[it.id] || {})[m] || 0; catTot[m] += v[m]; }
            R.push({ label: it.name, type: 'item', values: v, indent: true });
          }

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

    return { rows, months, loading, isForecast, formatCents, monthLabel, labelBg, cellBg };
  },
  template: `
    <div>
      <h1 class="text-2xl font-bold text-gray-900 mb-6">Profit & Loss</h1>

      <div v-if="loading" class="text-gray-400 py-12 text-center">Loading...</div>

      <div v-else-if="!rows.length" class="text-gray-400 py-12 text-center">
        No data to display. Add revenue products, expenses, and employees first.
      </div>

      <div v-else class="overflow-x-auto border border-gray-200 rounded-xl bg-white">
        <table class="min-w-max w-full text-sm border-collapse">
          <thead>
            <tr>
              <th class="sticky left-0 z-20 bg-gray-50 px-4 py-2.5 text-left font-semibold text-gray-700 border-b border-r border-gray-200 min-w-[220px]">
              </th>
              <th v-for="m in months" :key="m"
                  :class="isForecast(m) ? 'bg-blue-50' : 'bg-gray-50'"
                  class="px-4 py-2.5 text-right font-medium text-gray-700 border-b border-gray-200 whitespace-nowrap min-w-[120px]">
                <div>{{ monthLabel(m) }}</div>
                <div v-if="isForecast(m)" class="text-xs font-normal text-blue-500">Forecast</div>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, idx) in rows" :key="idx">
              <td class="sticky left-0 z-10 px-4 py-1.5 border-r border-gray-200 whitespace-nowrap"
                  :class="[
                    labelBg(row),
                    row.type === 'header' || row.type === 'subtotal' || row.type === 'total' ? 'font-semibold' : 'font-normal',
                    row.type === 'header' ? 'text-gray-900 pt-4 text-xs uppercase tracking-wide' : '',
                    row.type === 'total' ? 'text-gray-900' : '',
                    row.type === 'subtotal' ? 'text-gray-700' : '',
                    row.type === 'item' ? 'text-gray-600' : '',
                    row.indent ? 'pl-8' : 'pl-4',
                  ]">
                {{ row.label }}
              </td>
              <td v-for="m in months" :key="m"
                  :class="[
                    cellBg(row, m),
                    row.type === 'header' ? 'pt-4' : '',
                    row.type === 'subtotal' || row.type === 'total' ? 'font-semibold' : '',
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
