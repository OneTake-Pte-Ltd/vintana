import { query, execute } from '../db.js';
import { formatCents, monthLabel, generateMonthRange, currentMonth, prevMonth } from '../utils.js';

const CAT_ROWS = [
  { db: 'Cost of Goods Sold (COGS)', key: 'cogs', label: 'Total COGS' },
  { db: 'Research & Development', key: 'rd', label: 'Total R&D (incl. payroll)' },
  { db: 'Sales & Marketing', key: 'sm', label: 'Total S&M (incl. payroll)' },
  { db: 'General & Administrative', key: 'ga', label: 'Total G&A (incl. payroll)' },
  { db: 'Uncategorized / Other', key: 'other', label: 'Total Other' },
];

export default {
  name: 'CashFlowView',
  setup() {
    const { ref, reactive, computed, onMounted, onBeforeUnmount, watch, inject, nextTick } = Vue;

    const scenarioId = inject('scenarioId');
    const dateRange = inject('dateRange');
    const settings = inject('settings');
    const toast = inject('toast');

    const loading = ref(true);
    const waterfall = ref([]);
    const fundingEvents = ref([]);
    const cashActualsMap = ref({});
    const months = ref([]);

    const currentCash = ref(0);
    const burnRate = ref(0);

    const showModal = ref(false);
    const editingId = ref(null);
    const form = reactive({ name: '', month: '', amount: '', notes: '' });

    const chartRef = ref(null);
    let chart = null;

    const runwayMonths = computed(() => {
      if (burnRate.value <= 0) return Infinity;
      return currentCash.value / burnRate.value;
    });

    async function loadData() {
      loading.value = true;
      try {
        const range = dateRange.value;
        if (!range?.start || !range?.end) return;
        const sid = scenarioId.value;
        const ms = generateMonthRange(range.start, range.end);
        months.value = ms;

        const [revRows, expRows, empRows, fundRows, cashRows] = await Promise.all([
          query(`SELECT month, COALESCE(SUM(customers * arpu), 0) AS total
                 FROM revenue_values WHERE scenario_id = ? AND month >= ? AND month <= ?
                 GROUP BY month`, [sid, ms[0], ms[ms.length - 1]]),
          query(`SELECT ev.month, ec.name AS category, COALESCE(SUM(ev.amount), 0) AS total
                 FROM expense_values ev
                 JOIN expense_items ei ON ev.expense_item_id = ei.id
                 JOIN expense_categories ec ON ei.category_id = ec.id
                 WHERE ev.scenario_id = ? AND ev.month >= ? AND ev.month <= ?
                 GROUP BY ev.month, ec.name`, [sid, ms[0], ms[ms.length - 1]]),
          query(`SELECT department, salary_monthly, tax_pct, start_date, end_date FROM employees`),
          query(`SELECT * FROM funding_events WHERE scenario_id = ? ORDER BY month`, [sid]),
          query(`SELECT month, balance FROM cash_actuals`),
        ]);

        const revMap = {};
        revRows.forEach(r => { revMap[r.month] = r.total; });

        const expMap = {};
        expRows.forEach(r => {
          if (!expMap[r.month]) expMap[r.month] = {};
          expMap[r.month][r.category] = r.total;
        });

        const deptMapping = settings.value?.dept_mapping || {};
        const payrollMap = {};
        for (const m of ms) {
          payrollMap[m] = {};
          for (const emp of empRows) {
            if (emp.start_date > m + '-31') continue;
            if (emp.end_date && emp.end_date < m + '-01') continue;
            const cost = Math.round(emp.salary_monthly * (1 + (emp.tax_pct || 0) / 100));
            const catName = deptMapping[emp.department || 'Other'] || 'General & Administrative';
            payrollMap[m][catName] = (payrollMap[m][catName] || 0) + cost;
          }
        }

        const fundMap = {};
        fundRows.forEach(r => { fundMap[r.month] = (fundMap[r.month] || 0) + r.amount; });
        fundingEvents.value = fundRows;

        const caMap = {};
        cashRows.forEach(r => { caMap[r.month] = r.balance; });
        cashActualsMap.value = caMap;

        const rows = [];
        let prevEnd = caMap[prevMonth(ms[0])] ?? 0;

        for (const m of ms) {
          const startCash = (caMap[prevMonth(m)] !== undefined) ? caMap[prevMonth(m)] : prevEnd;
          const revenue = revMap[m] || 0;
          const funding = fundMap[m] || 0;
          const cats = {};
          let totalOut = 0;
          for (const c of CAT_ROWS) {
            const amt = ((expMap[m] || {})[c.db] || 0) + ((payrollMap[m] || {})[c.db] || 0);
            cats[c.key] = amt;
            totalOut += amt;
          }
          const net = revenue + funding - totalOut;
          const endCash = startCash + net;
          rows.push({ month: m, startCash, revenue, funding, ...cats, net, endCash });
          prevEnd = endCash;
        }
        waterfall.value = rows;

        const cm = currentMonth();
        const latest = rows.find(r => r.month === cm) || rows[rows.length - 1];
        if (latest) {
          currentCash.value = latest.endCash;
          const totalExp = latest.cogs + latest.rd + latest.sm + latest.ga + latest.other;
          burnRate.value = totalExp - latest.revenue;
        }
      } catch (e) {
        toast('Failed to load cash flow: ' + e.message, 'error');
      } finally {
        loading.value = false;
        await nextTick();
        renderChart();
      }
    }

    function destroyChart() { if (chart) { chart.destroy(); chart = null; } }

    function renderChart() {
      destroyChart();
      if (!chartRef.value || waterfall.value.length === 0) return;
      const labels = waterfall.value.map(r => monthLabel(r.month));
      const data = waterfall.value.map(r => r.endCash / 100);
      const zeroIdx = waterfall.value.findIndex(r => r.endCash <= 0);

      chart = new Chart(chartRef.value.getContext('2d'), {
        type: 'line',
        data: {
          labels,
          datasets: [
            {
              label: 'Cash Balance',
              data,
              borderColor: '#6366f1',
              backgroundColor: 'rgba(99, 102, 241, 0.08)',
              fill: true, tension: 0.3, pointRadius: 3, pointHoverRadius: 6,
            },
            {
              label: 'Zero',
              data: data.map(() => 0),
              borderColor: '#ef4444',
              borderDash: [6, 4], borderWidth: 1.5,
              pointRadius: 0, fill: false,
            },
          ],
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              filter: (item) => item.datasetIndex === 0,
              callbacks: {
                label: (ctx) => formatCents(Math.round(ctx.raw * 100)),
                afterLabel: (ctx) =>
                  zeroIdx >= 0 && ctx.dataIndex === zeroIdx ? 'Cash depleted' : '',
              },
            },
          },
          scales: {
            y: {
              ticks: { callback: v => formatCents(Math.round(v * 100)), maxTicksLimit: 6 },
              grid: { color: '#f3f4f6' },
            },
            x: { grid: { display: false } },
          },
        },
      });
    }

    function openAdd() {
      editingId.value = null;
      Object.assign(form, { name: '', month: currentMonth(), amount: '', notes: '' });
      showModal.value = true;
    }
    function openEdit(ev) {
      editingId.value = ev.id;
      Object.assign(form, {
        name: ev.name, month: ev.month,
        amount: (ev.amount / 100).toFixed(2), notes: ev.notes || '',
      });
      showModal.value = true;
    }
    async function saveFunding() {
      const cents = Math.round(parseFloat(form.amount || 0) * 100);
      if (!form.name || !form.month || !cents) {
        toast('Name, month, and amount are required', 'error'); return;
      }
      try {
        if (editingId.value) {
          await execute(`UPDATE funding_events SET name=?, month=?, amount=?, notes=? WHERE id=?`,
            [form.name, form.month, cents, form.notes, editingId.value]);
        } else {
          await execute(
            `INSERT INTO funding_events (name, month, amount, scenario_id, notes) VALUES (?,?,?,?,?)`,
            [form.name, form.month, cents, scenarioId.value, form.notes]);
        }
        showModal.value = false;
        toast('Funding event saved', 'success');
        await loadData();
      } catch (e) { toast('Save failed: ' + e.message, 'error'); }
    }
    async function deleteFunding(id) {
      if (!confirm('Delete this funding event?')) return;
      try {
        await execute('DELETE FROM funding_events WHERE id = ?', [id]);
        toast('Deleted', 'success');
        await loadData();
      } catch (e) { toast('Delete failed: ' + e.message, 'error'); }
    }

    async function saveCashActual(month, val) {
      const cents = Math.round(parseFloat(val || 0) * 100);
      try {
        await execute(`INSERT OR REPLACE INTO cash_actuals (month, balance) VALUES (?, ?)`, [month, cents]);
        await loadData();
      } catch (e) { toast('Save failed: ' + e.message, 'error'); }
    }

    function centsToInput(c) { return c != null ? (c / 100).toFixed(2) : ''; }

    onMounted(() => loadData());
    onBeforeUnmount(() => destroyChart());
    watch(() => [scenarioId.value, dateRange.value], () => loadData(), { deep: true });

    return {
      loading, waterfall, months, fundingEvents, cashActualsMap,
      currentCash, burnRate, runwayMonths,
      showModal, editingId, form, chartRef,
      openAdd, openEdit, saveFunding, deleteFunding,
      saveCashActual, centsToInput,
      formatCents, monthLabel, CAT_ROWS,
    };
  },
  template: `
<div class="max-w-7xl mx-auto">
  <h1 class="text-2xl font-bold text-gray-900 mb-6">Cash Flow</h1>
  <div v-if="loading" class="text-gray-400 py-12 text-center">Loading...</div>
  <div v-else class="space-y-6">

    <!-- KPI Cards -->
    <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
      <div class="bg-white rounded-xl border border-gray-200 p-5">
        <div class="text-xs font-medium text-gray-500 uppercase tracking-wider mb-1">Cash Balance</div>
        <div class="text-2xl font-bold text-gray-900">{{ formatCents(currentCash) }}</div>
      </div>
      <div class="bg-white rounded-xl border border-gray-200 p-5">
        <div class="text-xs font-medium text-gray-500 uppercase tracking-wider mb-1">Monthly Burn Rate</div>
        <div class="text-2xl font-bold" :class="burnRate <= 0 ? 'text-emerald-600' : 'text-gray-900'">
          {{ burnRate <= 0 ? 'Net Positive' : formatCents(burnRate) }}
        </div>
      </div>
      <div class="bg-white rounded-xl border border-gray-200 p-5">
        <div class="text-xs font-medium text-gray-500 uppercase tracking-wider mb-1">Runway</div>
        <div class="text-2xl font-bold" :class="runwayMonths === Infinity ? 'text-emerald-600' : runwayMonths < 6 ? 'text-red-600' : 'text-gray-900'">
          {{ runwayMonths === Infinity ? '\\u221E' : runwayMonths.toFixed(1) + ' months' }}
        </div>
      </div>
    </div>

    <!-- Waterfall Table -->
    <div class="bg-white rounded-xl border border-gray-200">
      <h2 class="text-sm font-semibold text-gray-700 px-5 pt-5 mb-3">Cash Flow Waterfall</h2>
      <div class="overflow-x-auto">
        <table class="w-full text-xs whitespace-nowrap">
          <thead>
            <tr class="border-b border-gray-200 text-gray-500 uppercase tracking-wider">
              <th class="text-left py-2 px-4 font-medium sticky left-0 bg-white z-10 min-w-[200px]"></th>
              <th v-for="r in waterfall" :key="r.month" class="text-right py-2 px-3 font-medium min-w-[100px]">{{ monthLabel(r.month) }}</th>
            </tr>
          </thead>
          <tbody class="text-sm">
            <tr class="border-b border-gray-100">
              <td class="py-2 px-4 font-medium text-gray-700 sticky left-0 bg-white z-10">Starting Cash Balance</td>
              <td v-for="r in waterfall" :key="r.month" class="text-right py-2 px-3 text-gray-900">{{ formatCents(r.startCash) }}</td>
            </tr>
            <tr class="border-b border-gray-100 bg-emerald-50/50">
              <td class="py-2 px-4 text-emerald-700 sticky left-0 bg-emerald-50/50 z-10">+ Total Revenue</td>
              <td v-for="r in waterfall" :key="r.month" class="text-right py-2 px-3 text-emerald-700">{{ formatCents(r.revenue) }}</td>
            </tr>
            <tr class="border-b border-gray-100 bg-emerald-50/50">
              <td class="py-2 px-4 text-emerald-700 sticky left-0 bg-emerald-50/50 z-10">+ Funding / Cash Injections</td>
              <td v-for="r in waterfall" :key="r.month" class="text-right py-2 px-3 text-emerald-700">{{ formatCents(r.funding) }}</td>
            </tr>
            <tr v-for="cat in CAT_ROWS" :key="cat.key" class="border-b border-gray-100">
              <td class="py-2 px-4 text-red-700 sticky left-0 bg-white z-10">- {{ cat.label }}</td>
              <td v-for="r in waterfall" :key="r.month" class="text-right py-2 px-3 text-red-700">{{ formatCents(r[cat.key]) }}</td>
            </tr>
            <tr class="border-b border-gray-200 bg-gray-50 font-semibold">
              <td class="py-2.5 px-4 text-gray-900 sticky left-0 bg-gray-50 z-10">Net Cash Flow</td>
              <td v-for="r in waterfall" :key="r.month" class="text-right py-2.5 px-3" :class="r.net >= 0 ? 'text-emerald-700' : 'text-red-700'">{{ formatCents(r.net) }}</td>
            </tr>
            <tr class="font-bold">
              <td class="py-2.5 px-4 text-gray-900 sticky left-0 bg-white z-10">Ending Cash Balance</td>
              <td v-for="r in waterfall" :key="r.month" class="text-right py-2.5 px-3" :class="r.endCash < 0 ? 'text-red-700' : 'text-gray-900'">{{ formatCents(r.endCash) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Runway Chart -->
    <div class="bg-white rounded-xl border border-gray-200 p-5">
      <h2 class="text-sm font-semibold text-gray-700 mb-4">Projected Cash Balance</h2>
      <div style="height: 280px"><canvas ref="chartRef"></canvas></div>
      <p v-if="waterfall.length === 0" class="text-sm text-gray-400 text-center py-8">No data for this period</p>
    </div>

    <!-- Funding Events -->
    <div class="bg-white rounded-xl border border-gray-200 p-5">
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-sm font-semibold text-gray-700">Funding Events</h2>
        <button @click="openAdd" class="text-sm text-indigo-600 hover:text-indigo-700 font-medium">+ Add</button>
      </div>
      <table v-if="fundingEvents.length > 0" class="w-full text-sm">
        <thead>
          <tr class="text-left text-xs text-gray-500 uppercase tracking-wider border-b border-gray-100">
            <th class="pb-2 font-medium">Name</th>
            <th class="pb-2 font-medium">Month</th>
            <th class="pb-2 font-medium text-right">Amount</th>
            <th class="pb-2 font-medium">Notes</th>
            <th class="pb-2 font-medium text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="ev in fundingEvents" :key="ev.id" class="border-b border-gray-50">
            <td class="py-2.5 text-gray-900">{{ ev.name }}</td>
            <td class="py-2.5 text-gray-500">{{ monthLabel(ev.month) }}</td>
            <td class="py-2.5 text-right text-gray-900">{{ formatCents(ev.amount) }}</td>
            <td class="py-2.5 text-gray-500 max-w-[200px] truncate">{{ ev.notes || '—' }}</td>
            <td class="py-2.5 text-right space-x-2">
              <button @click="openEdit(ev)" class="text-indigo-600 hover:text-indigo-700 text-xs">Edit</button>
              <button @click="deleteFunding(ev.id)" class="text-red-500 hover:text-red-600 text-xs">Delete</button>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-else class="text-sm text-gray-400 text-center py-4">No funding events for this scenario</p>
    </div>

    <!-- Cash Actuals -->
    <div class="bg-white rounded-xl border border-gray-200 p-5">
      <h2 class="text-sm font-semibold text-gray-700 mb-4">Actual Bank Balances</h2>
      <p class="text-xs text-gray-400 mb-3">Record end-of-month bank balances. These anchor the waterfall starting cash.</p>
      <div class="overflow-x-auto">
        <table class="text-sm">
          <thead>
            <tr class="text-left text-xs text-gray-500 uppercase tracking-wider border-b border-gray-100">
              <th class="pb-2 pr-4 font-medium">Month</th>
              <th class="pb-2 font-medium">Balance (EUR)</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="m in months" :key="m" class="border-b border-gray-50">
              <td class="py-2 pr-4 text-gray-700 whitespace-nowrap">{{ monthLabel(m) }}</td>
              <td class="py-2">
                <input type="number" step="0.01"
                  :value="centsToInput(cashActualsMap[m])"
                  @blur="saveCashActual(m, $event.target.value)"
                  class="w-40 px-2 py-1 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  placeholder="—"
                />
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

  </div>

  <!-- Funding Modal -->
  <div v-if="showModal" class="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
    <div class="bg-white rounded-xl p-6 w-full max-w-md mx-4">
      <h3 class="text-lg font-semibold text-gray-900 mb-4">{{ editingId ? 'Edit' : 'Add' }} Funding Event</h3>
      <div class="space-y-3">
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">Name</label>
          <input v-model="form.name" type="text" class="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500" placeholder="e.g. Seed Round"/>
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">Month</label>
          <input v-model="form.month" type="month" class="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"/>
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">Amount (EUR)</label>
          <input v-model="form.amount" type="number" step="0.01" min="0" class="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500" placeholder="0.00"/>
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">Notes</label>
          <textarea v-model="form.notes" rows="2" class="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500" placeholder="Optional"></textarea>
        </div>
      </div>
      <div class="flex justify-end gap-3 mt-5">
        <button @click="showModal = false" class="px-4 py-2 text-sm border border-gray-200 rounded-lg hover:bg-gray-50">Cancel</button>
        <button @click="saveFunding" class="px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700">Save</button>
      </div>
    </div>
  </div>
</div>
  `,
};
