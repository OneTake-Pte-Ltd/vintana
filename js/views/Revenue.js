import { query, execute } from '../db.js';
import { formatCents, monthLabel, generateMonthRange, currentMonth } from '../utils.js';

const COLORS = ['#6366f1','#f59e0b','#10b981','#ef4444','#8b5cf6','#ec4899','#14b8a6','#f97316'];

export default {
  name: 'RevenueView',
  setup() {
    const { ref, computed, onMounted, watch, inject, nextTick } = Vue;
    const scenarioId = inject('scenarioId');
    const dateRange = inject('dateRange');
    const settings = inject('settings');
    const toast = inject('toast');

    const products = ref([]);
    const valuesMap = ref({});
    const expandedId = ref(null);
    const showAddModal = ref(false);
    const newProduct = ref({ name: '', alias: '', notes: '' });
    const deleteTarget = ref(null);
    const baseScenarioId = ref(null);

    const months = computed(() => {
      const dr = dateRange.value;
      if (!dr || !dr.start || !dr.end) return [];
      return generateMonthRange(dr.start, dr.end);
    });

    const curMonth = computed(() => currentMonth());

    const isForecast = (month) => {
      const at = settings.value?.actuals_through;
      return at ? month > at : true;
    };

    async function loadBaseScenarioId() {
      const rows = await query('SELECT id FROM scenarios WHERE is_base = 1 LIMIT 1');
      baseScenarioId.value = rows.length ? rows[0].id : 1;
    }

    async function loadProducts() {
      products.value = await query('SELECT * FROM revenue_products ORDER BY name');
    }

    async function loadValues() {
      const sid = scenarioId.value;
      const bid = baseScenarioId.value;
      if (!sid || !bid) return;
      let rows;
      if (sid === bid) {
        rows = await query(
          'SELECT product_id, month, customers, arpu FROM revenue_values WHERE scenario_id = ?',
          [sid]
        );
      } else {
        rows = await query(`
          SELECT b.product_id, b.month,
            COALESCE(s.customers, b.customers) AS customers,
            COALESCE(s.arpu, b.arpu) AS arpu
          FROM revenue_values b
          LEFT JOIN revenue_values s
            ON s.product_id = b.product_id AND s.month = b.month AND s.scenario_id = ?
          WHERE b.scenario_id = ?
          UNION
          SELECT s2.product_id, s2.month, s2.customers, s2.arpu
          FROM revenue_values s2
          WHERE s2.scenario_id = ?
            AND NOT EXISTS (
              SELECT 1 FROM revenue_values b2
              WHERE b2.product_id = s2.product_id AND b2.month = s2.month AND b2.scenario_id = ?
            )
        `, [sid, bid, sid, bid]);
      }
      const map = {};
      for (const r of rows) {
        if (!map[r.product_id]) map[r.product_id] = {};
        map[r.product_id][r.month] = { customers: r.customers, arpu: r.arpu };
      }
      valuesMap.value = map;
    }

    async function reload() {
      await loadBaseScenarioId();
      await loadProducts();
      await loadValues();
    }

    onMounted(reload);
    watch([scenarioId, dateRange], reload);

    function getVal(productId, month) {
      return valuesMap.value[productId]?.[month] || { customers: 0, arpu: 0 };
    }

    function mrr(productId, month) {
      const v = getVal(productId, month);
      return v.customers * v.arpu;
    }

    const totalMrr = computed(() => {
      const m = curMonth.value;
      return products.value.reduce((sum, p) => sum + mrr(p.id, m), 0);
    });

    const totalArr = computed(() => totalMrr.value * 12);

    const totalCustomers = computed(() => {
      const m = curMonth.value;
      return products.value.reduce((sum, p) => sum + (getVal(p.id, m).customers || 0), 0);
    });

    const chartData = computed(() => {
      const ms = months.value;
      if (!ms.length || !products.value.length) return null;
      const datasets = products.value.map((p, i) => ({
        label: p.name,
        data: ms.map(m => mrr(p.id, m) / 100),
        borderColor: COLORS[i % COLORS.length],
        backgroundColor: COLORS[i % COLORS.length] + '18',
        tension: 0.3,
        pointRadius: 2,
        borderWidth: 2,
        fill: false,
      }));
      datasets.push({
        label: 'Total',
        data: ms.map(m => products.value.reduce((s, p) => s + mrr(p.id, m), 0) / 100),
        borderColor: '#1e293b',
        borderWidth: 2.5,
        borderDash: [6, 3],
        tension: 0.3,
        pointRadius: 2,
        fill: false,
      });
      return { labels: ms.map(monthLabel), datasets };
    });

    const chartOptions = {
      plugins: {
        legend: { position: 'bottom', labels: { usePointStyle: true, boxWidth: 8, padding: 16 } },
        tooltip: {
          callbacks: { label: ctx => `${ctx.dataset.label}: ${formatCents(Math.round(ctx.parsed.y * 100))}` },
        },
      },
      scales: {
        y: {
          ticks: { callback: v => formatCents(v * 100) },
          grid: { color: '#f1f5f9' },
        },
        x: { grid: { display: false } },
      },
    };

    function toggleExpand(id) {
      expandedId.value = expandedId.value === id ? null : id;
    }

    async function saveCell(productId, month, field, raw) {
      const sid = scenarioId.value;
      const val = field === 'arpu' ? Math.round(parseFloat(raw || 0) * 100) : parseInt(raw || 0, 10);
      const cur = getVal(productId, month);
      const customers = field === 'customers' ? val : cur.customers;
      const arpu = field === 'arpu' ? val : cur.arpu;
      const isActual = isForecast(month) ? 0 : 1;
      await execute(
        `INSERT OR REPLACE INTO revenue_values (product_id, scenario_id, month, customers, arpu, is_actual)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [productId, sid, month, customers, arpu, isActual]
      );
      if (!valuesMap.value[productId]) valuesMap.value[productId] = {};
      valuesMap.value[productId][month] = { customers, arpu };
    }

    function suggestAlias(name) {
      return (name || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    }

    watch(() => newProduct.value.name, (n) => {
      if (!newProduct.value._aliasEdited) newProduct.value.alias = suggestAlias(n);
    });

    function markAliasEdited() {
      newProduct.value._aliasEdited = true;
    }

    async function addProduct() {
      const { name, alias, notes } = newProduct.value;
      if (!name.trim()) { toast('Name is required', 'error'); return; }
      try {
        await execute(
          'INSERT INTO revenue_products (name, alias, notes) VALUES (?, ?, ?)',
          [name.trim(), alias.trim() || null, notes.trim() || null]
        );
        showAddModal.value = false;
        newProduct.value = { name: '', alias: '', notes: '' };
        toast('Product line added', 'success');
        await reload();
      } catch (e) {
        toast('Failed to add: ' + e.message, 'error');
      }
    }

    async function confirmDelete() {
      if (!deleteTarget.value) return;
      try {
        await execute('DELETE FROM revenue_products WHERE id = ?', [deleteTarget.value.id]);
        deleteTarget.value = null;
        toast('Product deleted', 'success');
        await reload();
      } catch (e) {
        toast('Failed to delete: ' + e.message, 'error');
      }
    }

    return {
      products, months, expandedId, showAddModal, newProduct, deleteTarget,
      totalMrr, totalArr, totalCustomers, chartData, chartOptions,
      curMonth, isForecast, getVal, mrr, formatCents,
      toggleExpand, saveCell, addProduct, confirmDelete, markAliasEdited,
    };
  },
  template: `
    <div class="space-y-6">
      <h1 class="text-2xl font-bold text-gray-900">Revenue</h1>

      <!-- Chart -->
      <div class="bg-white rounded-xl border border-gray-200 p-5" v-if="chartData">
        <chart-wrapper type="line" :data="chartData" :options="chartOptions" height="280px" />
      </div>

      <!-- KPIs -->
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <kpi-card title="Monthly Recurring Revenue" :value="totalMrr" format="currency" />
        <kpi-card title="Annual Recurring Revenue" :value="totalArr" format="currency" />
        <kpi-card title="Total Customers" :value="totalCustomers" format="number" />
      </div>

      <!-- Product lines -->
      <div class="space-y-3">
        <div v-for="product in products" :key="product.id"
             class="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <!-- Collapsed header -->
          <div class="flex items-center justify-between px-5 py-4 cursor-pointer hover:bg-gray-50 transition-colors"
               @click="toggleExpand(product.id)">
            <div class="flex items-center gap-3 min-w-0">
              <svg :class="['w-4 h-4 text-gray-400 transition-transform', expandedId === product.id ? 'rotate-90' : '']"
                   fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/>
              </svg>
              <span class="font-medium text-gray-900 truncate">{{ product.name }}</span>
            </div>
            <div class="flex items-center gap-6 text-sm text-gray-600 flex-shrink-0">
              <span>{{ getVal(product.id, curMonth).customers }} customers</span>
              <span>ARPU {{ formatCents(getVal(product.id, curMonth).arpu) }}</span>
              <span class="font-semibold text-gray-900">{{ formatCents(mrr(product.id, curMonth)) }}/mo</span>
              <button @click.stop="deleteTarget = product"
                      class="text-gray-400 hover:text-red-500 ml-2" title="Delete">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                        d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
                </svg>
              </button>
            </div>
          </div>

          <!-- Expanded spreadsheet -->
          <div v-if="expandedId === product.id" class="border-t border-gray-200">
            <div class="overflow-x-auto">
              <table class="w-full text-sm">
                <thead>
                  <tr class="bg-gray-50">
                    <th class="sticky left-0 z-10 bg-gray-50 px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-32 min-w-[8rem]">Metric</th>
                    <th v-for="m in months" :key="m"
                        :class="['px-3 py-2 text-right text-xs font-medium text-gray-500 whitespace-nowrap min-w-[6rem]', isForecast(m) ? 'bg-blue-50' : 'bg-gray-50']">
                      {{ m.split('-')[1] + '/' + m.split('-')[0].slice(2) }}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <!-- Customers row -->
                  <tr class="border-t border-gray-100">
                    <td class="sticky left-0 z-10 bg-white px-4 py-2 font-medium text-gray-700">Customers</td>
                    <td v-for="m in months" :key="'c-'+m"
                        :class="['px-1 py-1', isForecast(m) ? 'bg-blue-50/50' : '']">
                      <input type="number" min="0" step="1"
                             :value="getVal(product.id, m).customers || ''"
                             @blur="saveCell(product.id, m, 'customers', $event.target.value)"
                             class="w-full text-right px-2 py-1 text-sm border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-indigo-500 bg-transparent" />
                    </td>
                  </tr>
                  <!-- ARPU row -->
                  <tr class="border-t border-gray-100">
                    <td class="sticky left-0 z-10 bg-white px-4 py-2 font-medium text-gray-700">ARPU (EUR)</td>
                    <td v-for="m in months" :key="'a-'+m"
                        :class="['px-1 py-1', isForecast(m) ? 'bg-blue-50/50' : '']">
                      <input type="number" min="0" step="0.01"
                             :value="(getVal(product.id, m).arpu / 100).toFixed(2)"
                             @blur="saveCell(product.id, m, 'arpu', $event.target.value)"
                             class="w-full text-right px-2 py-1 text-sm border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-indigo-500 bg-transparent" />
                    </td>
                  </tr>
                  <!-- MRR row (computed) -->
                  <tr class="border-t border-gray-200 bg-gray-50/50">
                    <td class="sticky left-0 z-10 bg-gray-50 px-4 py-2 font-semibold text-gray-900">MRR</td>
                    <td v-for="m in months" :key="'m-'+m"
                        :class="['px-3 py-2 text-right font-medium text-gray-900 whitespace-nowrap', isForecast(m) ? 'bg-blue-50/70' : 'bg-gray-50/50']">
                      {{ formatCents(mrr(product.id, m)) }}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      <!-- Add product button -->
      <button @click="showAddModal = true"
              class="px-4 py-2.5 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 transition-colors">
        + Add Product Line
      </button>

      <!-- Add product modal -->
      <div v-if="showAddModal" class="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
        <div class="bg-white rounded-xl p-6 w-full max-w-md mx-4">
          <h3 class="text-lg font-semibold text-gray-900 mb-4">New Product Line</h3>
          <div class="space-y-3">
            <div>
              <label class="block text-sm font-medium text-gray-700 mb-1">Name</label>
              <input v-model="newProduct.name" type="text" placeholder="e.g. Pro Plan"
                     class="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500" />
            </div>
            <div>
              <label class="block text-sm font-medium text-gray-700 mb-1">Alias</label>
              <input v-model="newProduct.alias" @input="markAliasEdited" type="text" placeholder="pro_plan"
                     class="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500" />
            </div>
            <div>
              <label class="block text-sm font-medium text-gray-700 mb-1">Notes</label>
              <textarea v-model="newProduct.notes" rows="2" placeholder="Optional notes"
                        class="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"></textarea>
            </div>
          </div>
          <div class="flex justify-end gap-3 mt-6">
            <button @click="showAddModal = false; newProduct = { name: '', alias: '', notes: '' }"
                    class="px-4 py-2 text-sm border border-gray-200 rounded-lg hover:bg-gray-50">Cancel</button>
            <button @click="addProduct"
                    class="px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700">Create</button>
          </div>
        </div>
      </div>

      <!-- Delete confirmation modal -->
      <div v-if="deleteTarget" class="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
        <div class="bg-white rounded-xl p-6 max-w-sm mx-4">
          <h3 class="text-lg font-semibold text-gray-900 mb-2">Delete Product</h3>
          <p class="text-sm text-gray-600 mb-6">
            Permanently delete <strong>{{ deleteTarget.name }}</strong> and all its revenue data? This cannot be undone.
          </p>
          <div class="flex justify-end gap-3">
            <button @click="deleteTarget = null" class="px-4 py-2 text-sm border border-gray-200 rounded-lg hover:bg-gray-50">Cancel</button>
            <button @click="confirmDelete" class="px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700">Delete</button>
          </div>
        </div>
      </div>

      <!-- Empty state -->
      <div v-if="!products.length" class="text-center py-12 text-gray-400">
        No product lines yet. Add one to start planning revenue.
      </div>
    </div>
  `,
};
