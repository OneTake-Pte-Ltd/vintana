import { query } from '../db.js';
import { formatCents, monthLabelFull, currentMonth } from '../utils.js';
import { loadExpenseValues, computeUpcomingCharges, horizonMonth } from '../charges.js';

const WINDOW_KEY = 'vintana_upcoming_days';
const WINDOWS = [30, 60, 90];

export default {
  name: 'UpcomingChargesView',
  setup() {
    const { ref, computed, onMounted, watch, inject } = Vue;
    const scenarioId = inject('scenarioId');
    const toast = inject('toast');

    const readWindow = () => {
      try { const v = Number(localStorage.getItem(WINDOW_KEY)); return WINDOWS.includes(v) ? v : 30; } catch { return 30; }
    };
    const days = ref(readWindow());
    const items = ref([]);
    const values = ref({});
    const loading = ref(true);

    const load = async () => {
      if (!scenarioId.value) return;
      loading.value = true;
      try {
        const [rows, vals] = await Promise.all([
          query(`
            SELECT ei.id, ei.name, ei.company, ei.charge_label, ei.recurrence, ei.renewal_day,
                   ei.start_month, ei.end_month, ec.name AS category_name
            FROM expense_items ei JOIN expense_categories ec ON ec.id = ei.category_id
            WHERE ei.visible = 1`),
          loadExpenseValues(scenarioId.value, currentMonth(), horizonMonth(Math.max(...WINDOWS))),
        ]);
        items.value = rows;
        values.value = vals;
      } catch (e) {
        toast('Failed to load upcoming charges: ' + e.message, 'error');
      } finally {
        loading.value = false;
      }
    };
    onMounted(load);
    watch(scenarioId, load);
    watch(days, d => { try { localStorage.setItem(WINDOW_KEY, String(d)); } catch { /* storage unavailable */ } });

    const charges = computed(() => computeUpcomingCharges(items.value, values.value, days.value));
    const total = computed(() => charges.value.reduce((s, c) => s + c.amount, 0));
    const largest = computed(() => charges.value.reduce((best, c) => (!best || c.amount > best.amount ? c : best), null));
    const nextCharge = computed(() => charges.value[0] || null);

    // One group per calendar month, with its subtotal
    const groups = computed(() => {
      const out = [];
      for (const c of charges.value) {
        let g = out[out.length - 1];
        if (!g || g.month !== c.month) { g = { month: c.month, charges: [], total: 0 }; out.push(g); }
        g.charges.push(c);
        g.total += c.amount;
      }
      return out;
    });

    const undated = computed(() => items.value.filter(i => i.recurrence !== 'one_time' && !i.renewal_day
      && (!i.end_month || i.end_month >= currentMonth())).length);

    const fmtDate = d => d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
    const daysAway = d => {
      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const n = Math.round((d - today) / 864e5);
      return n === 0 ? 'Today' : n === 1 ? 'Tomorrow' : `In ${n} days`;
    };
    const recurrenceLabel = r => ({ monthly: 'Monthly', quarterly: 'Quarterly', annual: 'Annual', one_time: 'One-time' }[r] || r);

    return {
      WINDOWS, days, loading, charges, total, largest, nextCharge, groups, undated,
      formatCents, monthLabelFull, fmtDate, daysAway, recurrenceLabel,
    };
  },
  template: `
    <div class="space-y-6">
      <div class="flex items-center justify-between flex-wrap gap-3">
        <h1 class="text-2xl font-bold text-gray-900">Upcoming Charges</h1>
        <div class="inline-flex rounded-lg border border-gray-200 bg-white p-0.5" role="group" aria-label="Time window">
          <button v-for="w in WINDOWS" :key="w" @click="days = w"
            :aria-pressed="days === w"
            :class="['px-3 py-1.5 text-sm rounded-md transition-colors', days === w ? 'bg-indigo-600 text-white' : 'text-gray-600 hover:bg-gray-50']">
            {{ w }} days
          </button>
        </div>
      </div>

      <div v-if="loading" class="text-gray-400 py-12 text-center">Loading...</div>

      <template v-else>
        <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div class="bg-white rounded-xl border border-gray-200 p-5">
            <span class="text-xs font-medium text-gray-500 uppercase tracking-wider">Total (next {{ days }} days)</span>
            <div class="text-2xl font-bold text-gray-900 mt-2">{{ formatCents(total) }}</div>
            <div class="text-xs text-gray-400 mt-1">{{ charges.length }} charge{{ charges.length !== 1 ? 's' : '' }}</div>
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
                <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Date</th>
                <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Expense</th>
                <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Category</th>
                <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Recurrence</th>
                <th class="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Amount</th>
              </tr>
            </thead>
            <tbody>
              <template v-for="g in groups" :key="g.month">
                <tr class="bg-gray-50/60 border-b border-gray-100">
                  <td colspan="4" class="px-4 py-2 text-xs font-semibold text-gray-700 uppercase tracking-wide">{{ monthLabelFull(g.month) }}</td>
                  <td class="px-4 py-2 text-right text-xs font-semibold text-gray-700 tabular-nums">{{ formatCents(g.total) }}</td>
                </tr>
                <tr v-for="c in g.charges" :key="c.id + ':' + c.month" class="border-b border-gray-100 hover:bg-gray-50">
                  <td class="px-4 py-3 whitespace-nowrap">
                    <div class="text-gray-900">{{ fmtDate(c.date) }}</div>
                    <div class="text-xs text-gray-400">{{ daysAway(c.date) }}</div>
                  </td>
                  <td class="px-4 py-3">
                    <div class="font-medium text-gray-900">{{ c.name }}</div>
                    <div v-if="c.company" class="text-xs text-gray-400">{{ c.company }}</div>
                    <div v-if="c.charge_label" class="text-xs text-gray-400 italic">{{ c.charge_label }}</div>
                  </td>
                  <td class="px-4 py-3 text-gray-600">{{ c.category_name }}</td>
                  <td class="px-4 py-3 text-gray-600">{{ recurrenceLabel(c.recurrence) }}</td>
                  <td class="px-4 py-3 text-right text-gray-900 tabular-nums">{{ formatCents(c.amount) }}</td>
                </tr>
              </template>
              <tr v-if="!charges.length">
                <td colspan="5" class="px-4 py-8 text-center text-gray-400">No charges in the next {{ days }} days</td>
              </tr>
            </tbody>
            <tfoot v-if="charges.length">
              <tr class="border-t border-gray-200">
                <td colspan="4" class="px-4 py-3 font-semibold text-gray-900">Total</td>
                <td class="px-4 py-3 text-right font-semibold text-gray-900 tabular-nums">{{ formatCents(total) }}</td>
              </tr>
            </tfoot>
          </table>
        </div>

        <p v-if="undated" class="text-xs text-gray-500">
          {{ undated }} recurring expense{{ undated !== 1 ? 's have' : ' has' }} no renewal day, so {{ undated !== 1 ? 'they are' : 'it is' }} not listed here.
          Set a renewal day on the Expenses page to include {{ undated !== 1 ? 'them' : 'it' }}.
        </p>
      </template>
    </div>
  `,
};
