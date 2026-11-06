import { clearCredentials, getCredentials, query, execute, batch } from '../db.js';
import { CURRENCIES, monthLabelFull } from '../utils.js';
import { loadCategoryLookups, categoryOptions } from '../expenses.js';
import { ASSISTANT_MODELS, DEFAULT_MODEL, DEFAULT_RELAY_URL, sha256Hex } from '../assistant.js';
import { getSettings, updateSettings, resetAllData } from '../schema.js';
import { DEFAULT_DEPT_MAPPING } from '../payroll.js';
import {
  EXPENSE_COLUMNS, PAYROLL_COLUMNS,
  exportExpensesCsv, importExpensesCsv, exportPayrollCsv, importPayrollCsv,
} from '../csvTransfer.js';
import { downloadCsv } from '../csv.js';

// One collapsible block of the Settings page. The header shows a summary while it is closed.
const SettingsSection = {
  name: 'SettingsSection',
  props: {
    id: { type: String, required: true },
    title: { type: String, required: true },
    summary: { type: String, default: '' },
    open: { type: Boolean, default: false },
    dirty: { type: Boolean, default: false },
    saved: { type: Boolean, default: false },
    danger: { type: Boolean, default: false },
  },
  emits: ['toggle'],
  template: `
    <section :id="'settings-' + id" :class="['rounded-xl border scroll-mt-20', danger ? 'bg-red-50 border-red-200' : 'bg-white border-gray-200']">
      <button type="button" @click="$emit('toggle')" :aria-expanded="open" :aria-controls="'settings-body-' + id"
        :class="['w-full flex items-center gap-3 px-6 py-4 text-left rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500', danger ? 'hover:bg-red-100/50' : 'hover:bg-gray-50']">
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2 flex-wrap">
            <h2 :class="['text-base font-semibold', danger ? 'text-red-900' : 'text-gray-900']">{{ title }}</h2>
            <span v-if="dirty" class="text-xs font-medium px-2 py-0.5 rounded-full bg-amber-100 text-amber-800">Unsaved changes</span>
            <span v-else-if="saved" class="text-xs font-medium px-2 py-0.5 rounded-full bg-green-100 text-green-800">Saved</span>
          </div>
          <p v-if="!open && summary" class="text-sm text-gray-500 truncate mt-0.5">{{ summary }}</p>
        </div>
        <svg :class="['w-5 h-5 flex-shrink-0 transition-transform', danger ? 'text-red-400' : 'text-gray-400', open ? 'rotate-180' : '']"
          viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>
      </button>
      <div v-show="open" :id="'settings-body-' + id" class="px-6 pb-6">
        <slot></slot>
      </div>
    </section>
  `,
};

// Save and Discard buttons at the bottom of a section whose changes wait for Save
const SaveBar = {
  name: 'SaveBar',
  props: { dirty: Boolean, saving: Boolean },
  emits: ['save', 'discard'],
  template: `
    <div class="flex items-center justify-end gap-3 mt-6 pt-4 border-t border-gray-100">
      <button v-if="dirty" type="button" @click="$emit('discard')" :disabled="saving" class="px-4 py-2 text-sm text-gray-600 hover:text-gray-900 disabled:opacity-50">Discard changes</button>
      <button type="button" @click="$emit('save')" :disabled="!dirty || saving" class="px-5 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-40 transition-colors">
        {{ saving ? 'Saving...' : 'Save Settings' }}
      </button>
    </div>
  `,
};

export default {
  name: 'SettingsView',
  components: { SettingsSection, SaveBar },
  setup() {
    const { ref, computed, onMounted, onBeforeUnmount, inject, nextTick } = Vue;
    const router = VueRouter.useRouter();
    const toast = inject('toast');
    const dateRange = inject('dateRange');
    const reloadAppSettings = inject('loadSettings');

    const settings = ref(null);
    const loading = ref(true);
    const saving = ref(''); // id of the section being saved
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
        if (settings.value) Object.keys(SNAPSHOTS).forEach(markSaved);
      } catch (e) {
        toast('Failed to load settings: ' + e.message, 'error');
      } finally {
        loading.value = false;
      }
    });

    // --- Sections whose changes wait for Save: Company, Department mapping, Assistant ---
    const SECTION_TITLES = { company: 'Company', mapping: 'Department mapping', assistant: 'Assistant' };
    const COMPANY_FIELDS = ['company_name', 'currency', 'fiscal_year_start', 'actuals_through', 'payroll_pay_day'];
    const ASSISTANT_FIELDS = ['company_context', 'assistant_model', 'assistant_relay_url'];
    const pick = (obj, keys) => Object.fromEntries(keys.map(k => [k, obj?.[k] ?? null]));
    const SNAPSHOTS = {
      company: () => JSON.stringify(pick(settings.value, COMPANY_FIELDS)),
      mapping: () => JSON.stringify(deptEntries.value.map(e => ({ dept: e.dept, cat: e.cat }))),
      assistant: () => JSON.stringify(pick(settings.value, ASSISTANT_FIELDS)),
    };
    const savedState = ref({}); // section id -> snapshot of what is in the database
    const markSaved = id => { savedState.value = { ...savedState.value, [id]: SNAPSHOTS[id]() }; };
    const isDirty = id => !!settings.value && id in savedState.value && savedState.value[id] !== SNAPSHOTS[id]();
    const dirtySection = computed(() => Object.keys(SNAPSHOTS).find(isDirty) || null);
    const savedValues = id => JSON.parse(savedState.value[id] || 'null');

    const discard = (id) => {
      const before = savedValues(id);
      if (!before) return;
      if (id === 'mapping') deptEntries.value = before;
      else Object.assign(settings.value, before);
    };

    // Saves one section. Returns false if it failed, so the caller can keep the page open.
    const saveSection = async (id) => {
      saving.value = id;
      try {
        if (id === 'company') {
          const fields = pick(settings.value, COMPANY_FIELDS);
          fields.actuals_through ||= null;
          fields.payroll_pay_day ||= null;
          await updateSettings(fields);
          Object.assign(settings.value, fields);
        } else if (id === 'mapping') {
          const mapping = {};
          deptEntries.value.forEach(e => { if (e.dept.trim()) mapping[e.dept.trim()] = e.cat; });
          await updateSettings({ dept_mapping: mapping });
          deptEntries.value = Object.entries(mapping).map(([dept, cat]) => ({ dept, cat }));
        } else if (id === 'assistant') {
          const fields = {
            assistant_relay_url: (settings.value.assistant_relay_url || '').trim() || DEFAULT_RELAY_URL,
            assistant_model: settings.value.assistant_model || DEFAULT_MODEL,
            company_context: settings.value.company_context || null,
          };
          await updateSettings(fields);
          Object.assign(settings.value, { ...fields, company_context: fields.company_context || '' });
        }
        markSaved(id);
        await reloadAppSettings();
        toast(`${SECTION_TITLES[id]} settings saved`, 'success');
        return true;
      } catch (e) {
        toast('Failed to save: ' + e.message, 'error');
        return false;
      } finally {
        saving.value = '';
      }
    };

    // Leaving a section with unsaved changes (closing it, opening another, or leaving the page) asks first
    const leaveDialog = ref(null); // { section, resolve }
    const confirmLeave = () => {
      const id = dirtySection.value;
      if (!id) return Promise.resolve(true);
      return new Promise(resolve => { leaveDialog.value = { section: id, title: SECTION_TITLES[id], resolve }; });
    };
    const answerLeave = async (choice) => {
      const d = leaveDialog.value;
      if (!d) return;
      let leave = choice !== 'stay';
      if (choice === 'save') leave = await saveSection(d.section);
      if (choice === 'discard') discard(d.section);
      leaveDialog.value = null;
      d.resolve(leave);
    };
    VueRouter.onBeforeRouteLeave(() => confirmLeave());

    const onBeforeUnload = (e) => {
      if (!dirtySection.value) return;
      e.preventDefault();
      e.returnValue = ''; // the browser shows its own "Leave site?" message
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    onBeforeUnmount(() => window.removeEventListener('beforeunload', onBeforeUnload));

    // --- Accordion: every section starts closed and one is open at a time ---
    const openSection = ref(null);
    const toggleSection = async (id) => {
      if (!(await confirmLeave())) return;
      openSection.value = openSection.value === id ? null : id;
      await nextTick();
      if (window.lucide) lucide.createIcons();
      if (openSection.value) document.getElementById('settings-' + id)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    };

    // Sections that save each change at once show "Saved" in their header for a moment
    const justSaved = ref('');
    let savedTimer = null;
    const flashSaved = (id) => {
      justSaved.value = id;
      clearTimeout(savedTimer);
      savedTimer = setTimeout(() => { justSaved.value = ''; }, 2500);
    };
    onBeforeUnmount(() => clearTimeout(savedTimer));

    // One-line summaries for closed sections, from what is saved
    const summaries = computed(() => {
      const company = savedValues('company') || {};
      const mapping = savedValues('mapping') || [];
      const assistant = savedValues('assistant') || {};
      const model = ASSISTANT_MODELS.find(m => m.id === assistant.assistant_model)?.label || assistant.assistant_model;
      const nSubs = subcategories.value.length;
      return {
        company: [company.company_name, company.currency,
          `Fiscal year starts in ${months[(company.fiscal_year_start || 1) - 1]}`,
          `Actuals through ${company.actuals_through ? monthLabelFull(company.actuals_through) : 'not set'}`].filter(Boolean).join(' · '),
        bank: bankAccounts.value.map(a => `${a.bank_name} (${a.currency})`).join(', '),
        subcategories: `${nSubs} sub-categor${nSubs === 1 ? 'y' : 'ies'} across ${expCategories.value.length} categories`,
        mapping: `${mapping.length} department${mapping.length === 1 ? '' : 's'} mapped to P&L categories`,
        assistant: [model, assistant.company_context ? 'Company description set' : 'No company description yet'].filter(Boolean).join(' · '),
        csv: 'Import or export expenses and payroll as CSV files',
        data: 'Back up or restore all data as a JSON file',
        danger: 'Reset all data or disconnect this browser',
      };
    });

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
        const rows = await Promise.all(tables.map(t => query(`SELECT * FROM ${t}`).catch(() => [])));
        tables.forEach((t, i) => { dump[t] = rows[i]; });
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
          // The backup may predate some upgrades: run them again on the next load
          await batch([...tables.map(t => `DELETE FROM ${t}`), "DELETE FROM _meta WHERE key = 'upgrades'"]);
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
        flashSaved('bank');
      } catch (e) { toast('Add failed: ' + e.message, 'error'); }
    };
    const updateAccount = async (acc, field, value) => {
      try {
        await execute(`UPDATE bank_accounts SET ${field} = ? WHERE id = ?`, [value || null, acc.id]);
        await loadBankAccounts();
        toast('Saved', 'success');
        flashSaved('bank');
      } catch (e) { toast('Save failed: ' + e.message, 'error'); }
    };
    const deleteAccount = async (acc) => {
      if (bankAccounts.value.length <= 1) return;
      try {
        await execute('DELETE FROM bank_accounts WHERE id = ?', [acc.id]);
        await loadBankAccounts();
        toast('Account removed', 'success');
        flashSaved('bank');
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
        flashSaved('subcategories');
      } catch (e) {
        toast(/UNIQUE/.test(e.message) ? 'That sub-category already exists in this category' : 'Add failed: ' + e.message, 'error');
      }
    };
    const updateSubcategory = async (sc, field, value) => {
      try {
        if (field === 'category_id') {
          // Expenses using it move along, so they never point to a sub-category of another category
          await batch([
            { sql: 'UPDATE expense_subcategories SET category_id = ? WHERE id = ?', args: [Number(value), sc.id] },
            { sql: 'UPDATE expense_items SET category_id = ? WHERE subcategory_id = ?', args: [Number(value), sc.id] },
          ]);
        } else {
          await execute('UPDATE expense_subcategories SET name = ? WHERE id = ?', [value, sc.id]);
        }
        await loadSubcategories();
        toast('Saved', 'success');
        flashSaved('subcategories');
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
        flashSaved('subcategories');
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
      settings, loading, saving, months, categories,
      isDirty, dirtySection, discard, saveSection, leaveDialog, answerLeave,
      openSection, toggleSection, justSaved, summaries,
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

      <div v-else-if="settings" class="space-y-4">
        <p class="text-sm text-gray-500">Open a section to see or change its settings.</p>

        <settings-section id="company" title="Company" :summary="summaries.company" :open="openSection === 'company'" :dirty="isDirty('company')" @toggle="toggleSection('company')">
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
              <label class="block text-sm font-medium text-gray-700 mb-1">Actuals through</label>
              <input v-model="settings.actuals_through" type="month" class="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"/>
              <p class="text-xs text-gray-400 mt-1">The last month with real figures. Revenue and P&L treat the months after it as forecasts.</p>
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
          <save-bar :dirty="isDirty('company')" :saving="saving === 'company'" @save="saveSection('company')" @discard="discard('company')"></save-bar>
        </settings-section>

        <settings-section v-if="bankAccounts.length" id="bank" title="Bank accounts" :summary="summaries.bank" :open="openSection === 'bank'" :saved="justSaved === 'bank'" @toggle="toggleSection('bank')">
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
        </settings-section>

        <settings-section v-if="expCategories.length && (subcategories.length || newSub.category_id)" id="subcategories" title="Expense sub-categories" :summary="summaries.subcategories" :open="openSection === 'subcategories'" :saved="justSaved === 'subcategories'" @toggle="toggleSection('subcategories')">
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
        </settings-section>

        <settings-section id="mapping" title="Department → P&L mapping" :summary="summaries.mapping" :open="openSection === 'mapping'" :dirty="isDirty('mapping')" @toggle="toggleSection('mapping')">
          <div class="flex items-center justify-between gap-4 mb-4">
            <p class="text-sm text-gray-500">Which P&L category each department's payroll goes into.</p>
            <button @click="addDeptEntry" class="text-sm text-indigo-600 hover:text-indigo-700 whitespace-nowrap">+ Add</button>
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
          <save-bar :dirty="isDirty('mapping')" :saving="saving === 'mapping'" @save="saveSection('mapping')" @discard="discard('mapping')"></save-bar>
        </settings-section>

        <settings-section id="assistant" title="Assistant" :summary="summaries.assistant" :open="openSection === 'assistant'" :dirty="isDirty('assistant')" @toggle="toggleSection('assistant')">
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
          <save-bar :dirty="isDirty('assistant')" :saving="saving === 'assistant'" @save="saveSection('assistant')" @discard="discard('assistant')"></save-bar>
        </settings-section>

        <settings-section id="csv" title="Expenses and payroll (CSV)" :summary="summaries.csv" :open="openSection === 'csv'" @toggle="toggleSection('csv')">
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
        </settings-section>

        <settings-section id="data" title="Data management" :summary="summaries.data" :open="openSection === 'data'" @toggle="toggleSection('data')">
          <div class="flex gap-3">
            <button @click="exportData" class="px-4 py-2 text-sm border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors">
              <i data-lucide="download" class="w-4 h-4 inline mr-1"></i> Export JSON
            </button>
            <button @click="importData" class="px-4 py-2 text-sm border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors">
              <i data-lucide="upload" class="w-4 h-4 inline mr-1"></i> Import JSON
            </button>
          </div>
        </settings-section>

        <settings-section id="danger" title="Danger zone" :summary="summaries.danger" :open="openSection === 'danger'" danger @toggle="toggleSection('danger')">
          <div class="flex gap-3">
            <button @click="showResetConfirm = true" class="px-4 py-2 text-sm text-red-600 border border-red-300 rounded-lg hover:bg-red-100 transition-colors">
              Reset All Data
            </button>
            <button @click="disconnect" class="px-4 py-2 text-sm text-red-600 border border-red-300 rounded-lg hover:bg-red-100 transition-colors">
              Disconnect
            </button>
          </div>
        </settings-section>

        <div v-if="leaveDialog" class="fixed inset-0 bg-black/50 flex items-center justify-center z-50" @click.self="answerLeave('stay')">
          <div class="bg-white rounded-xl p-6 w-full max-w-lg mx-4" role="dialog" aria-modal="true" aria-labelledby="leave-title">
            <h3 id="leave-title" class="text-lg font-semibold text-gray-900 mb-2">Save your changes?</h3>
            <p class="text-sm text-gray-600 mb-6">You changed the {{ leaveDialog.title }} settings without saving them.</p>
            <div class="flex justify-end gap-3 flex-wrap">
              <button @click="answerLeave('stay')" class="px-4 py-2 text-sm border border-gray-200 rounded-lg hover:bg-gray-50">Keep editing</button>
              <button @click="answerLeave('discard')" class="px-4 py-2 text-sm text-red-600 border border-red-200 rounded-lg hover:bg-red-50">Discard changes</button>
              <button @click="answerLeave('save')" :disabled="!!saving" class="px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50">{{ saving ? 'Saving...' : 'Save Settings' }}</button>
            </div>
          </div>
        </div>

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
