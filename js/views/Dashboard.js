import { query } from '../db.js';
import { cashPosition, cashSourceText } from '../bank.js';
import { loadLiveBalances } from '../liveBalances.js';
import { loadMrrSeries, mrrChartDatasets, mrrRevenueLine } from '../profitwell.js';
import { loadScenarioEmployees, employeeCost, isEmployedIn } from '../payroll.js';
import {
  formatCents, formatPct, formatDelta, monthLabel,
  currentMonth, prevMonth, ordinalDay,
} from '../utils.js';
import { loadExpenseValues, computeUpcomingCharges, computePayrollCharges, horizonMonth } from '../charges.js';

const RENEWAL_DAYS = 7;

const COLORS = ['#6366f1', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6'];
const REVENUE_LINE = '_revenue'; // hidden dataset the expenses line shades against (not in legend or tooltip)

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
    const cashSource = ref(''); // where the cash figure comes from (live balances, statements)
    const totalExpenses = ref(0), totalPayroll = ref(0);
    const mrrSeries = ref(null), expensesByCat = ref([]);
    const employees = ref([]), renewals = ref([]), payrollDue = ref([]);
    const expensesByMonth = ref({}); // cents, expenses + payroll, for the chart's months
    const mrrCanvasRef = ref(null), expenseCanvasRef = ref(null), teamCanvasRef = ref(null);
    let charts = [];

    const hasMrr = computed(() => !!mrrSeries.value && mrrSeries.value.months.some(m => mrrSeries.value.totals[m]));

    // Next 7 days: what the listed charges add up to, and payroll falling in the same days
    const sumOf = list => list.reduce((s, c) => s + c.amount, 0);
    const renewalsTotal = computed(() => sumOf(renewals.value));
    const payrollTotal = computed(() => sumOf(payrollDue.value));
    const grandTotal = computed(() => renewalsTotal.value + payrollTotal.value);
    const payrollLabel = computed(() => {
      const list = payrollDue.value;
      if (!list.length) return '';
      const people = new Set(list.map(c => c.key.split(':')[1])).size;
      const days = [...new Set(list.map(c => c.date.getTime()))];
      const when = days.length === 1
        ? ' · ' + list[0].date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) : '';
      return `${people} ${people === 1 ? 'person' : 'people'}${when}`;
    });

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
        const [series, cash, expenses, scenarioEmp, mrrAround, expCat, empRows, renewItems, renewValues, expMonths] =
          await Promise.all([
            loadMrrSeries(sid, start, end),
            // Live balances are refreshed first when the cached ones are more than a day old
            loadLiveBalances(settings.value).catch(() => null).then(() => cashPosition()).catch(() => null),
            query(`SELECT COALESCE(SUM(amount), 0) AS v FROM expense_values WHERE scenario_id = ? AND month = ?`, [sid, month]),
            loadScenarioEmployees(sid),
            loadMrrSeries(sid, prev, month),
            query(`SELECT ec.name AS category, COALESCE(SUM(ev.amount), 0) AS total FROM expense_values ev JOIN expense_items ei ON ev.expense_item_id = ei.id JOIN expense_categories ec ON ei.category_id = ec.id WHERE ev.scenario_id = ? AND ev.month = ? GROUP BY ec.name ORDER BY total DESC`, [sid, month]),
            query(`SELECT name, department FROM employees WHERE start_date <= ? AND (end_date IS NULL OR end_date >= ?)`, [month + '-31', month + '-01']),
            query(`SELECT ei.*, (SELECT MAX(bt.date) FROM bank_transactions bt WHERE bt.expense_item_id = ei.id AND bt.kind = 'expense') AS last_charge_date FROM expense_items ei WHERE ei.visible = 1`),
            loadExpenseValues(sid, month, horizonMonth(RENEWAL_DAYS)),
            query(`SELECT month, COALESCE(SUM(amount), 0) AS total FROM expense_values
                   WHERE scenario_id = ? AND month >= ? AND month <= ? GROUP BY month`, [sid, start, end]),
          ]);
        if (run !== loadSeq) return;

        revenueNow.value = mrrAround.totals[month] || 0;
        revenuePrev.value = mrrAround.totals[prev] || 0;
        cashBalance.value = cash ? cash.total : null;
        cashSource.value = cashSourceText(cash);
        totalExpenses.value = expenses[0]?.v || 0;
        // The scenario's people (base employees with its changes, plus its own hires), as on the Payroll page
        const people = scenarioEmp.employees;
        const payrollIn = m => people.filter(e => isEmployedIn(e, m)).reduce((s, e) => s + employeeCost(e), 0);
        totalPayroll.value = payrollIn(month);

        mrrSeries.value = series;
        const expMap = Object.fromEntries(expMonths.map(r => [r.month, r.total]));
        expensesByMonth.value = Object.fromEntries(series.months.map(m => [m, (expMap[m] || 0) + payrollIn(m)]));
        expensesByCat.value = expCat;
        employees.value = empRows;

        // Same charges as the Upcoming Charges page, soonest first
        renewals.value = computeUpcomingCharges(renewItems, renewValues, RENEWAL_DAYS);
        payrollDue.value = computePayrollCharges(people, RENEWAL_DAYS, settings.value?.payroll_pay_day, settings.value?.dept_mapping);
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
      // Path to profitability: MRR and expenses (incl. payroll); the gap is shaded red where expenses are higher
      // (burn) and green where MRR is higher (profit)
      const s = mrrSeries.value;
      if (s && s.months.length) {
        const expenses = s.months.map(m => (expensesByMonth.value[m] || 0) / 100);
        const revenue = mrrRevenueLine(s);
        const datasets = [];
        if (hasMrr.value) {
          datasets.push(...mrrChartDatasets(s).map(d => ({ ...d, fill: false })));
          datasets.push({ label: REVENUE_LINE, data: revenue, borderColor: 'transparent', backgroundColor: 'transparent',
            borderWidth: 0, pointRadius: 0, pointHoverRadius: 0, pointHitRadius: 0, fill: false, tension: 0.3 });
        }
        datasets.push({
          label: 'Expenses (inc. payroll)', data: expenses, borderColor: '#ef4444', backgroundColor: '#ef4444',
          tension: 0.3, pointRadius: 2, borderWidth: 2,
          fill: hasMrr.value
            ? { target: datasets.length - 1, above: 'rgba(239,68,68,0.15)', below: 'rgba(16,185,129,0.18)' }
            : false,
        });
        makeChart(mrrCanvasRef, {
          type: 'line',
          data: { labels: s.months.map(monthLabel), datasets },
          options: { responsive: true, maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
              legend: { position: 'bottom', labels: { usePointStyle: true, boxWidth: 8, filter: i => i.text !== REVENUE_LINE } },
              tooltip: {
                filter: i => i.dataset.label !== REVENUE_LINE && i.raw !== null,
                callbacks: {
                  label: c => `${c.dataset.label}: ${centsTooltip(c)}`,
                  footer: items => {
                    if (!hasMrr.value || !items.length) return '';
                    const i = items[0].dataIndex;
                    const gap = Math.round((expenses[i] - revenue[i]) * 100);
                    return gap > 0 ? `Burn: ${formatCents(gap)}` : `Profit: ${formatCents(-gap)}`;
                  },
                },
              },
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
      loading, mrr, mrrDelta, arr, arrDelta, cashBalance, cashSource, burnRate, runway,
      headcount, deptBreakdown, mrrSeries, hasMrr, expensesByCat, renewals, payrollDue, renewalsTotal, payrollTotal, grandTotal, payrollLabel,
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
      <kpi-card title="Cash Balance" :value="cashBalance !== null ? cashBalance : 'No data'" :format="cashBalance !== null ? 'currency' : 'text'" :subtitle="cashSource" />
      <kpi-card title="Monthly Burn Rate" :value="burnRate <= 0 ? 'Net Positive' : burnRate" :format="burnRate <= 0 ? 'text' : 'currency'" />
    </div>
    <!-- Row 2: Charts -->
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <div class="bg-white rounded-xl border border-gray-200 p-5">
        <h2 class="text-sm font-semibold text-gray-700 mb-4">Path to profitability <span class="font-normal text-gray-400">MRR vs expenses incl. payroll</span></h2>
        <div style="height:280px"><canvas ref="mrrCanvasRef" role="img" aria-label="MRR and expenses including payroll by month; the gap is shaded red where expenses are higher and green where MRR is higher"></canvas></div>
        <p v-if="!hasMrr" class="text-xs text-gray-400 text-center mt-2">No MRR for this period. Sync ProfitWell in Settings.</p>
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
      <div v-if="renewals.length || payrollDue.length" class="overflow-x-auto">
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
            <td class="py-2.5 text-right text-gray-500" :title="r.estimated ? 'Estimated from the monthly spend' : ''">{{ r.estimated ? '≈ ' : '' }}{{ formatRenewalDate(r) }}</td>
          </tr>
          <tr v-if="!renewals.length"><td colspan="4" class="py-2.5 text-gray-400">No renewals</td></tr>
        </tbody>
        <tfoot class="text-sm">
          <!-- Sub-lines, muted, then the total: a heavier rule, a tinted band and a larger bold amount -->
          <tr v-if="renewals.length" class="text-gray-500">
            <td colspan="2" class="sticky-col pt-3 pr-3" style="box-shadow:none">Renewals</td>
            <td class="pt-3 text-right tabular-nums">{{ formatCents(renewalsTotal) }}</td>
            <td></td>
          </tr>
          <tr v-if="payrollDue.length" class="text-gray-500">
            <td colspan="2" class="sticky-col pt-1 pr-3" style="box-shadow:none">Payroll due <span class="text-gray-400">{{ payrollLabel }}</span></td>
            <td class="pt-1 text-right tabular-nums">{{ formatCents(payrollTotal) }}</td>
            <td></td>
          </tr>
          <tr class="border-t-2 border-gray-300 bg-gray-50">
            <td colspan="2" class="sticky-col py-3 pl-2 pr-3 font-semibold text-gray-900" style="background-color:#f9fafb;box-shadow:none">Total due in the next {{ RENEWAL_DAYS }} days</td>
            <td class="py-3 text-right text-base font-bold text-gray-900 tabular-nums">{{ formatCents(grandTotal) }}</td>
            <td class="bg-gray-50"></td>
          </tr>
        </tfoot>
      </table>
      </div>
      <p v-else class="text-sm text-gray-400 py-4 text-center">No renewals or payroll in the next {{ RENEWAL_DAYS }} days</p>
    </div>
  </div>
</div>
  `,
};
