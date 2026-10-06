import { query } from '../db.js';
import {
  formatCents, formatPct, formatDelta, monthLabel,
  generateMonthRange, currentMonth, prevMonth, ordinalDay,
} from '../utils.js';

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

    const loading = ref(true);
    const revenueNow = ref(0), revenuePrev = ref(0);
    const cashBalance = ref(null);
    const totalExpenses = ref(0), totalPayroll = ref(0);
    const mrrSeries = ref([]), expensesByCat = ref([]);
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

    async function loadData() {
      loading.value = true;
      const sid = scenarioId.value, month = currentMonth(), prev = prevMonth(month);
      const range = dateRange.value;
      try {
        const [revNow, revPrev, cash, expenses, payroll, mrrRows, expCat, empRows, renewRows] =
          await Promise.all([
            query(`SELECT COALESCE(SUM(customers * arpu), 0) AS v FROM revenue_values WHERE scenario_id = ? AND month = ?`, [sid, month]),
            query(`SELECT COALESCE(SUM(customers * arpu), 0) AS v FROM revenue_values WHERE scenario_id = ? AND month = ?`, [sid, prev]),
            query(`SELECT balance FROM cash_actuals ORDER BY month DESC LIMIT 1`),
            query(`SELECT COALESCE(SUM(amount), 0) AS v FROM expense_values WHERE scenario_id = ? AND month = ?`, [sid, month]),
            query(`SELECT salary_monthly, tax_pct FROM employees WHERE start_date <= ? AND (end_date IS NULL OR end_date >= ?)`, [month + '-31', month + '-01']),
            query(`SELECT month, COALESCE(SUM(customers * arpu), 0) AS mrr FROM revenue_values WHERE scenario_id = ? AND month >= ? AND month <= ? GROUP BY month ORDER BY month`, [sid, range?.start || month, range?.end || month]),
            query(`SELECT ec.name AS category, COALESCE(SUM(ev.amount), 0) AS total FROM expense_values ev JOIN expense_items ei ON ev.expense_item_id = ei.id JOIN expense_categories ec ON ei.category_id = ec.id WHERE ev.scenario_id = ? AND ev.month = ? GROUP BY ec.name ORDER BY total DESC`, [sid, month]),
            query(`SELECT name, department FROM employees WHERE start_date <= ? AND (end_date IS NULL OR end_date >= ?)`, [month + '-31', month + '-01']),
            query(`SELECT ei.name, ei.company, ev.amount, ei.renewal_day, ei.recurrence FROM expense_items ei JOIN expense_values ev ON ev.expense_item_id = ei.id WHERE ev.scenario_id = ? AND ev.month = ? AND ei.renewal_day IS NOT NULL ORDER BY ei.renewal_day ASC`, [sid, month]),
          ]);

        revenueNow.value = revNow[0]?.v || 0;
        revenuePrev.value = revPrev[0]?.v || 0;
        cashBalance.value = cash.length ? cash[0].balance : null;
        totalExpenses.value = expenses[0]?.v || 0;
        totalPayroll.value = payroll.reduce((s, e) => s + Math.round(e.salary_monthly * (1 + (e.tax_pct || 0) / 100)), 0);

        const months = range ? generateMonthRange(range.start, range.end) : [month];
        const mrrMap = {}; mrrRows.forEach(r => { mrrMap[r.month] = r.mrr; });
        mrrSeries.value = months.map(m => ({ month: m, mrr: mrrMap[m] || 0 }));
        expensesByCat.value = expCat;
        employees.value = empRows;

        const now = new Date();
        renewals.value = renewRows.filter(r => {
          if (!r.renewal_day) return false;
          const d = new Date(now.getFullYear(), now.getMonth(), r.renewal_day);
          if (d < now) d.setMonth(d.getMonth() + 1);
          return (d - now) / 864e5 <= 30;
        });
      } catch (e) { console.error('Dashboard load error:', e); }
      finally { loading.value = false; await nextTick(); renderCharts(); }
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
      if (mrrSeries.value.length) {
        const at = settings.value?.actuals_through;
        const annotationPlugin = at ? { annotation: { annotations: { boundary: {
          type: 'line', xMin: monthLabel(at), xMax: monthLabel(at),
          borderColor: '#9ca3af', borderWidth: 1.5, borderDash: [6, 4],
          label: { content: 'Actuals / Forecast', enabled: true, position: 'start', font: { size: 10 }, color: '#9ca3af' },
        }}}} : {};
        makeChart(mrrCanvasRef, {
          type: 'line',
          data: { labels: mrrSeries.value.map(d => monthLabel(d.month)), datasets: [{
            label: 'MRR', data: mrrSeries.value.map(d => d.mrr / 100),
            borderColor: '#6366f1', backgroundColor: 'rgba(99,102,241,0.08)',
            fill: true, tension: 0.3, pointRadius: 2, pointHoverRadius: 5,
          }]},
          options: { responsive: true, maintainAspectRatio: false,
            plugins: { legend: { display: false }, tooltip: { callbacks: { label: centsTooltip } }, ...annotationPlugin },
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
    watch(() => [scenarioId.value, dateRange.value], () => loadData(), { deep: true });

    function formatRenewalDate(item) {
      const now = new Date();
      const d = new Date(now.getFullYear(), now.getMonth(), item.renewal_day);
      if (d < now) d.setMonth(d.getMonth() + 1);
      const ml = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      return `${ml[d.getMonth()]} ${ordinalDay(d.getDate())}`;
    }

    return {
      loading, mrr, mrrDelta, arr, arrDelta, cashBalance, burnRate, runway,
      headcount, deptBreakdown, mrrSeries, expensesByCat, renewals,
      mrrCanvasRef, expenseCanvasRef, teamCanvasRef, formatCents, formatRenewalDate,
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
        <p v-if="mrrSeries.length === 0" class="text-sm text-gray-400 text-center py-8">No revenue data for this period</p>
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
          <div v-if="deptBreakdown.length > 0" class="flex-1" style="height:140px">
            <canvas ref="teamCanvasRef"></canvas>
          </div>
          <div v-else class="text-sm text-gray-400">No employees found</div>
        </div>
      </div>
    </div>
    <!-- Row 4: Upcoming Renewals -->
    <div class="bg-white rounded-xl border border-gray-200 p-5">
      <h2 class="text-sm font-semibold text-gray-700 mb-4">Upcoming Renewals</h2>
      <table v-if="renewals.length > 0" class="w-full text-sm">
        <thead>
          <tr class="text-left text-xs text-gray-500 uppercase tracking-wider border-b border-gray-100">
            <th class="pb-2 font-medium">Name</th>
            <th class="pb-2 font-medium">Company</th>
            <th class="pb-2 font-medium text-right">Amount</th>
            <th class="pb-2 font-medium text-right">Renewal Date</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in renewals" :key="r.name + r.renewal_day" class="border-b border-gray-50">
            <td class="py-2.5 text-gray-900">{{ r.name }}</td>
            <td class="py-2.5 text-gray-500">{{ r.company || '—' }}</td>
            <td class="py-2.5 text-right text-gray-900">{{ formatCents(r.amount) }}</td>
            <td class="py-2.5 text-right text-gray-500">{{ formatRenewalDate(r) }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else class="text-sm text-gray-400 py-4 text-center">No renewals in the next 30 days</p>
    </div>
  </div>
</div>
  `,
};
