import { clearCredentials } from '../db.js';
import { getSettings, updateSettings, resetAllData } from '../schema.js';

export default {
  name: 'SettingsView',
  setup() {
    const { ref, onMounted, inject } = Vue;
    const router = VueRouter.useRouter();
    const toast = inject('toast');

    const settings = ref(null);
    const loading = ref(true);
    const saving = ref(false);
    const showResetConfirm = ref(false);

    const months = [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December',
    ];

    const defaultDeptMapping = {
      Engineering: 'Research & Development',
      Product: 'Research & Development',
      Design: 'Research & Development',
      Sales: 'Sales & Marketing',
      Marketing: 'Sales & Marketing',
      Admin: 'General & Administrative',
      Finance: 'General & Administrative',
      HR: 'General & Administrative',
      Legal: 'General & Administrative',
      Operations: 'General & Administrative',
    };

    const categories = [
      'Cost of Goods Sold (COGS)',
      'Research & Development',
      'Sales & Marketing',
      'General & Administrative',
      'Uncategorized / Other',
    ];

    const deptEntries = ref([]);

    onMounted(async () => {
      try {
        settings.value = await getSettings();
        const mapping = settings.value?.dept_mapping || {};
        const entries = Object.keys(mapping).length > 0
          ? Object.entries(mapping)
          : Object.entries(defaultDeptMapping);
        deptEntries.value = entries.map(([dept, cat]) => ({ dept, cat }));
      } catch (e) {
        toast('Failed to load settings: ' + e.message, 'error');
      } finally {
        loading.value = false;
      }
    });

    const save = async () => {
      saving.value = true;
      try {
        const mapping = {};
        deptEntries.value.forEach(e => { if (e.dept) mapping[e.dept] = e.cat; });
        await updateSettings({
          company_name: settings.value.company_name,
          currency: settings.value.currency,
          fiscal_year_start: settings.value.fiscal_year_start,
          actuals_through: settings.value.actuals_through,
          dept_mapping: mapping,
        });
        toast('Settings saved', 'success');
      } catch (e) {
        toast('Failed to save: ' + e.message, 'error');
      } finally {
        saving.value = false;
      }
    };

    const addDeptEntry = () => {
      deptEntries.value.push({ dept: '', cat: 'General & Administrative' });
    };

    const removeDeptEntry = (idx) => {
      deptEntries.value.splice(idx, 1);
    };

    const exportData = async () => {
      try {
        const { query } = await import('../db.js');
        const tables = ['settings', 'scenarios', 'expense_categories', 'expense_items',
          'expense_values', 'revenue_products', 'revenue_values', 'employees',
          'employee_overrides', 'scenario_employees', 'cash_actuals', 'funding_events'];
        const dump = {};
        for (const t of tables) {
          try { dump[t] = await query(`SELECT * FROM ${t}`); } catch { dump[t] = []; }
        }
        const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `vintana-backup-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        URL.revokeObjectURL(url);
        toast('Export complete', 'success');
      } catch (e) {
        toast('Export failed: ' + e.message, 'error');
      }
    };

    const importData = () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json';
      input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        try {
          const text = await file.text();
          const dump = JSON.parse(text);
          const { batch, execute } = await import('../db.js');
          const { runMigrations } = await import('../schema.js');
          const tables = ['funding_events', 'cash_actuals', 'scenario_employees',
            'employee_overrides', 'employees', 'revenue_values', 'revenue_products',
            'expense_values', 'expense_items', 'expense_categories', 'scenarios', 'settings'];
          await batch(tables.map(t => `DELETE FROM ${t}`));
          for (const [table, rows] of Object.entries(dump)) {
            if (!rows || rows.length === 0) continue;
            for (const row of rows) {
              const cols = Object.keys(row);
              const placeholders = cols.map(() => '?').join(', ');
              await execute(
                `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`,
                cols.map(c => row[c])
              );
            }
          }
          toast('Import complete; reloading...', 'success');
          setTimeout(() => location.reload(), 1000);
        } catch (e) {
          toast('Import failed: ' + e.message, 'error');
        }
      };
      input.click();
    };

    const doReset = async () => {
      try {
        await resetAllData();
        showResetConfirm.value = false;
        toast('All data reset', 'success');
        setTimeout(() => location.reload(), 500);
      } catch (e) {
        toast('Reset failed: ' + e.message, 'error');
      }
    };

    const disconnect = () => {
      clearCredentials();
      router.push('/login');
    };

    return {
      settings, loading, saving, save, months, categories,
      deptEntries, addDeptEntry, removeDeptEntry,
      exportData, importData,
      showResetConfirm, doReset, disconnect,
    };
  },
  template: `
    <div class="max-w-3xl mx-auto">
      <h1 class="text-2xl font-bold text-gray-900 mb-6">Settings</h1>

      <div v-if="loading" class="text-gray-400 py-12 text-center">Loading...</div>

      <div v-else-if="settings" class="space-y-8">
        <section class="bg-white rounded-xl border border-gray-200 p-6">
          <h2 class="text-lg font-semibold text-gray-900 mb-4">Company</h2>
          <div class="grid grid-cols-2 gap-4">
            <div>
              <label class="block text-sm font-medium text-gray-700 mb-1">Company Name</label>
              <input v-model="settings.company_name" type="text" class="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"/>
            </div>
            <div>
              <label class="block text-sm font-medium text-gray-700 mb-1">Fiscal Year Start</label>
              <select v-model.number="settings.fiscal_year_start" class="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500">
                <option v-for="(m, i) in months" :value="i + 1">{{ m }}</option>
              </select>
            </div>
            <div>
              <label class="block text-sm font-medium text-gray-700 mb-1">Actuals Through</label>
              <input v-model="settings.actuals_through" type="month" class="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"/>
            </div>
          </div>
        </section>

        <section class="bg-white rounded-xl border border-gray-200 p-6">
          <div class="flex items-center justify-between mb-4">
            <h2 class="text-lg font-semibold text-gray-900">Department → P&L Mapping</h2>
            <button @click="addDeptEntry" class="text-sm text-indigo-600 hover:text-indigo-700">+ Add</button>
          </div>
          <div class="space-y-2">
            <div v-for="(entry, idx) in deptEntries" :key="idx" class="flex items-center gap-3">
              <input v-model="entry.dept" placeholder="Department name" class="flex-1 px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"/>
              <i data-lucide="arrow-right" class="w-4 h-4 text-gray-400 flex-shrink-0"></i>
              <select v-model="entry.cat" class="flex-1 px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500">
                <option v-for="c in categories" :value="c">{{ c }}</option>
              </select>
              <button @click="removeDeptEntry(idx)" class="text-gray-400 hover:text-red-500"><i data-lucide="x" class="w-4 h-4"></i></button>
            </div>
          </div>
        </section>

        <div class="flex justify-end">
          <button @click="save" :disabled="saving" class="px-6 py-2.5 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition-colors">
            {{ saving ? 'Saving...' : 'Save Settings' }}
          </button>
        </div>

        <section class="bg-white rounded-xl border border-gray-200 p-6">
          <h2 class="text-lg font-semibold text-gray-900 mb-4">Data Management</h2>
          <div class="flex gap-3">
            <button @click="exportData" class="px-4 py-2 text-sm border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors">
              <i data-lucide="download" class="w-4 h-4 inline mr-1"></i> Export JSON
            </button>
            <button @click="importData" class="px-4 py-2 text-sm border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors">
              <i data-lucide="upload" class="w-4 h-4 inline mr-1"></i> Import JSON
            </button>
          </div>
        </section>

        <section class="bg-red-50 rounded-xl border border-red-200 p-6">
          <h2 class="text-lg font-semibold text-red-900 mb-4">Danger Zone</h2>
          <div class="flex gap-3">
            <button @click="showResetConfirm = true" class="px-4 py-2 text-sm text-red-600 border border-red-300 rounded-lg hover:bg-red-100 transition-colors">
              Reset All Data
            </button>
            <button @click="disconnect" class="px-4 py-2 text-sm text-red-600 border border-red-300 rounded-lg hover:bg-red-100 transition-colors">
              Disconnect
            </button>
          </div>
        </section>

        <div v-if="showResetConfirm" class="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div class="bg-white rounded-xl p-6 max-w-sm mx-4">
            <h3 class="text-lg font-semibold text-gray-900 mb-2">Confirm Reset</h3>
            <p class="text-sm text-gray-600 mb-6">This will permanently delete all data and recreate the schema. This cannot be undone.</p>
            <div class="flex justify-end gap-3">
              <button @click="showResetConfirm = false" class="px-4 py-2 text-sm border border-gray-200 rounded-lg hover:bg-gray-50">Cancel</button>
              <button @click="doReset" class="px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700">Reset Everything</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  `,
};
