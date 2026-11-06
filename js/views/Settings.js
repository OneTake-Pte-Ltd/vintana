import { clearCredentials, getCredentials, query, execute } from '../db.js';
import { CURRENCIES } from '../utils.js';
import { loadCategoryLookups, categoryOptions } from '../expenses.js';
import { ASSISTANT_MODELS, DEFAULT_MODEL, DEFAULT_RELAY_URL, sha256Hex } from '../assistant.js';
import { getSettings, updateSettings, resetAllData } from '../schema.js';
import { DEFAULT_DEPT_MAPPING } from '../payroll.js';
import {
  EXPENSE_COLUMNS, PAYROLL_COLUMNS,
  exportExpensesCsv, importExpensesCsv, exportPayrollCsv, importPayrollCsv,
} from '../csvTransfer.js';
import { downloadCsv } from '../csv.js';

export default {
  name: 'SettingsView',
  setup() {
    const { ref, computed, onMounted, inject } = Vue;
    const router = VueRouter.useRouter();
    const toast = inject('toast');
    const dateRange = inject('dateRange');
    const reloadAppSettings = inject('loadSettings');

    const settings = ref(null);
    const loading = ref(true);
    const saving = ref(false);
    const showResetConfirm = ref(false);

    const months = [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December',
    ];


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
        if (settings.value) {
          settings.value.assistant_relay_url ||= DEFAULT_RELAY_URL;
          settings.value.assistant_model ||= DEFAULT_MODEL;
          settings.value.company_context ||= '';
          settings.value.payroll_pay_day ??= null;
        }
        await Promise.all([loadSubcategories(), loadBankAccounts()]);
        const mapping = settings.value?.dept_mapping || {};
        const entries = Object.keys(mapping).length > 0
          ? Object.entries(mapping)
          : Object.entries(DEFAULT_DEPT_MAPPING);
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
          assistant_relay_url: (settings.value.assistant_relay_url || '').trim() || DEFAULT_RELAY_URL,
          assistant_model: settings.value.assistant_model || DEFAULT_MODEL,
          company_context: settings.value.company_context || null,
          payroll_pay_day: settings.value.payroll_pay_day || null,
        });
        await reloadAppSettings();
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
        const tables = ['settings', 'scenarios', 'expense_categories', 'expense_subcategories', 'expense_items',
          'expense_values', 'revenue_products', 'revenue_values', 'employees',
          'employee_overrides', 'scenario_employees', 'cash_actuals', 'funding_events',
          'bank_accounts', 'bank_balances', 'statement_imports', 'bank_transactions', 'fx_rates'];
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
          const tables = ['bank_transactions', 'statement_imports', 'bank_balances', 'bank_accounts', 'fx_rates',
            'funding_events', 'cash_actuals', 'scenario_employees',
            'employee_overrides', 'employees', 'revenue_values', 'revenue_products',
            'expense_values', 'expense_items', 'expense_subcategories', 'expense_categories', 'scenarios', 'settings'];
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

    const csvKinds = {
      expenses: { label: 'Expenses', columns: EXPENSE_COLUMNS, exporter: exportExpensesCsv,
        importer: text => importExpensesCsv(text, dateRange.value) },
      payroll: { label: 'Payroll', columns: PAYROLL_COLUMNS, exporter: exportPayrollCsv,
        importer: importPayrollCsv },
    };
    const csvBusy = ref('');
    const csvErrors = ref({ kind: '', list: [] });

    const exportCsv = async (kind) => {
      csvBusy.value = kind;
      try {
        downloadCsv(`vintana-${kind}-${new Date().toISOString().slice(0, 10)}.csv`, await csvKinds[kind].exporter());
      } catch (e) {
        toast('Export failed: ' + e.message, 'error');
      } finally {
        csvBusy.value = '';
      }
    };

    const importCsv = (kind) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.csv,text/csv';
      input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        csvBusy.value = kind;
        csvErrors.value = { kind: '', list: [] };
        try {
          const result = await csvKinds[kind].importer(await file.text());
          if (result.errors.length) {
            csvErrors.value = { kind, list: result.errors };
            toast(`Nothing imported: fix the ${result.errors.length} problem(s) listed below`, 'error');
          } else {
            toast(`${csvKinds[kind].label}: ${result.created} added, ${result.updated} updated`, 'success');
          }
        } catch (e) {
          toast('Import failed: ' + e.message, 'error');
        } finally {
          csvBusy.value = '';
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

    // --- Bank accounts: one per bank, at least one. Saved as soon as they change ---
    const bankAccounts = ref([]);
    const accountUsage = ref({});
    const newAccount = ref({ bank_name: '', label: '', currency: 'EUR' });
    const loadBankAccounts = async () => {
      try {
        bankAccounts.value = await query('SELECT * FROM bank_accounts ORDER BY sort_order, id');
        const used = await query(`SELECT account_id AS id, COUNT(*) AS n FROM (
          SELECT account_id FROM bank_balances UNION ALL SELECT account_id FROM statement_imports) GROUP BY account_id`);
        accountUsage.value = Object.fromEntries(used.map(u => [u.id, u.n]));
        newAccount.value.currency = settings.value?.currency || 'EUR';
      } catch { bankAccounts.value = []; }
    };
    const currencyOptions = CURRENCIES.map(c => ({ value: c, label: c }));
    const addAccount = async () => {
      const a = newAccount.value;
      if (!a.bank_name.trim()) return;
      try {
        const order = Math.max(0, ...bankAccounts.value.map(x => x.sort_order || 0)) + 1;
        await execute('INSERT INTO bank_accounts (bank_name, label, currency, sort_order) VALUES (?,?,?,?)', [a.bank_name.trim(), a.label.trim() || null, a.currency, order]);
        newAccount.value = { bank_name: '', label: '', currency: settings.value?.currency || 'EUR' };
        await loadBankAccounts();
        toast('Account added', 'success');
      } catch (e) { toast('Add failed: ' + e.message, 'error'); }
    };
    const updateAccount = async (acc, field, value) => {
      try {
        await execute(`UPDATE bank_accounts SET ${field} = ? WHERE id = ?`, [value || null, acc.id]);
        await loadBankAccounts();
        toast('Saved', 'success');
      } catch (e) { toast('Save failed: ' + e.message, 'error'); }
    };
    const deleteAccount = async (acc) => {
      if (bankAccounts.value.length <= 1) return;
      try {
        await execute('DELETE FROM bank_accounts WHERE id = ?', [acc.id]);
        await loadBankAccounts();
        toast('Account removed', 'success');
      } catch (e) { toast('Delete failed: ' + e.message, 'error'); }
    };

    // --- Expense sub-categories: saved as soon as they change ---
    const expCategories = ref([]);
    const subcategories = ref([]);
    const subUsage = ref({});
    const newSub = ref({ name: '', category_id: null });
    const loadSubcategories = async () => {
      try {
        const l = await loadCategoryLookups();
        expCategories.value = l.categories;
        subcategories.value = l.subcategories;
        newSub.value.category_id ??= l.categories[0]?.id ?? null;
        const usage = await query('SELECT subcategory_id AS id, COUNT(*) AS n FROM expense_items WHERE subcategory_id IS NOT NULL GROUP BY subcategory_id');
        subUsage.value = Object.fromEntries(usage.map(u => [u.id, u.n]));
      } catch { /* sub-categories not set up on this database yet */ }
    };
    const expCategoryOptions = computed(() => categoryOptions(expCategories.value));
    const subsOf = catId => subcategories.value.filter(sc => sc.category_id === catId);
    const addSubcategory = async () => {
      const name = newSub.value.name.trim();
      if (!name || !newSub.value.category_id) return;
      try {
        const max = Math.max(0, ...subsOf(newSub.value.category_id).map(sc => sc.sort_order || 0));
        await execute('INSERT INTO expense_subcategories (category_id, name, sort_order) VALUES (?, ?, ?)', [newSub.value.category_id, name, max + 1]);
        newSub.value.name = '';
        await loadSubcategories();
        toast('Sub-category added', 'success');
      } catch (e) {
        toast(/UNIQUE/.test(e.message) ? 'That sub-category already exists in this category' : 'Add failed: ' + e.message, 'error');
      }
    };
    const updateSubcategory = async (sc, field, value) => {
      try {
        if (field === 'category_id') {
          // Expenses using it move along, so they never point to a sub-category of another category
          await execute('UPDATE expense_subcategories SET category_id = ? WHERE id = ?', [Number(value), sc.id]);
          await execute('UPDATE expense_items SET category_id = ? WHERE subcategory_id = ?', [Number(value), sc.id]);
        } else {
          await execute('UPDATE expense_subcategories SET name = ? WHERE id = ?', [value, sc.id]);
        }
        await loadSubcategories();
        toast('Saved', 'success');
      } catch (e) {
        toast(/UNIQUE/.test(e.message) ? 'That sub-category already exists in this category' : 'Save failed: ' + e.message, 'error');
      }
    };
    const deleteSubcategory = async (sc) => {
      const n = subUsage.value[sc.id] || 0;
      if (!window.confirm(`Delete "${sc.name}"?` + (n ? ` ${n} expense${n > 1 ? 's' : ''} will keep their category and have no sub-category.` : ''))) return;
      try {
        await execute('UPDATE expense_items SET subcategory_id = NULL WHERE subcategory_id = ?', [sc.id]);
        await execute('DELETE FROM expense_subcategories WHERE id = ?', [sc.id]);
        await loadSubcategories();
        toast('Sub-category deleted', 'success');
      } catch (e) { toast('Delete failed: ' + e.message, 'error'); }
    };

    // Fingerprint of this browser's database token, for the relay secrets. Only computed when asked for.
    const tokenHash = ref('');
    const showTokenHash = async () => {
      try { tokenHash.value = await sha256Hex(getCredentials().token); }
      catch (e) { toast('Could not compute the fingerprint: ' + e.message, 'error'); }
    };
    const copyTokenHash = async () => {
      try { await navigator.clipboard.writeText(tokenHash.value); toast('Fingerprint copied', 'success'); }
      catch { toast('Copy failed; select the text and copy it by hand', 'error'); }
    };

    const disconnect = () => {
      clearCredentials();
      router.push('/login');
    };

    return {
      settings, loading, saving, save, months, categories,
      deptEntries, addDeptEntry, removeDeptEntry,
      exportData, importData,
      csvKinds, csvBusy, csvErrors, exportCsv, importCsv,
      showResetConfirm, doReset, disconnect,
      CURRENCIES, ASSISTANT_MODELS, tokenHash,
      bankAccounts, accountUsage, newAccount, currencyOptions, addAccount, updateAccount, deleteAccount, showTokenHash, copyTokenHash,
      expCategories, subcategories, subUsage, newSub, expCategoryOptions, subsOf,
      addSubcategory, updateSubcategory, deleteSubcategory,
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
              <label for="reporting-currency" class="block text-sm font-medium text-gray-700 mb-1">Reporting Currency</label>
              <select id="reporting-currency" v-model="settings.currency" class="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500">
                <option v-for="c in CURRENCIES" :key="c" :value="c">{{ c }}</option>
              </select>
              <p class="text-xs text-gray-400 mt-1">Bank accounts in other currencies are converted into it. Changing it relabels existing amounts; it does not convert them.</p>
            </div>
            <div>
              <label class="block text-sm font-medium text-gray-700 mb-1">Actuals Through</label>
              <input v-model="settings.actuals_through" type="month" class="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"/>
            </div>
            <div>
              <label for="pay-day" class="block text-sm font-medium text-gray-700 mb-1">Payroll Pay Day</label>
              <select id="pay-day" v-model="settings.payroll_pay_day" class="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500">
                <option :value="null">Last day of the month</option>
                <option v-for="d in 28" :key="d" :value="d">Day {{ d }} of the month</option>
              </select>
              <p class="text-xs text-gray-400 mt-1">Used to date salaries on the Upcoming Charges page.</p>
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

        <section v-if="bankAccounts.length" class="bg-white rounded-xl border border-gray-200 p-6">
          <h2 class="text-lg font-semibold text-gray-900 mb-1">Bank Accounts</h2>
          <p class="text-sm text-gray-500 mb-4">One account per bank. Total cash is the sum of their month-end balances, converted into the reporting currency. Changes here are saved immediately.</p>
          <div class="divide-y divide-gray-100 border border-gray-100 rounded-lg">
            <div v-for="a in bankAccounts" :key="a.id" class="flex items-center gap-3 px-3 py-2 text-sm flex-wrap">
              <div class="flex-1 min-w-[10rem]">
                <inline-edit :value="a.bank_name" @save="v => updateAccount(a, 'bank_name', v)"><span class="font-medium text-gray-900">{{ a.bank_name }}</span></inline-edit>
                <div class="text-xs text-gray-500"><inline-edit :value="a.label" placeholder="Add a label" @save="v => updateAccount(a, 'label', v)"/></div>
              </div>
              <inline-edit :value="a.currency" :options="currencyOptions" @save="v => updateAccount(a, 'currency', v)"
                :disabled="!!accountUsage[a.id]" disabled-title="This account already has balances or statements in this currency"/>
              <span class="text-xs text-gray-400 whitespace-nowrap">{{ accountUsage[a.id] ? accountUsage[a.id] + ' balance' + (accountUsage[a.id] > 1 ? 's' : '') + ' or statements' : 'No data yet' }}</span>
              <button v-if="bankAccounts.length > 1 && !accountUsage[a.id]" @click="deleteAccount(a)" class="text-gray-400 hover:text-red-500" :aria-label="'Remove ' + a.bank_name" title="Remove">
                <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg>
              </button>
            </div>
          </div>
          <form @submit.prevent="addAccount" class="flex items-center gap-3 mt-4 flex-wrap">
            <input v-model="newAccount.bank_name" placeholder="Bank (e.g. DBS)" aria-label="Bank name" class="flex-1 min-w-[8rem] px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"/>
            <input v-model="newAccount.label" placeholder="Label (optional)" aria-label="Account label" class="flex-1 min-w-[8rem] px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"/>
            <select v-model="newAccount.currency" aria-label="Account currency" class="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500">
              <option v-for="c in CURRENCIES" :key="c" :value="c">{{ c }}</option>
            </select>
            <button type="submit" :disabled="!newAccount.bank_name.trim()" class="px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-40">Add account</button>
          </form>
        </section>

        <section v-if="expCategories.length && (subcategories.length || newSub.category_id)" class="bg-white rounded-xl border border-gray-200 p-6">
          <h2 class="text-lg font-semibold text-gray-900 mb-1">Expense Sub-categories</h2>
          <p class="text-sm text-gray-500 mb-4">Group expenses inside each P&L category. Changes here are saved immediately. Click a name or a category to change it.</p>
          <div class="space-y-5">
            <div v-for="c in expCategories" :key="c.id">
              <div class="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">{{ c.name }}</div>
              <div class="divide-y divide-gray-100 border border-gray-100 rounded-lg">
                <div v-for="sc in subsOf(c.id)" :key="sc.id" class="flex items-center gap-3 px-3 py-1.5 text-sm">
                  <div class="flex-1 min-w-0"><inline-edit :value="sc.name" @save="v => updateSubcategory(sc, 'name', v)"/></div>
                  <span class="text-xs text-gray-400 whitespace-nowrap">{{ subUsage[sc.id] || 0 }} expense{{ (subUsage[sc.id] || 0) !== 1 ? 's' : '' }}</span>
                  <inline-edit :value="sc.category_id" :options="expCategoryOptions" display="Move" @save="v => updateSubcategory(sc, 'category_id', v)"/>
                  <button @click="deleteSubcategory(sc)" class="text-gray-400 hover:text-red-500" :aria-label="'Delete ' + sc.name" title="Delete"><svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg></button>
                </div>
                <div v-if="!subsOf(c.id).length" class="px-3 py-1.5 text-sm text-gray-400">None yet</div>
              </div>
            </div>
          </div>
          <form @submit.prevent="addSubcategory" class="flex items-center gap-3 mt-5">
            <input v-model="newSub.name" placeholder="New sub-category" aria-label="New sub-category name" class="flex-1 px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"/>
            <select v-model.number="newSub.category_id" aria-label="Category" class="flex-1 px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500">
              <option v-for="c in expCategories" :key="c.id" :value="c.id">{{ c.name }}</option>
            </select>
            <button type="submit" :disabled="!newSub.name.trim()" class="px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-40">Add</button>
          </form>
        </section>

        <section class="bg-white rounded-xl border border-gray-200 p-6">
          <h2 class="text-lg font-semibold text-gray-900 mb-1">Assistant</h2>
          <p class="text-sm text-gray-500 mb-4">The Ask button on every page sends what the page shows, the description below and this month's cash, burn and revenue to Claude through the relay.</p>
          <div class="space-y-4">
            <div>
              <label for="company-context" class="block text-sm font-medium text-gray-700 mb-1">About the company</label>
              <textarea id="company-context" v-model="settings.company_context" rows="6"
                placeholder="What the company sells, to whom, stage and funding, team, goals for this year, anything the assistant should keep in mind..."
                class="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"></textarea>
            </div>
            <div class="grid grid-cols-2 gap-4">
              <div>
                <label for="assistant-model" class="block text-sm font-medium text-gray-700 mb-1">Model</label>
                <select id="assistant-model" v-model="settings.assistant_model" class="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500">
                  <option v-for="m in ASSISTANT_MODELS" :key="m.id" :value="m.id">{{ m.label }}</option>
                </select>
              </div>
              <div>
                <label for="relay-url" class="block text-sm font-medium text-gray-700 mb-1">Relay address</label>
                <input id="relay-url" v-model="settings.assistant_relay_url" type="url" class="w-full px-3 py-2 text-sm font-mono border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"/>
              </div>
            </div>
            <div class="pt-2 border-t border-gray-100">
              <div class="text-sm font-medium text-gray-700 mb-1">Relay access</div>
              <p class="text-sm text-gray-500 mb-2">
                The relay accepts this browser if the fingerprint (SHA-256) of its database token is in the relay secrets:
                <code class="text-xs">DB_TOKEN_RW_SHA256</code> for the read-write token, <code class="text-xs">DB_TOKEN_RO_SHA256</code> for the read-only one.
              </p>
              <button v-if="!tokenHash" @click="showTokenHash" class="px-4 py-2 text-sm border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors">Show my token's fingerprint</button>
              <div v-else class="flex items-center gap-2">
                <code class="flex-1 min-w-0 break-all text-xs bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 select-all">{{ tokenHash }}</code>
                <button @click="copyTokenHash" class="px-3 py-2 text-sm border border-gray-200 rounded-lg hover:bg-gray-50">Copy</button>
                <button @click="tokenHash = ''" class="px-3 py-2 text-sm text-gray-500 hover:text-gray-800">Hide</button>
              </div>
            </div>
          </div>
        </section>

        <div class="flex justify-end">
          <button @click="save" :disabled="saving" class="px-6 py-2.5 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition-colors">
            {{ saving ? 'Saving...' : 'Save Settings' }}
          </button>
        </div>

        <section class="bg-white rounded-xl border border-gray-200 p-6">
          <h2 class="text-lg font-semibold text-gray-900 mb-1">Expenses and Payroll (CSV)</h2>
          <p class="text-sm text-gray-500 mb-4">
            Rows are matched by name: existing ones are updated, new ones are added. Months use the format 2025-01.
            Quarterly and annual amounts are spread evenly over their months. Export with no data to get a template.
          </p>
          <div class="space-y-4">
            <div v-for="(kind, id) in csvKinds" :key="id" class="flex items-start justify-between gap-4">
              <div class="min-w-0">
                <div class="text-sm font-medium text-gray-900">{{ kind.label }}</div>
                <div class="text-xs text-gray-500 font-mono break-words">{{ kind.columns.join(', ') }}</div>
              </div>
              <div class="flex gap-2 flex-shrink-0">
                <button @click="importCsv(id)" :disabled="!!csvBusy" class="px-4 py-2 text-sm border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-50">
                  <i data-lucide="upload" class="w-4 h-4 inline mr-1"></i> {{ csvBusy === id ? 'Working...' : 'Import CSV' }}
                </button>
                <button @click="exportCsv(id)" :disabled="!!csvBusy" class="px-4 py-2 text-sm border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-50">
                  <i data-lucide="download" class="w-4 h-4 inline mr-1"></i> Export CSV
                </button>
              </div>
            </div>
          </div>
          <div v-if="csvErrors.list.length" class="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
            <div class="font-medium mb-1">{{ csvKinds[csvErrors.kind].label }} file not imported:</div>
            <ul class="list-disc pl-5 space-y-0.5">
              <li v-for="err in csvErrors.list.slice(0, 20)" :key="err">{{ err }}</li>
            </ul>
            <div v-if="csvErrors.list.length > 20" class="mt-1">and {{ csvErrors.list.length - 20 }} more</div>
          </div>
        </section>

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
