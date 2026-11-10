import { query, execute } from '../db.js';
import { formatCents, monthLabel, generateMonthRange, currentMonth, prevMonth, getReportingCurrency } from '../utils.js';
import { payrollCategory } from '../payroll.js';
import { loadAccounts, loadBalances, cashTotals, accountLabel, monthEnd, cashPosition, cashSourceText } from '../bank.js';
import { loadLiveBalances } from '../liveBalances.js';
import { loadRunway, formatRunway } from '../charges.js';
import { loadMrrTotals } from '../profitwell.js';

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
    const mrrVersion = inject('mrrVersion', Vue.ref(0));
    const toast = inject('toast');

    const loading = ref(true);
    const waterfall = ref([]);
    const fundingEvents = ref([]);
    const accounts = ref([]);
    const balances = ref({});
    const totalsByMonth = ref({});
    const bankMonths = ref(new Set());
    const fxErrors = ref([]);
    const months = ref([]);

    const currentCash = ref(0);
    const cashSource = ref(''); // shown under Cash Balance when live balances are used
    const burnRate = ref(0);

    const showModal = ref(false);
    const editingId = ref(null);
    const form = reactive({ name: '', month: '', amount: '', notes: '' });

    const chartRef = ref(null);
    let chart = null;

    // How long today's cash covers the upcoming charges (days), else cash / monthly burn (weeks or months)
    const runway = ref({ unit: 'none' });
    const runwayText = computed(() => formatRunway(runway.value));
    const runwayTone = computed(() => {
      const r = runway.value;
      if (r.unit === 'positive') return 'text-emerald-600';
      if (r.unit === 'days') return r.value < 14 ? 'text-red-600' : 'text-amber-600';
      return (r.months ?? 99) < 6 ? 'text-red-600' : 'text-gray-900';
    });
    const runwayWhen = computed(() => {
      const r = runway.value;
      if (r.unit !== 'days') return '';
      const when = r.value === 0 ? 'today' : r.runsOutOn.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
      const c = r.blockedBy;
      return `Cash runs out ${when}${c ? ', before ' + (c.kind === 'payroll' ? `payroll (${c.name})` : c.name) : ''}`;
    });

    // Only the latest load may show its results: an earlier one can finish after it
    let loadSeq = 0;
    async function loadData() {
      const run = ++loadSeq;
      // On a fresh page load the scenario arrives a moment later, and loads the page then
      if (!scenarioId.value) return;
      loading.value = true;
      try {
        const range = dateRange.value;
        if (!range?.start || !range?.end) return;
        const sid = scenarioId.value;
        const ms = generateMonthRange(range.start, range.end);
        months.value = ms;

        const [revRows, expRows, empRows, fundRows, acc, bal, imports] = await Promise.all([
          loadMrrTotals(sid, ms[0], ms[ms.length - 1]),
          query(`SELECT ev.month, ec.name AS category, COALESCE(SUM(ev.amount), 0) AS total
                 FROM expense_values ev
                 JOIN expense_items ei ON ev.expense_item_id = ei.id
                 JOIN expense_categories ec ON ei.category_id = ec.id
                 WHERE ev.scenario_id = ? AND ev.month >= ? AND ev.month <= ?
                 GROUP BY ev.month, ec.name`, [sid, ms[0], ms[ms.length - 1]]),
          query(`SELECT id, department, salary_monthly, tax_pct, start_date, end_date FROM employees`),
          // A scenario's own events, plus received funding (recorded once, in the base scenario, for every scenario)
          query(`SELECT * FROM funding_events WHERE scenario_id = ? OR is_actual = 1 ORDER BY month`, [sid]).catch(() =>
            query(`SELECT * FROM funding_events WHERE scenario_id = ? ORDER BY month`, [sid])),
          loadAccounts(),
          loadBalances(),
          query('SELECT account_id, period_start, period_end FROM statement_imports').catch(() => []),
        ]);
        if (run !== loadSeq) return;
        accounts.value = acc;
        balances.value = bal;
        const totals = await cashTotals(acc, bal);
        if (run !== loadSeq) return;
        totalsByMonth.value = totals;
        fxErrors.value = [...new Set(Object.values(totals).flatMap(t => t.errors))];

        // Bank months: every account has a statement covering the whole month. Their flows come from the bank.
        const covers = (i, m) => i.period_start <= `${m}-01` && i.period_end >= monthEnd(m);
        const bankSet = new Set(ms.filter(m => acc.length && acc.every(a => imports.some(i => i.account_id === a.id && covers(i, m)))));
        bankMonths.value = bankSet;
        const bankLines = bankSet.size ? await query(`SELECT bt.month, bt.kind, bt.amount_reporting AS amount, ec.name AS category, e.department
            FROM bank_transactions bt
            LEFT JOIN expense_items ei ON ei.id = bt.expense_item_id
            LEFT JOIN expense_categories ec ON ec.id = ei.category_id
            LEFT JOIN employees e ON e.id = bt.employee_id
            WHERE bt.month IN (${[...bankSet].map(() => '?').join(',')}) AND bt.kind NOT IN ('transfer', 'ignore')`, [...bankSet]) : [];
        if (run !== loadSeq) return;

        const revMap = revRows;

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
            const catName = payrollCategory(emp.department, deptMapping);
            payrollMap[m][catName] = (payrollMap[m][catName] || 0) + cost;
          }
        }

        const fundMap = {};
        fundRows.forEach(r => { fundMap[r.month] = (fundMap[r.month] || 0) + r.amount; });
        fundingEvents.value = fundRows;

        const bankFlows = {};
        for (const l of bankLines) {
          const f = bankFlows[l.month] ||= { revenue: 0, funding: 0, otherIn: 0, cats: {} };
          if (l.kind === 'revenue') f.revenue += l.amount;
          else if (l.kind === 'funding') f.funding += l.amount;
          else if (['interest', 'tax_refund', 'other_income'].includes(l.kind)) f.otherIn += l.amount;
          else {
            const cat = l.kind === 'salary' ? payrollCategory(l.department, deptMapping) : (l.category || 'Uncategorized / Other');
            f.cats[cat] = (f.cats[cat] || 0) - l.amount; // money out is negative on the statement
          }
        }

        // A month-end total anchors the waterfall only when every account has a balance for that month
        const known = m => totals[m]?.complete ? totals[m].total : undefined;
        const rows = [];
        let prevEnd = known(prevMonth(ms[0])) ?? 0;

        for (const m of ms) {
          const startCash = known(prevMonth(m)) !== undefined ? known(prevMonth(m)) : prevEnd;
          const isBank = bankSet.has(m);
          const bf = bankFlows[m] || { revenue: 0, funding: 0, otherIn: 0, cats: {} };
          const revenue = isBank ? bf.revenue : (revMap[m] || 0);
          const funding = isBank ? bf.funding : (fundMap[m] || 0);
          const otherIn = isBank ? bf.otherIn : 0;
          const cats = {};
          let totalOut = 0;
          for (const c of CAT_ROWS) {
            const amt = isBank ? (bf.cats[c.db] || 0) : ((expMap[m] || {})[c.db] || 0) + ((payrollMap[m] || {})[c.db] || 0);
            cats[c.key] = amt;
            totalOut += amt;
          }
          const net = revenue + funding + otherIn - totalOut;
          // In bank months the recorded month-end total is the truth; any gap is exchange-rate movement or missing lines
          const actualEnd = isBank && totals[m]?.complete ? totals[m].total : undefined;
          const endCash = actualEnd !== undefined ? actualEnd : startCash + net;
          const unexplained = actualEnd !== undefined ? actualEnd - (startCash + net) : 0;
          rows.push({ month: m, isBank, startCash, revenue, funding, otherIn, ...cats, unexplained, net: net + unexplained, endCash });
          prevEnd = endCash;
        }
        waterfall.value = rows;

        const cm = currentMonth();
        const latest = rows.find(r => r.month === cm) || rows[rows.length - 1];
        // With live balances (Wise, Airwallex; refreshed when more than a day old), the card shows today's cash
        const position = await loadLiveBalances(settings.value).catch(() => null).then(() => cashPosition()).catch(() => null);
        if (run !== loadSeq) return;
        cashSource.value = position?.liveCount ? cashSourceText(position) : '';
        if (latest) {
          currentCash.value = position?.liveCount ? position.total : latest.endCash;
          const totalExp = latest.cogs + latest.rd + latest.sm + latest.ga + latest.other;
          burnRate.value = totalExp - latest.revenue;
        }
        runway.value = await loadRunway(sid, currentCash.value, burnRate.value, settings.value);
        if (run !== loadSeq) return;
      } catch (e) {
        if (run === loadSeq) toast('Failed to load cash flow: ' + e.message, 'error');
      } finally {
        if (run === loadSeq) {
          loading.value = false;
          await nextTick();
          renderChart();
        }
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

    // Month-end balance typed by hand, in the account's currency. Clearing the box removes it.
    async function saveBalance(accountId, month, val) {
      const current = balances.value[month]?.[accountId];
      try {
        if (val === '' || val === null) {
          if (current === undefined) return;
          await execute('DELETE FROM bank_balances WHERE account_id = ? AND month = ?', [accountId, month]);
        } else {
          const cents = Math.round(parseFloat(val) * 100);
          if (Number.isNaN(cents) || cents === current) return;
          await execute(`INSERT INTO bank_balances (account_id, month, balance, source) VALUES (?, ?, ?, 'manual')
            ON CONFLICT(account_id, month) DO UPDATE SET balance = excluded.balance, source = 'manual', import_id = NULL`, [accountId, month, cents]);
        }
        await loadData();
      } catch (e) { toast('Save failed: ' + e.message, 'error'); }
    }

    function centsToInput(c) { return c != null ? (c / 100).toFixed(2) : ''; }

    onMounted(() => loadData());
    onBeforeUnmount(() => destroyChart());
    watch(() => [scenarioId.value, dateRange.value, mrrVersion.value], () => loadData(), { deep: true });

    return {
      loading, waterfall, months, fundingEvents, accounts, balances, totalsByMonth, fxErrors, accountLabel,
      currency: computed(() => getReportingCurrency()),
      currentCash, cashSource, burnRate, runway, runwayText, runwayTone, runwayWhen,
      showModal, editingId, form, chartRef,
      openAdd, openEdit, saveFunding, deleteFunding,
      saveBalance, centsToInput,
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
        <div v-if="cashSource" class="text-xs text-gray-400 mt-1">{{ cashSource }}</div>
      </div>
      <div class="bg-white rounded-xl border border-gray-200 p-5">
        <div class="text-xs font-medium text-gray-500 uppercase tracking-wider mb-1">Monthly Burn Rate</div>
        <div class="text-2xl font-bold" :class="burnRate <= 0 ? 'text-emerald-600' : 'text-gray-900'">
          {{ burnRate <= 0 ? 'Net Positive' : formatCents(burnRate) }}
        </div>
      </div>
      <div class="bg-white rounded-xl border border-gray-200 p-5">
        <div class="text-xs font-medium text-gray-500 uppercase tracking-wider mb-1">Runway</div>
        <div class="text-2xl font-bold" :class="runwayTone">
          {{ runway.unit === 'positive' ? '\\u221E' : runway.unit === 'none' ? 'No data' : runwayText.value + ' ' + runwayText.unit }}
        </div>
        <div v-if="runwayWhen" class="text-xs text-gray-500 mt-1">{{ runwayWhen }}</div>
      </div>
    </div>

    <!-- Waterfall Table -->
    <div class="bg-white rounded-xl border border-gray-200">
      <h2 class="text-sm font-semibold text-gray-700 px-5 pt-5 mb-3">Cash Flow Waterfall</h2>
      <div class="overflow-x-auto">
        <table class="w-full text-xs whitespace-nowrap">
          <thead>
            <tr class="border-b border-gray-200 text-gray-500 uppercase tracking-wider">
              <th class="text-left py-2 px-4 font-medium sticky left-0 whitespace-normal md:whitespace-nowrap w-36 md:w-auto bg-white z-10 min-w-[9rem] md:min-w-[200px]"></th>
              <th v-for="r in waterfall" :key="r.month" class="text-right py-2 px-3 font-medium min-w-[100px]">
                <div>{{ monthLabel(r.month) }}</div>
                <div :class="['text-[10px] normal-case tracking-normal font-normal', r.isBank ? 'text-emerald-600' : 'text-gray-400']" :title="r.isBank ? 'From bank statements' : 'From the plan'">{{ r.isBank ? 'Bank' : 'Plan' }}</div>
              </th>
            </tr>
          </thead>
          <tbody class="text-sm">
            <tr class="border-b border-gray-100">
              <td class="py-2 px-4 font-medium text-gray-700 sticky left-0 whitespace-normal md:whitespace-nowrap w-36 md:w-auto bg-white z-10">Starting Cash Balance</td>
              <td v-for="r in waterfall" :key="r.month" class="text-right py-2 px-3 text-gray-900">{{ formatCents(r.startCash) }}</td>
            </tr>
            <tr class="border-b border-gray-100 bg-emerald-50/50">
              <td class="py-2 px-4 text-emerald-700 sticky left-0 whitespace-normal md:whitespace-nowrap w-36 md:w-auto bg-emerald-50/50 z-10" title="Plan months: MRR from ProfitWell and the planned growth. Bank months: money received from customers.">+ Revenue (received in bank months)</td>
              <td v-for="r in waterfall" :key="r.month" class="text-right py-2 px-3 text-emerald-700">{{ formatCents(r.revenue) }}</td>
            </tr>
            <tr class="border-b border-gray-100 bg-emerald-50/50">
              <td class="py-2 px-4 text-emerald-700 sticky left-0 whitespace-normal md:whitespace-nowrap w-36 md:w-auto bg-emerald-50/50 z-10">+ Funding / Cash Injections</td>
              <td v-for="r in waterfall" :key="r.month" class="text-right py-2 px-3 text-emerald-700">{{ formatCents(r.funding) }}</td>
            </tr>
            <tr v-if="waterfall.some(r => r.otherIn)" class="border-b border-gray-100 bg-emerald-50/50">
              <td class="py-2 px-4 text-emerald-700 sticky left-0 whitespace-normal md:whitespace-nowrap w-36 md:w-auto bg-emerald-50/50 z-10">+ Interest, tax refunds, other</td>
              <td v-for="r in waterfall" :key="r.month" class="text-right py-2 px-3 text-emerald-700">{{ formatCents(r.otherIn) }}</td>
            </tr>
            <tr v-for="cat in CAT_ROWS" :key="cat.key" class="border-b border-gray-100">
              <td class="py-2 px-4 text-red-700 sticky left-0 whitespace-normal md:whitespace-nowrap w-36 md:w-auto bg-white z-10">- {{ cat.label }}</td>
              <td v-for="r in waterfall" :key="r.month" class="text-right py-2 px-3 text-red-700">{{ formatCents(r[cat.key]) }}</td>
            </tr>
            <tr v-if="waterfall.some(r => r.unexplained)" class="border-b border-gray-100">
              <td class="py-2 px-4 text-gray-500 sticky left-0 whitespace-normal md:whitespace-nowrap w-36 md:w-auto bg-white z-10" title="Difference between the bank balances and the flows above: exchange-rate movements between months, or lines not linked">± Exchange rates and unlinked lines</td>
              <td v-for="r in waterfall" :key="r.month" class="text-right py-2 px-3 text-gray-500">{{ r.unexplained ? formatCents(r.unexplained) : '' }}</td>
            </tr>
            <tr class="border-b border-gray-200 bg-gray-50 font-semibold">
              <td class="py-2.5 px-4 text-gray-900 sticky left-0 whitespace-normal md:whitespace-nowrap w-36 md:w-auto bg-gray-50 z-10">Net Cash Flow</td>
              <td v-for="r in waterfall" :key="r.month" class="text-right py-2.5 px-3" :class="r.net >= 0 ? 'text-emerald-700' : 'text-red-700'">{{ formatCents(r.net) }}</td>
            </tr>
            <tr class="font-bold">
              <td class="py-2.5 px-4 text-gray-900 sticky left-0 whitespace-normal md:whitespace-nowrap w-36 md:w-auto bg-white z-10">Ending Cash Balance</td>
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
      <div class="flex items-center justify-between flex-wrap gap-2 mb-4">
        <h2 class="text-sm font-semibold text-gray-700">Funding Events</h2>
        <button @click="openAdd" class="text-sm text-indigo-600 hover:text-indigo-700 font-medium">+ Add</button>
      </div>
      <div v-if="fundingEvents.length > 0" class="overflow-x-auto">
      <table class="w-full text-sm whitespace-nowrap">
        <thead>
          <tr class="text-left text-xs text-gray-500 uppercase tracking-wider border-b border-gray-100">
            <th class="sticky-col pb-2 pr-3 font-medium">Name</th>
            <th class="pb-2 pr-3 font-medium">Month</th>
            <th class="pb-2 font-medium text-right">Amount</th>
            <th class="pb-2 font-medium">Notes</th>
            <th class="pb-2 font-medium text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="ev in fundingEvents" :key="ev.id" class="border-b border-gray-50">
            <td class="sticky-col py-2.5 pr-3 text-gray-900">{{ ev.name }} <span v-if="ev.is_actual" class="ml-1 inline-flex px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 text-xs">Received</span></td>
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
      </div>
      <p v-else class="text-sm text-gray-400 text-center py-4">No funding events for this scenario</p>
    </div>

    <!-- Month-end balances, per bank account -->
    <div class="bg-white rounded-xl border border-gray-200 p-5">
      <div class="flex items-center justify-between mb-1 flex-wrap gap-2">
        <h2 class="text-sm font-semibold text-gray-700">Month-end Bank Balances</h2>
        <router-link to="/statements" class="text-sm text-indigo-600 hover:text-indigo-700">Import bank statements</router-link>
      </div>
      <p class="text-xs text-gray-400 mb-3">Each account in its own currency. Statements fill these in; you can also type a balance. Total cash is the sum, converted into {{ currency }} at each month-end rate.</p>
      <p v-for="e in fxErrors" :key="e" class="text-xs text-red-600 mb-2">{{ e }}</p>
      <div class="overflow-x-auto">
        <table class="text-sm">
          <thead>
            <tr class="text-left text-xs text-gray-500 uppercase tracking-wider border-b border-gray-100">
              <th class="sticky-col pb-2 pr-4 font-medium">Month</th>
              <th v-for="a in accounts" :key="a.id" class="pb-2 pr-3 font-medium whitespace-nowrap">{{ accountLabel(a) }} ({{ a.currency }})</th>
              <th class="pb-2 font-medium text-right whitespace-nowrap">Total ({{ currency }})</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="m in months" :key="m" class="border-b border-gray-50">
              <td class="sticky-col py-2 pr-4 text-gray-700 whitespace-nowrap">{{ monthLabel(m) }}</td>
              <td v-for="a in accounts" :key="a.id" class="py-2 pr-3">
                <input type="number" step="0.01"
                  :value="centsToInput(balances[m] && balances[m][a.id])"
                  @blur="saveBalance(a.id, m, $event.target.value)"
                  :aria-label="accountLabel(a) + ' balance at the end of ' + monthLabel(m)"
                  class="w-36 px-2 py-1 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  placeholder="—"/>
              </td>
              <td class="py-2 text-right tabular-nums whitespace-nowrap" :class="totalsByMonth[m] && !totalsByMonth[m].complete ? 'text-gray-400' : 'text-gray-900'"
                :title="totalsByMonth[m] && !totalsByMonth[m].complete ? 'Some accounts have no balance for this month' : ''">
                {{ totalsByMonth[m] ? formatCents(totalsByMonth[m].total) : '' }}<span v-if="totalsByMonth[m] && !totalsByMonth[m].complete"> (partial)</span>
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
          <label class="block text-sm font-medium text-gray-700 mb-1">Amount ({{ currency }})</label>
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
