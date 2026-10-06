import { query, execute } from '../db.js';
import { formatCents, monthLabel, generateMonthRange } from '../utils.js';

const PNL_ROWS = [
  { key: 'revenue', label: 'Revenue' },
  { key: 'cogs', label: 'COGS' },
  { key: 'gross_profit', label: 'Gross Profit', computed: true },
  { key: 'rnd', label: 'R&D' },
  { key: 'snm', label: 'S&M' },
  { key: 'gna', label: 'G&A' },
  { key: 'other', label: 'Other' },
  { key: 'total_opex', label: 'Total OpEx', computed: true },
  { key: 'net_income', label: 'Net Income', computed: true },
];

const CAT_MAP = {
  'Cost of Goods Sold (COGS)': 'cogs',
  'Research & Development': 'rnd',
  'Sales & Marketing': 'snm',
  'General & Administrative': 'gna',
  'Uncategorized / Other': 'other',
};

export default {
  name: 'ScenariosView',
  setup() {
    const { ref, reactive, computed, onMounted, inject } = Vue;
    const scenarioId = inject('scenarioId');
    const dateRange = inject('dateRange');
    const settings = inject('settings');
    const toast = inject('toast');
    const scenarios = inject('scenarios');
    const loadScenarios = inject('loadScenarios');

    const loading = ref(true);
    const showCreate = ref(false);
    const showEdit = ref(false);
    const showDelete = ref(false);
    const showCompare = ref(false);
    const saving = ref(false);
    const createForm = reactive({ name: '', description: '', mode: 'scratch', sourceId: null });
    const editForm = reactive({ id: null, name: '', description: '' });
    const deleteTarget = ref(null);
    const compareA = ref(null);
    const compareB = ref(null);
    const compareData = ref(null);
    const compareLoading = ref(false);
    const sourceOptions = computed(() => scenarios.value.filter(s => s.id !== null));

    async function loadData() {
      loading.value = true;
      try { await loadScenarios(); } catch (e) { toast('Failed to load scenarios: ' + e.message, 'error'); }
      finally { loading.value = false; }
    }
    onMounted(() => loadData());

    function openCreate() {
      createForm.name = '';
      createForm.description = '';
      createForm.mode = 'scratch';
      createForm.sourceId = scenarios.value.find(s => s.is_base)?.id || null;
      showCreate.value = true;
    }

    async function doCreate() {
      if (!createForm.name.trim()) { toast('Name is required', 'error'); return; }
      saving.value = true;
      try {
        await execute(
          `INSERT INTO scenarios (name, description, is_base) VALUES (?, ?, 0)`,
          [createForm.name.trim(), createForm.description.trim() || null]
        );
        const rows = await query(`SELECT id FROM scenarios WHERE name = ?`, [createForm.name.trim()]);
        const newId = rows[0].id;
        if (createForm.mode === 'duplicate' && createForm.sourceId) {
          const src = createForm.sourceId;
          await execute(
            `INSERT INTO expense_values (expense_item_id, scenario_id, month, amount, is_actual)
             SELECT expense_item_id, ?, month, amount, is_actual FROM expense_values WHERE scenario_id = ?`, [newId, src]);
          await execute(
            `INSERT INTO revenue_values (product_id, scenario_id, month, customers, arpu, is_actual)
             SELECT product_id, ?, month, customers, arpu, is_actual FROM revenue_values WHERE scenario_id = ?`, [newId, src]);
          await execute(
            `INSERT INTO employee_overrides (employee_id, scenario_id, salary_monthly, tax_pct, start_date, end_date)
             SELECT employee_id, ?, salary_monthly, tax_pct, start_date, end_date FROM employee_overrides WHERE scenario_id = ?`, [newId, src]);
          await execute(
            `INSERT INTO scenario_employees (scenario_id, name, role, department, salary_monthly, tax_pct, start_date, end_date, notes)
             SELECT ?, name, role, department, salary_monthly, tax_pct, start_date, end_date, notes FROM scenario_employees WHERE scenario_id = ?`, [newId, src]);
          await execute(
            `INSERT INTO funding_events (name, month, amount, scenario_id, notes)
             SELECT name, month, amount, ?, notes FROM funding_events WHERE scenario_id = ?`, [newId, src]);
        }
        showCreate.value = false;
        await loadScenarios();
        toast('Scenario created', 'success');
      } catch (e) { toast('Failed to create scenario: ' + e.message, 'error'); }
      finally { saving.value = false; }
    }

    function openEdit(s) {
      if (s.is_base) { toast('Cannot rename the Base scenario', 'error'); return; }
      editForm.id = s.id; editForm.name = s.name; editForm.description = s.description || '';
      showEdit.value = true;
    }

    async function doEdit() {
      if (!editForm.name.trim()) { toast('Name is required', 'error'); return; }
      saving.value = true;
      try {
        await execute(`UPDATE scenarios SET name = ?, description = ? WHERE id = ? AND is_base = 0`,
          [editForm.name.trim(), editForm.description.trim() || null, editForm.id]);
        showEdit.value = false;
        await loadScenarios();
        toast('Scenario updated', 'success');
      } catch (e) { toast('Failed to update: ' + e.message, 'error'); }
      finally { saving.value = false; }
    }

    function openDelete(s) { if (s.is_base) return; deleteTarget.value = s; showDelete.value = true; }

    async function doDelete() {
      const s = deleteTarget.value; if (!s) return;
      saving.value = true;
      try {
        for (const t of ['expense_values','revenue_values','employee_overrides','scenario_employees','funding_events'])
          await execute(`DELETE FROM ${t} WHERE scenario_id = ?`, [s.id]);
        await execute(`DELETE FROM scenarios WHERE id = ? AND is_base = 0`, [s.id]);
        showDelete.value = false; deleteTarget.value = null;
        await loadScenarios();
        toast('Scenario deleted', 'success');
      } catch (e) { toast('Failed to delete: ' + e.message, 'error'); }
      finally { saving.value = false; }
    }

    function openCompare() {
      compareA.value = scenarios.value[0]?.id || null;
      compareB.value = scenarios.value.length > 1 ? scenarios.value[1].id : compareA.value;
      compareData.value = null; showCompare.value = true;
    }

    async function loadPnl(sid) {
      const range = dateRange.value;
      if (!range) return { revenue: 0, cogs: 0, rnd: 0, snm: 0, gna: 0, other: 0 };
      const [revRows, expRows] = await Promise.all([
        query(`SELECT COALESCE(SUM(customers * arpu), 0) AS total FROM revenue_values
               WHERE scenario_id = ? AND month >= ? AND month <= ?`, [sid, range.start, range.end]),
        query(`SELECT ec.name AS category, COALESCE(SUM(ev.amount), 0) AS total
               FROM expense_values ev JOIN expense_items ei ON ev.expense_item_id = ei.id
               JOIN expense_categories ec ON ei.category_id = ec.id
               WHERE ev.scenario_id = ? AND ev.month >= ? AND ev.month <= ? GROUP BY ec.name`,
              [sid, range.start, range.end]),
      ]);
      const d = { revenue: revRows[0]?.total || 0, cogs: 0, rnd: 0, snm: 0, gna: 0, other: 0 };
      for (const row of expRows) d[CAT_MAP[row.category] || 'other'] += row.total;
      d.gross_profit = d.revenue - d.cogs;
      d.total_opex = d.rnd + d.snm + d.gna + d.other;
      d.net_income = d.gross_profit - d.total_opex;
      return d;
    }

    async function runCompare() {
      if (!compareA.value || !compareB.value) { toast('Select two scenarios', 'error'); return; }
      compareLoading.value = true;
      try {
        const [a, b] = await Promise.all([loadPnl(compareA.value), loadPnl(compareB.value)]);
        compareData.value = { a, b };
      } catch (e) { toast('Compare failed: ' + e.message, 'error'); }
      finally { compareLoading.value = false; }
    }

    function delta(key) { return compareData.value ? compareData.value.b[key] - compareData.value.a[key] : 0; }
    function deltaPct(key) {
      if (!compareData.value) return null;
      const base = compareData.value.a[key];
      return base ? ((compareData.value.b[key] - base) / Math.abs(base)) * 100 : null;
    }
    function scenarioName(id) { return scenarios.value.find(s => s.id === id)?.name || ''; }
    function fmtDate(d) {
      if (!d) return '';
      return new Date(d + 'Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    }

    return {
      loading, scenarios, showCreate, showEdit, showDelete, showCompare, saving,
      createForm, editForm, deleteTarget, compareA, compareB, compareData, compareLoading,
      sourceOptions, openCreate, doCreate, openEdit, doEdit, openDelete, doDelete,
      openCompare, runCompare, PNL_ROWS, delta, deltaPct, scenarioName, formatCents, fmtDate,
    };
  },

  template: `
<div class="max-w-7xl mx-auto">
  <div class="flex items-center justify-between mb-6">
    <h1 class="text-2xl font-bold text-gray-900">Scenarios</h1>
    <button @click="openCreate" class="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 transition-colors">+ Create Scenario</button>
  </div>
  <div v-if="loading" class="text-gray-400 py-12 text-center">Loading...</div>
  <div v-else>
    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-8">
      <div v-for="s in scenarios" :key="s.id" class="bg-white rounded-xl border border-gray-200 p-5 flex flex-col">
        <div class="flex items-start justify-between mb-2">
          <div class="font-semibold text-gray-900">{{ s.name }}</div>
          <span v-if="s.is_base" class="ml-2 px-2 py-0.5 text-xs font-medium bg-indigo-100 text-indigo-700 rounded-full flex-shrink-0">Base</span>
        </div>
        <p class="text-sm text-gray-500 mb-3 flex-1">{{ s.description || 'No description' }}</p>
        <div class="text-xs text-gray-400 mb-3">Created {{ fmtDate(s.created_at) }}</div>
        <div class="flex gap-2 flex-wrap">
          <button @click="openEdit(s)" :disabled="s.is_base" class="px-3 py-1.5 text-xs border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed">Edit</button>
          <button @click="openCreate(); createForm.mode = 'duplicate'; createForm.sourceId = s.id" class="px-3 py-1.5 text-xs border border-gray-200 rounded-lg hover:bg-gray-50">Duplicate</button>
          <button @click="openDelete(s)" :disabled="s.is_base" class="px-3 py-1.5 text-xs text-red-600 border border-red-200 rounded-lg hover:bg-red-50 disabled:opacity-40 disabled:cursor-not-allowed">Delete</button>
          <button @click="openCompare" class="px-3 py-1.5 text-xs text-indigo-600 border border-indigo-200 rounded-lg hover:bg-indigo-50">Compare</button>
        </div>
      </div>
    </div>
    <p v-if="scenarios.length === 0" class="text-sm text-gray-400 text-center py-8">No scenarios found. Create one to get started.</p>
  </div>

  <!-- Create Modal -->
  <div v-if="showCreate" class="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
    <div class="bg-white rounded-xl p-6 max-w-md w-full mx-4">
      <h3 class="text-lg font-semibold text-gray-900 mb-4">Create Scenario</h3>
      <div class="space-y-4">
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">Name *</label>
          <input v-model="createForm.name" type="text" placeholder="e.g. Aggressive Growth" class="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"/>
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">Description</label>
          <textarea v-model="createForm.description" rows="2" class="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"></textarea>
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-2">Starting point</label>
          <div class="space-y-2">
            <label class="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
              <input type="radio" v-model="createForm.mode" value="scratch" class="text-indigo-600"/> Start from scratch
            </label>
            <label class="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
              <input type="radio" v-model="createForm.mode" value="duplicate" class="text-indigo-600"/> Duplicate existing
            </label>
          </div>
          <select v-if="createForm.mode === 'duplicate'" v-model="createForm.sourceId" class="mt-2 w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500">
            <option v-for="s in sourceOptions" :key="s.id" :value="s.id">{{ s.name }}</option>
          </select>
        </div>
      </div>
      <div class="flex justify-end gap-3 mt-6">
        <button @click="showCreate = false" class="px-4 py-2 text-sm border border-gray-200 rounded-lg hover:bg-gray-50">Cancel</button>
        <button @click="doCreate" :disabled="saving" class="px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50">{{ saving ? 'Creating...' : 'Create' }}</button>
      </div>
    </div>
  </div>

  <!-- Edit Modal -->
  <div v-if="showEdit" class="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
    <div class="bg-white rounded-xl p-6 max-w-md w-full mx-4">
      <h3 class="text-lg font-semibold text-gray-900 mb-4">Edit Scenario</h3>
      <div class="space-y-4">
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">Name *</label>
          <input v-model="editForm.name" type="text" class="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"/>
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">Description</label>
          <textarea v-model="editForm.description" rows="2" class="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"></textarea>
        </div>
      </div>
      <div class="flex justify-end gap-3 mt-6">
        <button @click="showEdit = false" class="px-4 py-2 text-sm border border-gray-200 rounded-lg hover:bg-gray-50">Cancel</button>
        <button @click="doEdit" :disabled="saving" class="px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50">{{ saving ? 'Saving...' : 'Save' }}</button>
      </div>
    </div>
  </div>

  <!-- Delete Confirmation -->
  <div v-if="showDelete" class="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
    <div class="bg-white rounded-xl p-6 max-w-sm mx-4">
      <h3 class="text-lg font-semibold text-gray-900 mb-2">Delete Scenario</h3>
      <p class="text-sm text-gray-600 mb-6">Permanently delete <span class="font-medium">{{ deleteTarget?.name }}</span> and all its data? This cannot be undone.</p>
      <div class="flex justify-end gap-3">
        <button @click="showDelete = false" class="px-4 py-2 text-sm border border-gray-200 rounded-lg hover:bg-gray-50">Cancel</button>
        <button @click="doDelete" :disabled="saving" class="px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50">{{ saving ? 'Deleting...' : 'Delete' }}</button>
      </div>
    </div>
  </div>

  <!-- Compare Modal -->
  <div v-if="showCompare" class="fixed inset-0 bg-black/50 flex items-center justify-center z-50 overflow-y-auto py-8">
    <div class="bg-white rounded-xl p-6 max-w-3xl w-full mx-4">
      <h3 class="text-lg font-semibold text-gray-900 mb-4">Compare Scenarios</h3>
      <div class="flex items-end gap-4 mb-6">
        <div class="flex-1">
          <label class="block text-sm font-medium text-gray-700 mb-1">Scenario A</label>
          <select v-model="compareA" class="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500">
            <option v-for="s in scenarios" :key="s.id" :value="s.id">{{ s.name }}</option>
          </select>
        </div>
        <div class="text-gray-400 text-sm pb-2">vs</div>
        <div class="flex-1">
          <label class="block text-sm font-medium text-gray-700 mb-1">Scenario B</label>
          <select v-model="compareB" class="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500">
            <option v-for="s in scenarios" :key="s.id" :value="s.id">{{ s.name }}</option>
          </select>
        </div>
        <button @click="runCompare" :disabled="compareLoading" class="px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 flex-shrink-0">{{ compareLoading ? 'Loading...' : 'Compare' }}</button>
      </div>
      <div v-if="compareData" class="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <div class="bg-gray-50 rounded-lg p-3 text-center">
          <div class="text-xs text-gray-500 mb-1">Revenue Diff</div>
          <div class="text-sm font-semibold" :class="delta('revenue') >= 0 ? 'text-emerald-600' : 'text-red-600'">{{ formatCents(delta('revenue')) }}</div>
        </div>
        <div class="bg-gray-50 rounded-lg p-3 text-center">
          <div class="text-xs text-gray-500 mb-1">Expense Diff</div>
          <div class="text-sm font-semibold" :class="delta('total_opex') <= 0 ? 'text-emerald-600' : 'text-red-600'">{{ formatCents(delta('total_opex')) }}</div>
        </div>
        <div class="bg-gray-50 rounded-lg p-3 text-center">
          <div class="text-xs text-gray-500 mb-1">Net Income Diff</div>
          <div class="text-sm font-semibold" :class="delta('net_income') >= 0 ? 'text-emerald-600' : 'text-red-600'">{{ formatCents(delta('net_income')) }}</div>
        </div>
        <div class="bg-gray-50 rounded-lg p-3 text-center">
          <div class="text-xs text-gray-500 mb-1">COGS Diff</div>
          <div class="text-sm font-semibold" :class="delta('cogs') <= 0 ? 'text-emerald-600' : 'text-red-600'">{{ formatCents(delta('cogs')) }}</div>
        </div>
      </div>
      <div v-if="compareData" class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="text-left text-xs text-gray-500 uppercase tracking-wider border-b border-gray-200">
              <th class="pb-2 font-medium">Line Item</th>
              <th class="pb-2 font-medium text-right">{{ scenarioName(compareA) }}</th>
              <th class="pb-2 font-medium text-right">{{ scenarioName(compareB) }}</th>
              <th class="pb-2 font-medium text-right">Delta</th>
              <th class="pb-2 font-medium text-right">Delta %</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in PNL_ROWS" :key="row.key" class="border-b border-gray-100" :class="row.computed ? 'font-semibold bg-gray-50' : ''">
              <td class="py-2.5 text-gray-900">{{ row.label }}</td>
              <td class="py-2.5 text-right text-gray-900">{{ formatCents(compareData.a[row.key]) }}</td>
              <td class="py-2.5 text-right text-gray-900">{{ formatCents(compareData.b[row.key]) }}</td>
              <td class="py-2.5 text-right" :class="delta(row.key) > 0 ? 'text-emerald-600' : delta(row.key) < 0 ? 'text-red-600' : 'text-gray-400'">{{ formatCents(delta(row.key)) }}</td>
              <td class="py-2.5 text-right" :class="delta(row.key) > 0 ? 'text-emerald-600' : delta(row.key) < 0 ? 'text-red-600' : 'text-gray-400'">{{ deltaPct(row.key) !== null ? deltaPct(row.key).toFixed(1) + '%' : '—' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="flex justify-end mt-6">
        <button @click="showCompare = false" class="px-4 py-2 text-sm border border-gray-200 rounded-lg hover:bg-gray-50">Close</button>
      </div>
    </div>
  </div>
</div>
  `,
};
