import { query, execute } from '../db.js';
import { getBaseScenarioId } from '../schema.js';
import { formatCents, monthLabelFull } from '../utils.js';
import { loadAccounts, accountLabel } from '../bank.js';
import { loadScenarioEmployees } from '../payroll.js';
import {
  MAX_PDF_BYTES, KIND_OPTIONS, kindLabel, buildContext, readStatement, prepareReview, needsDecision, findOverlaps,
  saveReview, findDiscrepancies, applyFix, deleteImport, discrepancyType, discrepancyFixes, distinctCompany,
} from '../statements.js';
import { loadCategoryLookups, subcategoryOptions } from '../expenses.js';
import ExpenseModal from '../../components/ExpenseModal.js';

// Colour and tag of each kind of discrepancy
const D_STYLE = {
  mismatch: { box: 'bg-amber-50 border-amber-400', tag: 'bg-amber-100 text-amber-800', label: 'Discrepancy' },
  missing: { box: 'bg-slate-50 border-slate-300', tag: 'bg-slate-200 text-slate-700', label: 'Not found' },
  suggestion: { box: 'bg-emerald-50 border-emerald-400', tag: 'bg-emerald-100 text-emerald-800', label: 'Suggestion' },
};

const SELECT = 'max-w-full px-2 py-1 text-sm border border-gray-200 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500';
const INPUT = 'w-full px-2 py-1 text-sm border border-gray-200 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500';
let nextId = 1;

export default {
  name: 'BankStatementsView',
  components: { ExpenseModal },
  setup() {
    const { ref, reactive, computed, onMounted, onBeforeUnmount, inject, watch } = Vue;
    const settings = inject('settings');
    const loadSettings = inject('loadSettings');
    const toast = inject('toast');

    const accounts = ref([]);
    const providers = ref([]);
    const categories = ref([]);
    const subcategories = ref([]);
    const employees = ref([]);
    const planned = ref([]);
    const history = ref([]);
    const queue = reactive([]);
    const dragging = ref(false);
    const filter = ref('decide');
    const openHistory = ref(null);
    const fileInput = ref(null);

    const loadLookups = async () => {
      try {
        const [acc, prov, lookups, emp, plan] = await Promise.all([
          loadAccounts(),
          query(`SELECT ei.id, ei.name, ei.company, ec.name AS category_name, ec.sort_order FROM expense_items ei
                 JOIN expense_categories ec ON ec.id = ei.category_id WHERE ei.visible = 1 ORDER BY ec.sort_order, ei.name`),
          loadCategoryLookups(),
          getBaseScenarioId().then(loadScenarioEmployees),
          query(`SELECT fe.id, fe.name, fe.month, fe.amount FROM funding_events fe JOIN scenarios s ON s.id = fe.scenario_id AND s.is_base = 1
                 WHERE fe.is_actual = 0 ORDER BY fe.month`).catch(() => []),
        ]);
        accounts.value = acc;
        providers.value = prov;
        categories.value = lookups.categories;
        subcategories.value = lookups.subcategories;
        employees.value = emp.employees.filter(e => e._source !== 'scenario');
        planned.value = plan;
      } catch (e) {
        toast('Failed to load: ' + e.message, 'error');
      }
    };
    const loadHistory = async () => {
      try {
        history.value = await query(`SELECT si.*, ba.bank_name, ba.label FROM statement_imports si
          LEFT JOIN bank_accounts ba ON ba.id = si.account_id ORDER BY si.created_at DESC, si.id DESC LIMIT 100`);
      } catch { history.value = []; }
    };
    onMounted(() => Promise.all([loadLookups(), loadHistory()]));

    // --- Queue: one statement is read at a time; reviews wait their turn ---
    const addFiles = (files) => {
      for (const f of files) {
        const isPdf = f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
        const item = reactive({ id: nextId++, name: f.name, size: f.size, file: f, status: 'queued', error: '', review: null, overlaps: [], importId: null,
          progress: { phase: 'sending', lines: 0 }, startedAt: null });
        if (!isPdf) { item.file = null; item.status = 'failed'; item.error = 'Not a PDF file.'; }
        else if (f.size > MAX_PDF_BYTES) { item.file = null; item.status = 'failed'; item.error = 'Larger than 24 MB. Split the statement into shorter periods.'; }
        queue.push(item);
      }
      pump();
    };
    const onPick = e => { addFiles([...e.target.files]); e.target.value = ''; };
    const onDrop = e => { dragging.value = false; addFiles([...e.dataTransfer.files]); };

    // Ticks every second while a statement is being read, for the elapsed time
    const now = ref(Date.now());
    const ticker = setInterval(() => { if (queue.some(i => i.status === 'reading')) now.value = Date.now(); }, 1000);
    onBeforeUnmount(() => clearInterval(ticker));
    const elapsed = item => {
      const s = Math.max(0, Math.round((now.value - (item.startedAt || now.value)) / 1000));
      return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
    };
    const progressText = item => {
      const p = item.progress;
      if (p.phase === 'preparing') return 'Extracting the text of the PDF...';
      if (p.phase === 'sending' || !p.lines) return 'Sending to the model, waiting for the first lines...';
      return `${p.lines} line${p.lines !== 1 ? 's' : ''} read so far...`;
    };

    let reading = false;
    async function pump() {
      if (reading) return;
      const item = queue.find(i => i.status === 'queued');
      if (!item) return;
      reading = true;
      item.status = 'reading';
      item.startedAt = Date.now();
      now.value = item.startedAt;
      const file = item.file;
      item.file = null; // the queue no longer holds the PDF; readStatement drops it once sent
      try {
        const parsed = await readStatement(file, settings.value, await buildContext(), undefined, p => { item.progress = p; });
        item.review = reactive(await prepareReview(parsed, item.name));
        item.overlaps = await findOverlaps(item.review.accountId, item.review.periodStart, item.review.periodEnd);
        item.status = 'review';
      } catch (e) {
        item.status = 'failed';
        item.error = e.message;
      } finally {
        reading = false;
        pump();
      }
    }

    const active = computed(() => queue.find(i => i.status === 'review' || i.status === 'saving') || null);
    const review = computed(() => active.value?.review || null);

    // Check for overlaps when a review opens: an earlier file in the same batch may have been saved since it was read
    watch(() => active.value?.id, async () => {
      const item = active.value;
      if (item?.review) item.overlaps = await findOverlaps(item.review.accountId, item.review.periodStart, item.review.periodEnd);
    });

    const onAccountChange = async () => {
      active.value.overlaps = await findOverlaps(review.value.accountId, review.value.periodStart, review.value.periodEnd);
    };
    const reviewAccount = computed(() => accounts.value.find(a => a.id === review.value?.accountId) || null);
    const currencyMismatch = computed(() => reviewAccount.value && review.value.currency && reviewAccount.value.currency !== review.value.currency);

    const rowsShown = computed(() => {
      if (!review.value) return [];
      return filter.value === 'decide' ? review.value.rows.filter(r => r.flagged) : review.value.rows;
    });
    const flaggedCount = computed(() => review.value ? review.value.rows.filter(r => r.flagged).length : 0);
    const toDecide = computed(() => review.value ? review.value.rows.filter(needsDecision).length : 0);
    const totals = computed(() => {
      const t = { in: 0, out: 0, byKind: {} };
      for (const r of review.value?.rows || []) {
        if (r.kind === 'ignore') continue;
        if (r.amount > 0) t.in += r.amount; else t.out -= r.amount;
        t.byKind[r.kind] = (t.byKind[r.kind] || 0) + r.amount;
      }
      return t;
    });
    const money = c => formatCents(c, review.value?.currency || reviewAccount.value?.currency);

    const providerGroups = computed(() => {
      const groups = [];
      for (const p of providers.value) {
        let g = groups.find(x => x.name === p.category_name);
        if (!g) { g = { name: p.category_name, items: [] }; groups.push(g); }
        g.items.push(p);
      }
      return groups;
    });

    // Changing a line's type or provider keeps the other fields consistent
    const blankProvider = row => ({
      name: row.counterparty || row.description, company: '', subcategory_id: null, recurrence: 'one_time',
      category_id: categories.value.find(c => c.name.startsWith('Uncategorized'))?.id || categories.value[0]?.id,
    });
    const setKind = (row, kind) => {
      row.kind = kind;
      row.confidence = 'high';
      row.saveLabel = false;
      if (kind === 'expense' && !row.expense_item_id && !row.newProvider) row.newProvider = blankProvider(row);
    };
    const providerChoice = row => row.expense_item_id ? String(row.expense_item_id) : (row.newProvider ? 'new' : '');
    const setProvider = (row, v) => {
      row.confidence = 'high';
      if (v.startsWith('emp:')) {
        // A person on the Payroll page: the line is a salary payment
        row.kind = 'salary';
        row.employee_id = Number(v.slice(4));
        row.saveLabel = true;
      } else if (v === 'new') {
        row.expense_item_id = null;
        row.newProvider ||= blankProvider(row);
        row.saveLabel = false;
      } else {
        row.expense_item_id = v ? Number(v) : null;
        row.saveLabel = !!v; // the bank's wording becomes the provider's charge label, so next time it matches
      }
    };
    const setEmployee = (row, v) => { row.employee_id = v ? Number(v) : null; row.confidence = 'high'; row.saveLabel = !!v; };
    const employeeName = id => employees.value.find(e => e.id === id)?.name || 'this person';
    const subOptionsFor = np => subcategoryOptions(subcategories.value, np.category_id);
    const onNewCategory = np => { if (!subOptionsFor(np).some(o => o.value === np.subcategory_id)) np.subcategory_id = null; };

    const setFunding = (row, v) => { row.funding_event_id = v ? Number(v) : null; row.confidence = 'high'; };

    const canSave = computed(() => review.value && review.value.accountId && !currencyMismatch.value
      && review.value.rows.every(r => !(r.kind === 'expense' && !r.expense_item_id && !r.newProvider?.name?.trim()))
      && review.value.rows.every(r => !(r.kind === 'salary' && !r.employee_id)));

    const save = async () => {
      const item = active.value;
      if (!item || !canSave.value) return;
      item.status = 'saving';
      try {
        const replaced = item.overlaps.map(o => o.id);
        item.importId = await saveReview(item.review, { replaceImportIds: replaced });
        sessionImports.value = [...sessionImports.value.filter(id => !replaced.includes(id)), item.importId];
        await loadSettings?.();
        await refreshDiscrepancies();
        item.status = 'done';
        item.review = null;
        toast(`${item.name} saved`, 'success');
        await Promise.all([loadLookups(), loadHistory()]);
      } catch (e) {
        item.status = 'review';
        toast('Save failed: ' + e.message, 'error');
      }
    };
    const discard = () => { const item = active.value; if (!item) return; item.status = 'discarded'; item.review = null; };
    const removeFromList = item => { const i = queue.indexOf(item); if (i >= 0) queue.splice(i, 1); };

    // --- Discrepancies: one list for every statement saved in this visit, checked again after each save ---
    // A later statement can settle an earlier one's discrepancy (a missing month, a charge paid from another
    // account), and two statements can raise the same one, so the list is rebuilt and de-duplicated each time.
    const sessionImports = ref([]);
    const discrepancies = ref([]);
    const checking = ref(false);
    const refreshDiscrepancies = async () => {
      checking.value = true;
      try {
        const seen = new Map();
        for (const id of sessionImports.value) {
          for (const d of await findDiscrepancies(id, settings.value)) seen.set(d.title + '|' + d.detail, { ...d, importId: id });
        }
        const order = { mismatch: 0, missing: 1, suggestion: 2 };
        discrepancies.value = [...seen.values()].sort((a, b) => order[discrepancyType(a)] - order[discrepancyType(b)]);
      } catch (e) {
        toast('Could not check for discrepancies: ' + e.message, 'error');
      } finally {
        checking.value = false;
      }
    };
    const dStyle = d => D_STYLE[discrepancyType(d)];
    const sessionImportsCount = computed(() => sessionImports.value.length);

    // --- Discrepancies and history ---
    const fix = async (d, f, importId) => {
      try {
        const msg = await applyFix(f);
        d.applied = true;
        const row = history.value.find(h => h.id === importId);
        const stored = JSON.parse(row?.discrepancies || '[]');
        const match = stored.find(s => s.title === d.title && s.detail === d.detail);
        if (match) match.applied = true;
        await execute('UPDATE statement_imports SET discrepancies = ? WHERE id = ?', [JSON.stringify(stored), importId]);
        if (f.action === 'set_actuals_through') await loadSettings?.();
        if (f.action === 'set_recurrence') await loadLookups();
        toast(msg, 'success');
        await loadHistory();
      } catch (e) { toast('Could not apply: ' + e.message, 'error'); }
    };
    const recheck = async (h) => {
      try {
        await findDiscrepancies(h.id, settings.value);
        await loadHistory();
        toast('Checked again', 'success');
      } catch (e) { toast('Check failed: ' + e.message, 'error'); }
    };
    // Edit the expense behind a discrepancy in the usual window; the discrepancies are checked again when it closes
    const editing = ref(null); // { itemId, history }
    const editExpense = (d, h) => { editing.value = { itemId: d.itemId, history: h, changed: false }; };
    const onEditClose = async () => {
      const e = editing.value;
      editing.value = null;
      if (!e?.changed) return;
      await loadLookups();
      if (e.history) await recheck(e.history);
      if (sessionImports.value.length) await refreshDiscrepancies();
    };

    const confirmDelete = ref(null);
    const doDelete = async () => {
      const h = confirmDelete.value;
      confirmDelete.value = null;
      try {
        await deleteImport(h.id);
        toast('Import deleted', 'success');
        await Promise.all([loadHistory(), loadLookups()]);
      } catch (e) { toast('Delete failed: ' + e.message, 'error'); }
    };
    const issues = h => JSON.parse(h.discrepancies || '[]');
    const openIssues = h => issues(h).filter(d => !d.applied).length;

    const statusLabel = {
      queued: 'Waiting', reading: 'Reading...', review: 'Ready to review', saving: 'Saving...',
      done: 'Saved', failed: 'Failed', discarded: 'Discarded',
    };
    const fmtDate = iso => iso ? new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
    const fmtShort = iso => iso ? new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '';

    return {
      SELECT, INPUT, KIND_OPTIONS, accounts, providers, providerGroups, categories, employees, planned, history, queue,
      discrepancies, checking, dStyle, sessionImportsCount, discrepancyFixes, elapsed, progressText, employeeName, subOptionsFor, onNewCategory, subcategories,
      dragging, filter, fileInput, openHistory, active, review, reviewAccount, currencyMismatch, rowsShown, toDecide, flaggedCount, totals,
      canSave, confirmDelete, statusLabel,
      onPick, onDrop, onAccountChange, setKind, providerChoice, setProvider, setEmployee, setFunding, save, discard,
      removeFromList, fix, recheck, editing, editExpense, onEditClose, doDelete, issues, openIssues, needsDecision, kindLabel, accountLabel,
      money, formatCents, monthLabelFull, fmtDate, fmtShort,
    };
  },
  template: `
    <div class="space-y-6">
      <div class="flex items-center justify-between flex-wrap gap-3">
        <h1 class="text-2xl font-bold text-gray-900">Bank Statements</h1>
        <router-link to="/settings" class="text-sm text-indigo-600 hover:text-indigo-800">Manage bank accounts</router-link>
      </div>

      <!-- Upload -->
      <div @dragover.prevent="dragging = true" @dragleave.prevent="dragging = false" @drop.prevent="onDrop"
        :class="['rounded-xl border-2 border-dashed p-6 text-center transition-colors', dragging ? 'border-indigo-400 bg-indigo-50' : 'border-gray-300 bg-white']">
        <p class="text-sm text-gray-700">Drop PDF bank statements here, one or several, or
          <button @click="fileInput.click()" class="text-indigo-600 hover:text-indigo-800 font-medium">choose files</button>.</p>
        <p class="text-xs text-gray-400 mt-1">Each statement is read by the assistant's model (Settings > Assistant) on its own, one after the other. PDFs are never stored: each one is discarded as soon as it has been read, or if reading fails.</p>
        <input ref="fileInput" type="file" accept="application/pdf,.pdf" multiple class="hidden" @change="onPick" aria-label="Choose PDF statements"/>
        <p v-if="accounts.length" class="text-xs text-gray-500 mt-3">Accounts: {{ accounts.map(a => accountLabel(a) + ' · ' + a.currency).join(', ') }}</p>
      </div>

      <!-- Queue -->
      <div v-if="queue.length" class="bg-white rounded-xl border border-gray-200 divide-y divide-gray-100">
        <div v-for="item in queue" :key="item.id" class="px-4 py-3 text-sm">
          <div class="flex items-center gap-3">
            <span :class="['inline-flex px-2 py-0.5 rounded-full text-xs font-medium whitespace-nowrap',
              item.status === 'done' ? 'bg-emerald-50 text-emerald-700' : item.status === 'failed' ? 'bg-red-50 text-red-700'
              : item.status === 'review' ? 'bg-amber-50 text-amber-700' : item.status === 'discarded' ? 'bg-gray-100 text-gray-500' : 'bg-indigo-50 text-indigo-700']">
              {{ statusLabel[item.status] }}
            </span>
            <span class="font-medium text-gray-900 truncate">{{ item.name }}</span>
            <span class="text-xs text-gray-400">{{ (item.size / 1048576).toFixed(1) }} MB</span>
            <button v-if="['done','failed','discarded'].includes(item.status)" @click="removeFromList(item)" class="ml-auto text-xs text-gray-400 hover:text-gray-700">Remove from list</button>
          </div>
          <div v-if="item.status === 'reading'" class="mt-2" role="status" aria-live="polite">
            <div class="h-1.5 w-full rounded-full bg-indigo-100 overflow-hidden">
              <div class="h-full w-1/3 rounded-full bg-indigo-500 progress-slide"></div>
            </div>
            <div class="flex justify-between text-xs text-gray-500 mt-1">
              <span>{{ progressText(item) }}</span><span class="tabular-nums">{{ elapsed(item) }}</span>
            </div>
          </div>
          <p v-if="item.status === 'failed'" class="text-xs text-red-600 mt-1">{{ item.error }}<template v-if="/\.pdf$/i.test(item.name)"> The PDF was discarded; drop it again to retry.</template></p>
        </div>
      </div>

      <!-- Discrepancies of every statement saved in this visit, one up-to-date list -->
      <div v-if="sessionImportsCount" class="bg-white rounded-xl border border-gray-200 p-4">
        <div class="flex items-center justify-between gap-3 flex-wrap mb-2">
          <h2 class="text-sm font-semibold text-gray-700">Discrepancies <span class="font-normal text-gray-400">({{ discrepancies.filter(d => !d.applied).length }} open, checked across the {{ sessionImportsCount }} statement{{ sessionImportsCount !== 1 ? 's' : '' }} saved)</span></h2>
          <div class="flex items-center gap-3 text-[11px] text-gray-500">
            <span class="inline-flex items-center gap-1"><span class="w-2.5 h-2.5 rounded-sm bg-amber-400"></span>Discrepancy</span>
            <span class="inline-flex items-center gap-1"><span class="w-2.5 h-2.5 rounded-sm bg-slate-300"></span>Not found</span>
            <span class="inline-flex items-center gap-1"><span class="w-2.5 h-2.5 rounded-sm bg-emerald-400"></span>Suggestion</span>
          </div>
        </div>
        <p v-if="checking" class="text-xs text-gray-400">Checking...</p>
        <div v-else class="space-y-2">
          <div v-for="d in discrepancies" :key="d.title + d.detail" :class="['rounded-lg border-l-4 px-3 py-2 text-sm', d.applied ? 'bg-gray-50 border-gray-200 text-gray-400' : dStyle(d).box]">
                      <div class="flex items-start gap-2">
                        <span :class="['shrink-0 mt-0.5 px-1.5 py-0.5 rounded text-[11px] font-medium', d.applied ? 'bg-gray-100 text-gray-400' : dStyle(d).tag]">{{ d.applied ? 'Done' : dStyle(d).label }}</span>
                        <div class="min-w-0">
                          <div class="font-medium text-gray-900">{{ d.title }}</div>
                          <div class="text-gray-600 text-xs mt-0.5">{{ d.detail }}</div>
                          <div v-if="!d.applied && (discrepancyFixes(d).length || d.itemId)" class="mt-1.5 flex flex-wrap gap-1.5">
                            <button v-for="f in discrepancyFixes(d)" :key="f.label" @click="fix(d, f, d.importId)" class="px-2.5 py-1 text-xs rounded-md bg-white border border-gray-200 hover:bg-gray-50">{{ f.label }}</button>
                            <button v-if="d.itemId" @click="editExpense(d, null)" class="px-2.5 py-1 text-xs rounded-md text-indigo-600 hover:text-indigo-800 hover:bg-white">Edit expense...</button>
                          </div>
                        </div>
                      </div>
                    </div>
          <p v-if="!discrepancies.length" class="text-xs text-emerald-700">No discrepancies found.</p>
        </div>
      </div>

      <!-- Review -->
      <div v-if="review" class="bg-white rounded-xl border border-indigo-200 shadow-sm">
        <div class="p-5 border-b border-gray-100 space-y-3">
          <div class="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <div class="text-xs font-medium text-indigo-600 uppercase tracking-wider">Review before saving</div>
              <h2 class="text-lg font-semibold text-gray-900">{{ active.name }}</h2>
              <div class="text-sm text-gray-500">{{ review.parsed.bank_name }} · {{ review.currency }} · {{ fmtDate(review.periodStart) }} to {{ fmtDate(review.periodEnd) }}</div>
              <div v-if="review.readBy" class="text-xs text-gray-400 mt-0.5">Read by {{ review.readBy }}</div>
            </div>
            <div class="flex items-center gap-2">
              <label for="review-account" class="text-sm text-gray-600">Account</label>
              <select id="review-account" v-model.number="review.accountId" @change="onAccountChange" :class="SELECT">
                <option :value="null" disabled>Choose...</option>
                <option v-for="a in accounts" :key="a.id" :value="a.id">{{ accountLabel(a) }} ({{ a.currency }})</option>
              </select>
            </div>
          </div>
          <div class="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
            <div><div class="text-xs text-gray-500">Opening balance</div><div class="font-semibold tabular-nums">{{ money(review.opening) }}</div></div>
            <div><div class="text-xs text-gray-500">Closing balance</div><div class="font-semibold tabular-nums">{{ money(review.closing) }}</div></div>
            <div><div class="text-xs text-gray-500">Money in</div><div class="font-semibold text-emerald-700 tabular-nums">{{ money(totals.in) }}</div></div>
            <div><div class="text-xs text-gray-500">Money out</div><div class="font-semibold text-red-700 tabular-nums">{{ money(totals.out) }}</div></div>
          </div>
          <div v-if="review.monthEnds.length" class="text-xs text-gray-500">
            Month-end balances saved for the account:
            <span v-for="b in review.monthEnds" :key="b.month" class="inline-block mr-3">{{ monthLabelFull(b.month) }}: <b class="text-gray-800">{{ money(b.balance) }}</b></span>
          </div>
          <p v-if="!review.accountId" class="text-sm text-amber-700 bg-amber-50 rounded-lg px-3 py-2">Choose which account this statement belongs to. If it's a new bank, add it in Settings first.</p>
          <p v-if="currencyMismatch" class="text-sm text-red-700 bg-red-50 rounded-lg px-3 py-2">This statement is in {{ review.currency }} but {{ accountLabel(reviewAccount) }} is in {{ reviewAccount.currency }}. Choose the right account, or change the account's currency in Settings.</p>
          <p v-if="active.overlaps.length" class="text-sm text-amber-800 bg-amber-50 rounded-lg px-3 py-2">
            This period overlaps {{ active.overlaps.map(o => o.file_name + ' (' + fmtDate(o.period_start) + ' to ' + fmtDate(o.period_end) + ')').join(', ') }}, already imported for this account. Saving replaces {{ active.overlaps.length > 1 ? 'those imports' : 'that import' }}.
          </p>
          <ul v-if="review.warnings.length" class="text-sm text-amber-800 bg-amber-50 rounded-lg px-3 py-2 list-disc pl-6">
            <li v-for="w in review.warnings" :key="w">{{ w }}</li>
          </ul>
        </div>

        <div class="px-5 pt-4 flex items-center gap-2">
          <button @click="filter = 'decide'" :class="['px-3 py-1.5 text-sm rounded-md', filter === 'decide' ? 'bg-indigo-600 text-white' : 'text-gray-600 hover:bg-gray-50']">To check ({{ flaggedCount }})</button>
          <button @click="filter = 'all'" :class="['px-3 py-1.5 text-sm rounded-md', filter === 'all' ? 'bg-indigo-600 text-white' : 'text-gray-600 hover:bg-gray-50']">All lines ({{ review.rows.length }})</button>
        </div>
        <div class="overflow-x-auto p-2">
          <table class="w-full text-sm">
            <thead>
              <tr class="text-left text-xs text-gray-500 uppercase tracking-wider border-b border-gray-100">
                <th class="sticky-col px-3 py-2 font-medium">Date</th>
                <th class="px-3 py-2 font-medium">Bank line</th>
                <th class="px-3 py-2 font-medium text-right">Amount</th>
                <th class="px-3 py-2 font-medium">Type</th>
                <th class="px-3 py-2 font-medium min-w-[12rem] md:min-w-[16rem]">Linked to</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in rowsShown" :key="r.key" :class="['border-b border-gray-50 align-top', r.kind === 'ignore' ? 'opacity-50' : '']">
                <td class="sticky-col px-3 py-2 whitespace-nowrap text-gray-600">{{ fmtShort(r.date) }}</td>
                <td class="px-3 py-2 max-w-[22rem]">
                  <div class="text-gray-900 break-words">{{ r.description }}</div>
                  <div v-if="r.note" class="text-xs text-gray-500 mt-0.5">{{ r.note }}</div>
                  <span v-if="r.confidence !== 'high'" :class="['inline-block mt-1 px-1.5 py-0.5 rounded text-[11px]', r.confidence === 'low' ? 'bg-amber-100 text-amber-800' : 'bg-gray-100 text-gray-600']">{{ r.confidence === 'low' ? 'Unsure' : 'Likely' }}</span>
                </td>
                <td :class="['px-3 py-2 text-right tabular-nums whitespace-nowrap', r.amount < 0 ? 'text-red-700' : 'text-emerald-700']">{{ money(r.amount) }}</td>
                <td class="px-3 py-2">
                  <select :value="r.kind" @change="setKind(r, $event.target.value)" :class="SELECT" :aria-label="'Type of ' + r.description">
                    <option v-for="o in KIND_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
                  </select>
                </td>
                <td class="px-3 py-2">
                  <template v-if="r.kind === 'expense' || r.kind === 'refund'">
                    <select :value="providerChoice(r)" @change="setProvider(r, $event.target.value)" :class="SELECT + ' w-full'" :aria-label="'Provider for ' + r.description">
                      <option value="">{{ r.kind === 'refund' ? 'Not linked' : 'Choose...' }}</option>
                      <option v-if="r.kind === 'expense'" value="new">+ New provider</option>
                      <optgroup v-for="g in providerGroups" :key="g.name" :label="g.name">
                        <option v-for="p in g.items" :key="p.id" :value="String(p.id)">{{ p.name }}{{ p.company ? ' (' + p.company + ')' : '' }}</option>
                      </optgroup>
                      <optgroup v-if="r.kind === 'expense' && employees.length" label="Payroll (records the line as a salary)">
                        <option v-for="e in employees" :key="'emp' + e.id" :value="'emp:' + e.id">{{ e.name }}{{ e.role ? ' (' + e.role + ')' : '' }}</option>
                      </optgroup>
                    </select>
                    <div v-if="r.kind === 'expense' && !r.expense_item_id && r.newProvider" class="mt-2 grid grid-cols-2 gap-2">
                      <input v-model="r.newProvider.name" :class="INPUT" placeholder="Provider name" :aria-label="'New provider name for ' + r.description"/>
                      <input v-model="r.newProvider.company" :class="INPUT" placeholder="Company" aria-label="Company"/>
                      <select v-model.number="r.newProvider.category_id" @change="onNewCategory(r.newProvider)" :class="SELECT" aria-label="Category">
                        <option v-for="c in categories" :key="c.id" :value="c.id">{{ c.name }}</option>
                      </select>
                      <select v-model="r.newProvider.subcategory_id" :class="SELECT" aria-label="Sub-category" :disabled="!subcategories.length"
                        :title="subcategories.length ? '' : 'Sub-categories are not set up on this database yet'">
                        <option v-for="o in subOptionsFor(r.newProvider)" :key="String(o.value)" :value="o.value">{{ o.value === null ? 'No sub-category' : o.label }}</option>
                      </select>
                      <select v-model="r.newProvider.recurrence" :class="SELECT" aria-label="Recurrence">
                        <option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="quarterly">Quarterly</option>
                        <option value="annual">Annual</option><option value="one_time">One-time</option>
                      </select>
                    </div>
                    <label v-if="r.expense_item_id" class="mt-1.5 flex items-center gap-1.5 text-xs text-gray-500">
                      <input type="checkbox" v-model="r.saveLabel"/> Save this bank wording as the provider's charge label
                    </label>
                  </template>
                  <template v-else-if="r.kind === 'salary'">
                  <select :value="r.employee_id ? String(r.employee_id) : ''" @change="setEmployee(r, $event.target.value)" :class="SELECT + ' w-full'" :aria-label="'Employee for ' + r.description">
                    <option value="">Choose...</option>
                    <option v-for="e in employees" :key="e.id" :value="String(e.id)">{{ e.name }}{{ e.role ? ' (' + e.role + ')' : '' }}</option>
                  </select>
                  <label v-if="r.kind === 'salary' && r.employee_id" class="mt-1.5 flex items-center gap-1.5 text-xs text-gray-500">
                    <input type="checkbox" v-model="r.saveLabel"/> Save this bank wording as {{ employeeName(r.employee_id) }}'s charge label
                  </label>
                  </template>
                  <div v-else-if="r.kind === 'funding'" class="space-y-1.5">
                    <input v-model="r.investor_name" :class="INPUT" placeholder="Investor name" :aria-label="'Investor for ' + r.description"/>
                    <select :value="r.funding_event_id ? String(r.funding_event_id) : ''" @change="setFunding(r, $event.target.value)" :class="SELECT + ' w-full'" aria-label="Funding event">
                      <option value="">Record as a new funding event</option>
                      <option v-for="f in planned" :key="f.id" :value="String(f.id)">Mark planned "{{ f.name }}" ({{ monthLabelFull(f.month) }}, {{ formatCents(f.amount) }}) as received</option>
                    </select>
                  </div>
                  <span v-else class="text-gray-400 text-xs">{{ r.kind === 'transfer' ? 'Not counted: money stays in the company' : r.kind === 'ignore' ? 'Not counted' : 'Counted in Cash Flow' }}</span>
                </td>
              </tr>
              <tr v-if="!rowsShown.length"><td colspan="5" class="px-3 py-6 text-center text-gray-400">{{ filter === 'decide' ? 'The model was sure about every line. Look through "All lines" if you want, then save.' : 'No lines on this statement.' }}</td></tr>
            </tbody>
          </table>
        </div>
        <div class="p-5 border-t border-gray-100 flex items-center justify-end gap-3 flex-wrap">
          <span v-if="!canSave && review.accountId && !currencyMismatch" class="text-xs text-gray-500 mr-auto">Every expense needs a provider and every salary an employee before saving.</span>
          <button @click="discard" :disabled="active.status === 'saving'" class="px-4 py-2 text-sm border border-gray-200 rounded-lg hover:bg-gray-50">Discard</button>
          <button @click="save" :disabled="!canSave || active.status === 'saving'" class="px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-40">
            {{ active.status === 'saving' ? 'Saving...' : 'Save statement' }}
          </button>
        </div>
      </div>

      <!-- History -->
      <div class="bg-white rounded-xl border border-gray-200">
        <h2 class="text-sm font-semibold text-gray-700 px-5 pt-5 pb-3">Imported statements</h2>
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead>
              <tr class="text-left text-xs text-gray-500 uppercase tracking-wider border-b border-gray-100">
                <th class="sticky-col px-5 py-2 font-medium">Account</th>
                <th class="px-3 py-2 font-medium">Period</th>
                <th class="px-3 py-2 font-medium">File</th>
                <th class="px-3 py-2 font-medium text-right">Lines</th>
                <th class="px-3 py-2 font-medium text-right">Closing balance</th>
                <th class="px-3 py-2 font-medium">Discrepancies</th>
                <th class="px-5 py-2"></th>
              </tr>
            </thead>
            <tbody>
              <template v-for="h in history" :key="h.id">
                <tr class="border-b border-gray-50">
                  <td class="sticky-col px-5 py-2.5 text-gray-900 whitespace-nowrap">{{ h.label || h.bank_name || 'Deleted account' }}</td>
                  <td class="px-3 py-2.5 text-gray-600 whitespace-nowrap">{{ fmtDate(h.period_start) }} to {{ fmtDate(h.period_end) }}</td>
                  <td class="px-3 py-2.5 text-gray-500 max-w-[14rem]">
                    <div class="truncate">{{ h.file_name }}</div>
                    <div v-if="h.read_by" class="text-xs text-gray-400 truncate">Read by {{ h.read_by }}</div>
                  </td>
                  <td class="px-3 py-2.5 text-right tabular-nums">{{ h.transaction_count }}</td>
                  <td class="px-3 py-2.5 text-right tabular-nums">{{ formatCents(h.closing_balance, h.currency) }}</td>
                  <td class="px-3 py-2.5">
                    <button @click="openHistory = openHistory === h.id ? null : h.id" :class="['text-xs', openIssues(h) ? 'text-amber-700 hover:text-amber-900' : 'text-gray-400 hover:text-gray-700']">
                      {{ openIssues(h) ? openIssues(h) + ' to look at' : 'None open' }}
                    </button>
                  </td>
                  <td class="px-5 py-2.5 text-right whitespace-nowrap">
                    <button @click="recheck(h)" class="text-xs text-indigo-600 hover:text-indigo-800 mr-3">Check again</button>
                    <button @click="confirmDelete = h" class="text-xs text-red-500 hover:text-red-700">Delete</button>
                  </td>
                </tr>
                <tr v-if="openHistory === h.id">
                  <td colspan="7" class="px-5 pb-4">
                    <div class="space-y-2 mt-2">
                    <div v-for="(d, i) in issues(h)" :key="i" :class="['rounded-lg border-l-4 px-3 py-2 text-sm', d.applied ? 'bg-gray-50 border-gray-200 text-gray-400' : dStyle(d).box]">
                      <div class="flex items-start gap-2">
                        <span :class="['shrink-0 mt-0.5 px-1.5 py-0.5 rounded text-[11px] font-medium', d.applied ? 'bg-gray-100 text-gray-400' : dStyle(d).tag]">{{ d.applied ? 'Done' : dStyle(d).label }}</span>
                        <div class="min-w-0">
                          <div class="font-medium text-gray-900">{{ d.title }}</div>
                          <div class="text-gray-600 text-xs mt-0.5">{{ d.detail }}</div>
                          <div v-if="!d.applied && (discrepancyFixes(d).length || d.itemId)" class="mt-1.5 flex flex-wrap gap-1.5">
                            <button v-for="f in discrepancyFixes(d)" :key="f.label" @click="fix(d, f, h.id)" class="px-2.5 py-1 text-xs rounded-md bg-white border border-gray-200 hover:bg-gray-50">{{ f.label }}</button>
                            <button v-if="d.itemId" @click="editExpense(d, h)" class="px-2.5 py-1 text-xs rounded-md text-indigo-600 hover:text-indigo-800 hover:bg-white">Edit expense...</button>
                          </div>
                        </div>
                      </div>
                    </div>
                    </div>
                    <p v-if="!issues(h).length" class="text-sm text-gray-400 mt-2">No discrepancies.</p>
                  </td>
                </tr>
              </template>
              <tr v-if="!history.length"><td colspan="7" class="px-5 py-6 text-center text-gray-400">No statements imported yet</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <expense-modal v-if="editing" :item-id="editing.itemId" :categories="categories" :subcategories="subcategories"
        @saved="editing.changed = true" @close="onEditClose"/>

      <div v-if="confirmDelete" class="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
        <div class="bg-white rounded-xl p-6 max-w-sm" role="dialog" aria-modal="true">
          <h3 class="text-lg font-semibold text-gray-900 mb-2">Delete this import?</h3>
          <p class="text-sm text-gray-600 mb-6">{{ confirmDelete.file_name }}: its lines, the month-end balances it recorded and the funding events it created are removed. Providers it added stay.</p>
          <div class="flex justify-end gap-3">
            <button @click="confirmDelete = null" class="px-4 py-2 text-sm border border-gray-200 rounded-lg hover:bg-gray-50">Cancel</button>
            <button @click="doDelete" class="px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700">Delete</button>
          </div>
        </div>
      </div>
    </div>
  `,
};
