// Revenue: MRR per product line from ProfitWell, grouped by family, and the planned growth that projects it forward.
// Past months are read-only (ProfitWell is the source of truth); each line's growth rate is set per scenario.
import { formatCents, monthLabel } from '../utils.js';
import { donutConfig } from '../miniCharts.js';
import { loadMrrSeries, saveGrowthRates, mrrChartDatasets } from '../profitwell.js';

const COLORS = ['#6366f1', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316'];

export default {
  name: 'RevenueView',
  setup() {
    const { ref, computed, onMounted, watch, inject } = Vue;
    const scenarioId = inject('scenarioId');
    const dateRange = inject('dateRange');
    const toast = inject('toast');
    const mrrVersion = inject('mrrVersion', ref(0));

    const series = ref(null);
    const loading = ref(true);
    const bulkRate = ref('');

    let loadSeq = 0;
    async function load() {
      const run = ++loadSeq;
      const dr = dateRange.value;
      if (!scenarioId.value || !dr?.start || !dr?.end) return;
      try {
        const s = await loadMrrSeries(scenarioId.value, dr.start, dr.end);
        if (run === loadSeq) series.value = s;
      } catch (e) {
        toast('Failed to load revenue: ' + e.message, 'error');
      } finally { if (run === loadSeq) loading.value = false; }
    }
    onMounted(load);
    watch(() => [scenarioId.value, dateRange.value, mrrVersion.value], load, { deep: true });

    const months = computed(() => series.value?.months || []);
    const isActual = m => series.value?.isActual(m);

    // Only lines with MRR somewhere in the period, grouped by family; families without such lines are hidden
    const visibleLines = computed(() => (series.value?.lines || []).filter(l => months.value.some(m => l.values[m]?.mrr)));
    const groups = computed(() => {
      const out = [];
      for (const l of visibleLines.value) {
        const key = l.family ? l.family.id : 'none';
        let g = out.find(x => x.key === key);
        if (!g) { g = { key, family: l.family, lines: [] }; out.push(g); }
        g.lines.push(l);
      }
      const order = f => f ? (series.value.families.findIndex(x => x.id === f.id)) : 1e9;
      return out.sort((a, b) => order(a.family) - order(b.family));
    });
    const subtotal = (g, m) => g.lines.reduce((s, l) => s + (l.values[m]?.mrr || 0), 0);
    const trendSubtotal = (g, m) => g.lines.reduce((s, l) => s + (l.trend[m] || 0), 0);

    // Headline: the last month ProfitWell has in full
    const lastActual = computed(() => series.value?.lastActual);
    const headlineMrr = computed(() => {
      const s = series.value; if (!s) return 0;
      return s.lines.reduce((sum, l) => sum + (l.values[s.lastActual]?.mrr ?? 0), 0);
    });
    const headlineCustomers = computed(() => {
      const s = series.value; if (!s) return 0;
      return s.lines.reduce((sum, l) => sum + (l.values[s.lastActual]?.customers ?? 0), 0);
    });

    const donut = computed(() => {
      const s = series.value;
      const live = visibleLines.value
        .map((l, i) => ({ name: l.line.name, value: l.values[s?.lastActual]?.mrr || 0, color: COLORS[i % COLORS.length] }))
        .filter(x => x.value > 0);
      return donutConfig(live.map(x => x.name), live.map(x => x.value), live.map(x => x.color));
    });

    const chartData = computed(() => {
      const s = series.value;
      if (!s || !visibleLines.value.length) return null;
      return { labels: s.months.map(monthLabel), datasets: mrrChartDatasets(s) };
    });
    const chartOptions = {
      plugins: {
        legend: { position: 'bottom', labels: { usePointStyle: true, boxWidth: 8, padding: 16 } },
        tooltip: { callbacks: { label: c => `${c.dataset.label}: ${formatCents(Math.round(c.parsed.y * 100))}` } },
      },
      scales: { y: { beginAtZero: true, ticks: { callback: v => formatCents(v * 100) }, grid: { color: '#f1f5f9' } }, x: { grid: { display: false } } },
    };

    // --- Growth rates ---
    const parseRate = raw => {
      const v = parseFloat(String(raw).replace(',', '.'));
      return Number.isFinite(v) && v > -100 && v < 1000 ? Math.round(v * 100) / 100 : null;
    };
    async function saveRate(line, raw) {
      const v = parseRate(raw);
      if (v === null) { toast('Enter a growth rate in % per month, e.g. 3', 'error'); return; }
      if (v === line.rate) return;
      try { await saveGrowthRates(scenarioId.value, [line.line.id], v); await load(); }
      catch (e) { toast('Failed to save: ' + e.message, 'error'); }
    }
    async function applyAll() {
      const v = parseRate(bulkRate.value);
      if (v === null) { toast('Enter a growth rate in % per month, e.g. 3', 'error'); return; }
      try {
        await saveGrowthRates(scenarioId.value, visibleLines.value.map(l => l.line.id), v);
        toast(`Planned growth set to ${v}% per month for ${visibleLines.value.length} lines`, 'success');
        bulkRate.value = '';
        await load();
      } catch (e) { toast('Failed to save: ' + e.message, 'error'); }
    }

    const fmtRate = r => `${r > 0 ? '+' : ''}${(Math.round(r * 10) / 10).toLocaleString()}%`;
    const short = m => m.split('-')[1] + '/' + m.split('-')[0].slice(2);

    return {
      series, loading, months, isActual, groups, visibleLines, subtotal, trendSubtotal, lastActual,
      headlineMrr, headlineCustomers, donut, chartData, chartOptions, bulkRate, saveRate, applyAll,
      formatCents, monthLabel, fmtRate, short,
    };
  },
  template: `
    <div class="space-y-6">
      <h1 class="text-2xl font-bold text-gray-900">Revenue</h1>

      <div v-if="loading" class="text-gray-400 py-12 text-center">Loading...</div>
      <template v-else>
        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <kpi-card :title="'MRR, ' + monthLabel(lastActual || '2000-01')" :value="headlineMrr" format="currency" :subtitle="formatCents(headlineMrr * 12) + ' ARR'" />
          <kpi-card title="Paying customers" :value="headlineCustomers" format="number" />
          <div class="bg-white rounded-xl border border-gray-200 p-5 lg:col-span-2">
            <span class="text-xs font-medium text-gray-500 uppercase tracking-wider">MRR by product line</span>
            <chart-wrapper v-if="donut.data.labels.length" type="doughnut" :data="donut.data" :options="donut.options" height="160px" class="mt-2" />
            <p v-else class="text-gray-400 text-sm text-center py-8">No MRR last month</p>
          </div>
        </div>

        <div v-if="chartData" class="bg-white rounded-xl border border-gray-200 p-5">
          <chart-wrapper type="line" :data="chartData" :options="chartOptions" height="280px" />
        </div>

        <div v-if="!visibleLines.length" class="bg-white rounded-xl border border-gray-200 p-8 text-center text-gray-500 text-sm">
          No MRR in this period. Sync ProfitWell and group its plans in <router-link to="/settings" class="text-indigo-600 hover:underline">Settings, Products</router-link>.
        </div>

        <div v-else class="bg-white rounded-xl border border-gray-200">
          <div class="flex flex-wrap items-center justify-between gap-3 px-5 py-4 border-b border-gray-200">
            <p class="text-sm text-gray-500">
              Months up to {{ monthLabel(lastActual) }} come from ProfitWell. Later months
              <span class="px-1.5 py-0.5 rounded bg-blue-50 text-blue-800">in blue</span> grow by each line's planned rate; hover one to see the recent trend.
            </p>
            <form @submit.prevent="applyAll" class="flex items-center gap-2">
              <label for="bulk-rate" class="text-sm text-gray-600 whitespace-nowrap">Set all to</label>
              <input id="bulk-rate" v-model="bulkRate" inputmode="decimal" placeholder="3" class="w-16 px-2 py-1.5 text-sm text-right border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"/>
              <span class="text-sm text-gray-600">%/mo</span>
              <button type="submit" :disabled="!bulkRate" class="px-3 py-1.5 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-40">Apply</button>
            </form>
          </div>
          <div class="overflow-x-auto">
            <table class="w-full text-sm">
              <thead>
                <tr class="bg-gray-50 border-b border-gray-200">
                  <th class="sticky-col bg-gray-50 px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider min-w-[9rem] md:min-w-[14rem]">Product line</th>
                  <th class="px-3 py-2 text-right text-xs font-medium text-gray-500 uppercase tracking-wider whitespace-nowrap" title="Planned MRR growth, % per month, in this scenario">Growth/mo</th>
                  <th v-for="m in months" :key="m"
                      :class="['px-3 py-2 text-right text-xs font-medium text-gray-500 whitespace-nowrap min-w-[5.5rem]', isActual(m) ? 'bg-gray-50' : 'bg-blue-50']">
                    {{ short(m) }}
                  </th>
                </tr>
              </thead>
              <tbody>
                <template v-for="g in groups" :key="g.key">
                  <tr v-if="g.family || groups.length > 1" class="bg-gray-50/70 border-t border-gray-200 font-semibold">
                    <td class="sticky-col bg-gray-50 px-4 py-2 text-gray-900">{{ g.family ? g.family.name : 'Other' }}</td>
                    <td></td>
                    <td v-for="m in months" :key="m" :class="['px-3 py-2 text-right tabular-nums whitespace-nowrap', isActual(m) ? '' : 'bg-blue-50/70']"
                        :title="isActual(m) ? null : 'Trend: ' + formatCents(trendSubtotal(g, m))">
                      {{ formatCents(subtotal(g, m)) }}
                    </td>
                  </tr>
                  <tr v-for="l in g.lines" :key="l.line.id" class="border-t border-gray-100">
                    <td :class="['sticky-col px-4 py-2 text-gray-700', g.family || groups.length > 1 ? 'pl-8' : '']">{{ l.line.name }}</td>
                    <td class="px-2 py-1 text-right">
                      <div class="inline-flex items-center gap-1">
                        <input :value="l.rate" @change="saveRate(l, $event.target.value)" @keydown.enter="$event.target.blur()"
                               inputmode="decimal" :aria-label="'Planned growth for ' + l.line.name"
                               class="w-14 text-right px-1.5 py-1 text-sm border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-indigo-500"/>
                        <span class="text-xs text-gray-400">%</span>
                      </div>
                      <div class="text-[11px] text-gray-400 whitespace-nowrap" title="Average net MRR growth over the last 3 months">trend {{ fmtRate(l.trendRate) }}</div>
                    </td>
                    <td v-for="m in months" :key="m"
                        :class="['px-3 py-2 text-right tabular-nums whitespace-nowrap', isActual(m) ? 'text-gray-900' : 'bg-blue-50/50 text-blue-900']"
                        :title="isActual(m) ? (l.values[m].customers ? l.values[m].customers + ' customers' : null) : 'Trend: ' + formatCents(l.trend[m] || 0)">
                      {{ l.values[m].mrr ? formatCents(l.values[m].mrr) : '' }}
                    </td>
                  </tr>
                </template>
                <tr class="border-t-2 border-gray-200 font-bold">
                  <td class="sticky-col px-4 py-2.5 text-gray-900">Total MRR</td>
                  <td></td>
                  <td v-for="m in months" :key="m" :class="['px-3 py-2.5 text-right tabular-nums whitespace-nowrap', isActual(m) ? '' : 'bg-blue-50/70']"
                      :title="isActual(m) ? null : 'Trend: ' + formatCents(series.trendTotals[m])">
                    {{ formatCents(series.totals[m]) }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </template>
    </div>
  `,
};
