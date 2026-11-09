import { query } from '../db.js';
import { cashPosition } from '../bank.js';
import { loadMrrSeries, mrrChartDatasets } from '../profitwell.js';
import {
  formatCents, formatPct, formatDelta, monthLabel,
  currentMonth, prevMonth, ordinalDay,
} from '../utils.js';
import { loadExpenseValues, computeUpcomingCharges, horizonMonth } from '../charges.js';

const RENEWAL_DAYS = 7;

const COLORS = ['#6366f1', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6'];

function centsTooltip(ctx) { return formatCents(Math.round(ctx.raw * 100)); }
function centsTick(v) { return formatCents(Math.round(v * 100)); }

export default {
  name: 'DashboardView',
  setup() {
    const { ref, computed, onMounted, onBeforeUnmount, watch, inject, nextTick } = Vue;
    const scenarioId = inject('scenarioId');
    const dateRange = inject('dateRange');
    const settings = inject('settings');
    const mrrVersion = inject('mrrVersion', Vue.ref(0));

    const loading = ref(true);
    const revenueNow = ref(0), revenuePrev = ref(0);
    const cashBalance = ref(null);
    const totalExpenses = ref(0), totalPayroll = ref(0);
    const mrrSeries = ref(null), expensesByCat = ref([]);
    const employees = ref([]), renewals = ref([]);
    const mrrCanvasRef = ref(null), expenseCanvasRef = ref(null), teamCanvasRef = ref(null);
    let charts = [];

    const mrr = computed(() => revenueNow.value);
    const mrrDelta = computed(() => formatDelta(revenueNow.value, revenuePrev.value));
    const arr = computed(() => revenueNow.value * 12);
    const arrDelta = computed(() => ({ abs: mrrDelta.value.abs * 12, pct: mrrDelta.value.pct }));
    const burnRate = computed(() => totalExpenses.value + totalPayroll.value - revenueNow.value);
    const runway = computed(() => {
      if (cashBalance.value === null || burnRate.value <= 0) return null;
      return cashBalance.value / burnRate.value;
    });
    const headcount = computed(() => employees.value.length);
    const deptBreakdown = computed(() => {
      const m = {};
      employees.value.forEach(e => { const d = e.department || 'Other'; m[d] = (m[d] || 0) + 1; });
      return Object.entries(m).sort((a, b) => b[1] - a[1]);
    });

    // Only the latest load may show its results: an earlier one can finish after it
    let loadSeq = 0;
    async function loadData() {
      const run = ++loadSeq;
      // On a fresh page load the scenario arrives a moment later, and loads the page then
      if (!scenarioId.value) return;
      loading.value = true;
      const sid = scenarioId.value, month = currentMonth(), prev = prevMonth(month);
      const range = dateRange.value;
      try {
        const start = range?.start || month, end = range?.end || month;
        const [series, cash, expenses, payroll, mrrAround, expCat, empRows, renewItems, renewValues] =
          await Promise.all([
            loadMrrSeries(sid, start, end),
            cashPosition().catch(() => null),
            query(`SELECT COALESCE(SUM(amount), 0) AS v FROM expense_values WHERE scenario_id = ? AND month = ?`, [sid, month]),
            query(`SELECT salary_monthly, tax_pct FROM employees WHERE start_date <= ? AND (end_date IS NULL OR end_date >= ?)`, [month + '-31', month + '-01']),
            loadMrrSeries(sid, prev, month),
            query(`SELECT ec.name AS category, COALESCE(SUM(ev.amount), 0) AS total FROM expense_values ev JOIN expense_items ei ON ev.expense_item_id = ei.id JOIN expense_categories ec ON ei.category_id = ec.id WHERE ev.scenario_id = ? AND ev.month = ? GROUP BY ec.name ORDER BY total DESC`, [sid, month]),
            query(`SELECT name, department FROM employees WHERE start_date <= ? AND (end_date IS NULL OR end_date >= ?)`, [month + '-31', month + '-01']),
            query(`SELECT * FROM expense_items WHERE visible = 1`),
            loadExpenseValues(sid, month, horizonMonth(RENEWAL_DAYS)),
          ]);
        if (run !== loadSeq) return;

        revenueNow.value = mrrAround.totals[month] || 0;
        revenuePrev.value = mrrAround.totals[prev] || 0;
        cashBalance.value = cash ? cash.total : null;
        totalExpenses.value = expenses[0]?.v || 0;
        totalPayroll.value = payroll.reduce((s, e) => s + Math.round(e.salary_monthly * (1 + (e.tax_pct || 0) / 100)), 0);

        mrrSeries.value = series.months.some(m => series.totals[m]) ? series : null;
        expensesByCat.value = expCat;
        employees.value = empRows;

        // Same charges as the Upcoming Charges page, soonest first
        renewals.value = computeUpcomingCharges(renewItems, renewValues, RENEWAL_DAYS);
      } catch (e) { console.error('Dashboard load error:', e); }
      finally { if (run === loadSeq) { loading.value = false; await nextTick(); renderCharts(); } }
    }

    function destroyCharts() { charts.forEach(c => c.destroy()); charts = []; }

    function makeChart(canvasRef, config) {
      if (!canvasRef.value) return;
      const c = new Chart(canvasRef.value.getContext('2d'), config);
      charts.push(c);
    }

    function renderCharts() {
      destroyCharts();
      // MRR line chart
      if (mrrSeries.value) {
        const s = mrrSeries.value;
        makeChart(mrrCanvasRef, {
          type: 'line',
          data: { labels: s.months.map(monthLabel), datasets: mrrChartDatasets(s) },
          options: { responsive: true, maintainAspectRatio: false,
            plugins: {
              legend: { display: s.months.some(m => !s.isActual(m)), position: 'bottom', labels: { usePointStyle: true, boxWidth: 8 } },
              tooltip: { callbacks: { label: c => `${c.dataset.label}: ${centsTooltip(c)}` } },
            },
            scales: { y: { beginAtZero: true, ticks: { callback: centsTick, maxTicksLimit: 6 }, grid: { color: '#f3f4f6' } }, x: { grid: { display: false } } },
          },
        });
      }
      // Expense bar chart
      if (expensesByCat.value.length) {
        const labels = expensesByCat.value.map(d => d.category);
        makeChart(expenseCanvasRef, {
          type: 'bar',
          data: { labels, datasets: [{ data: expensesByCat.value.map(d => d.total / 100), backgroundColor: COLORS.slice(0, labels.length), borderRadius: 4, barThickness: 24 }] },
          options: { responsive: true, maintainAspectRatio: false, indexAxis: 'y',
            plugins: { legend: { display: false }, tooltip: { callbacks: { label: centsTooltip } } },
            scales: { x: { beginAtZero: true, ticks: { callback: centsTick, maxTicksLimit: 5 }, grid: { color: '#f3f4f6' } }, y: { grid: { display: false } } },
          },
        });
      }
      // Team donut chart
      if (deptBreakdown.value.length) {
        makeChart(teamCanvasRef, {
          type: 'doughnut',
          data: { labels: deptBreakdown.value.map(d => d[0]), datasets: [{ data: deptBreakdown.value.map(d => d[1]), backgroundColor: COLORS.slice(0, deptBreakdown.value.length), borderWidth: 0 }] },
          options: { responsive: true, maintainAspectRatio: false, cutout: '65%',
            plugins: { legend: { position: 'right', labels: { boxWidth: 10, padding: 8, font: { size: 11 } } } } },
        });
      }
    }

    onMounted(() => loadData());
    onBeforeUnmount(() => destroyCharts());
    watch(() => [scenarioId.value, dateRange.value, mrrVersion.value], () => loadData(), { deep: true });

    function formatRenewalDate(item) {
      const d = item.date;
      const ml = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      return `${ml[d.getMonth()]} ${ordinalDay(d.getDate())}`;
    }

    return {
      loading, mrr, mrrDelta, arr, arrDelta, cashBalance, burnRate, runway,
      headcount, deptBreakdown, mrrSeries, expensesByCat, renewals,
      mrrCanvasRef, expenseCanvasRef, teamCanvasRef, formatCents, formatRenewalDate, RENEWAL_DAYS,
    };
  },
  template: `
<div class="max-w-7xl mx-auto">
  <h1 class="text-2xl font-bold text-gray-900 mb-6">Dashboard</h1>
  <div v-if="loading" class="text-gray-400 py-12 text-center">Loading...</div>
  <div v-else class="space-y-6">
    <!-- Row 1: KPI Cards -->
    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      <kpi-card title="MRR" :value="mrr" :delta="mrrDelta" subtitle="Monthly Recurring Revenue" />
      <kpi-card title="ARR" :value="arr" :delta="arrDelta" subtitle="Annual Recurring Revenue" />
      <kpi-card title="Cash Balance" :value="cashBalance !== null ? cashBalance : 'No data'" :format="cashBalance !== null ? 'currency' : 'text'" />
      <kpi-card title="Monthly Burn Rate" :value="burnRate <= 0 ? 'Net Positive' : burnRate" :format="burnRate <= 0 ? 'text' : 'currency'" />
    </div>
    <!-- Row 2: Charts -->
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <div class="bg-white rounded-xl border border-gray-200 p-5">
        <h2 class="text-sm font-semibold text-gray-700 mb-4">MRR Over Time</h2>
        <div style="height:280px"><canvas ref="mrrCanvasRef"></canvas></div>
        <p v-if="!mrrSeries" class="text-sm text-gray-400 text-center py-8">No MRR for this period. Sync ProfitWell in Settings.</p>
      </div>
      <div class="bg-white rounded-xl border border-gray-200 p-5">
        <h2 class="text-sm font-semibold text-gray-700 mb-4">Expenses by Category</h2>
        <div style="height:280px"><canvas ref="expenseCanvasRef"></canvas></div>
        <p v-if="expensesByCat.length === 0" class="text-sm text-gray-400 text-center py-8">No expense data for this month</p>
      </div>
    </div>
    <!-- Row 3: Runway + Team Size -->
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <div class="bg-white rounded-xl border border-gray-200 p-5">
        <h2 class="text-sm font-semibold text-gray-700 mb-3">Runway</h2>
        <div v-if="runway !== null">
          <div class="text-3xl font-bold text-gray-900">
            {{ runway > 999 ? '999+' : runway.toFixed(1) }}
            <span class="text-base font-normal text-gray-500">months</span>
          </div>
          <div class="mt-3 w-full bg-gray-100 rounded-full h-2.5">
            <div class="h-2.5 rounded-full transition-all"
              :class="runway < 6 ? 'bg-red-500' : runway < 12 ? 'bg-amber-400' : 'bg-emerald-500'"
              :style="{ width: Math.min(runway / 36 * 100, 100) + '%' }"></div>
          </div>
          <div class="flex justify-between text-xs text-gray-400 mt-1">
            <span>0</span><span>12</span><span>24</span><span>36 mo</span>
          </div>
        </div>
        <div v-else class="text-gray-400 text-sm py-4">
          {{ cashBalance === null ? 'No cash data available' : 'Company is net positive' }}
        </div>
      </div>
      <div class="bg-white rounded-xl border border-gray-200 p-5">
        <h2 class="text-sm font-semibold text-gray-700 mb-3">Team Size</h2>
        <div class="flex items-center gap-6">
          <div>
            <div class="text-3xl font-bold text-gray-900">{{ headcount }}</div>
            <div class="text-xs text-gray-400">active employees</div>
          </div>
          <div v-if="deptBreakdown.length > 0" class="flex-1 min-w-0 relative" style="height:140px">
            <canvas ref="teamCanvasRef"></canvas>
          </div>
          <div v-else class="text-sm text-gray-400">No employees found</div>
        </div>
      </div>
    </div>
    <!-- Row 4: Upcoming Renewals -->
    <div class="bg-white rounded-xl border border-gray-200 p-5">
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-sm font-semibold text-gray-700">Upcoming Renewals <span class="font-normal text-gray-400">(next {{ RENEWAL_DAYS }} days)</span></h2>
        <router-link to="/upcoming" class="text-xs text-indigo-600 hover:text-indigo-800">See all upcoming charges</router-link>
      </div>
      <div v-if="renewals.length > 0" class="overflow-x-auto">
      <table class="w-full text-sm whitespace-nowrap">
        <thead>
          <tr class="text-left text-xs text-gray-500 uppercase tracking-wider border-b border-gray-100">
            <th class="sticky-col pb-2 pr-3 font-medium">Name</th>
            <th class="pb-2 pr-3 font-medium">Company</th>
            <th class="pb-2 font-medium text-right">Amount</th>
            <th class="pb-2 font-medium text-right">Renewal Date</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in renewals" :key="r.key" class="border-b border-gray-50">
            <td class="sticky-col py-2.5 pr-3 text-gray-900">{{ r.name }}</td>
            <td class="py-2.5 text-gray-500">{{ r.company || '—' }}</td>
            <td class="py-2.5 text-right text-gray-900">{{ formatCents(r.amount) }}</td>
            <td class="py-2.5 text-right text-gray-500">{{ formatRenewalDate(r) }}</td>
          </tr>
        </tbody>
      </table>
      </div>
      <p v-else class="text-sm text-gray-400 py-4 text-center">No renewals in the next {{ RENEWAL_DAYS }} days</p>
    </div>
  </div>
</div>
  `,
};
