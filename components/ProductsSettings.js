// Settings > Products: the ProfitWell sync, and how its plans are grouped for display.
// Plans (from ProfitWell) go into product lines; product lines go into families. Changes are saved immediately.
import { query, execute, batch } from '../js/db.js';
import { CURRENCIES, formatCents } from '../js/utils.js';
import { getSettings, updateSettings } from '../js/schema.js';
import { syncProfitwell, loadProducts, lastActualMonth, UNASSIGNED_LINE } from '../js/profitwell.js';

export default {
  name: 'ProductsSettings',
  emits: ['saved', 'synced'],
  setup(props, { emit }) {
    const { ref, computed, onMounted, inject } = Vue;
    const toast = inject('toast');
    const reloadAppSettings = inject('loadSettings');
    const mrrVersion = inject('mrrVersion', ref(0));

    const families = ref([]);
    const lines = ref([]);
    const plans = ref([]);
    const lastMrr = ref({}); // plan_id -> MRR in the last actual month
    const settings = ref(null);
    const syncing = ref(false);
    const selected = ref([]); // plan ids ticked for a bulk move
    const bulkLine = ref('');
    const newFamily = ref('');
    const newLine = ref({ name: '', family_id: '' });

    async function load() {
      const [p, s, mrr] = await Promise.all([
        loadProducts(),
        getSettings(),
        query('SELECT plan_id, mrr FROM pw_mrr WHERE month = ?', [lastActualMonth()]).catch(() => []),
      ]);
      families.value = p.families;
      lines.value = p.lines.filter(l => l.id !== UNASSIGNED_LINE.id);
      plans.value = p.plans;
      settings.value = s;
      lastMrr.value = Object.fromEntries(mrr.map(r => [r.plan_id, r.mrr]));
    }
    onMounted(load);

    const changed = async (reloadMrr = true) => {
      await load();
      emit('saved');
      if (reloadMrr) mrrVersion.value++;
    };
    const run = async (fn, okMessage) => {
      try { await fn(); if (okMessage) toast(okMessage, 'success'); await changed(); }
      catch (e) { toast(e.message, 'error'); }
    };

    // --- Sync ---
    async function syncNow() {
      syncing.value = true;
      try {
        const r = await syncProfitwell();
        toast(`ProfitWell synced: ${r.plans} plans, ${r.months} months`, 'success');
        await reloadAppSettings?.();
        await changed();
        emit('synced');
      } catch (e) {
        toast('ProfitWell sync failed: ' + e.message, 'error');
      } finally { syncing.value = false; }
    }
    const lastSync = computed(() => settings.value?.profitwell_last_sync
      ? new Date(settings.value.profitwell_last_sync).toLocaleString() : 'never');
    const setPwCurrency = v => run(() => updateSettings({ profitwell_currency: v }), 'Saved. Sync again to convert the figures.');

    // --- Families ---
    const addFamily = () => run(async () => {
      const name = newFamily.value.trim(); if (!name) return;
      await execute('INSERT INTO product_families (name, sort_order) VALUES (?, ?)', [name, families.value.length + 1]);
      newFamily.value = '';
    });
    const renameFamily = (f, name) => name?.trim() && run(() => execute('UPDATE product_families SET name = ? WHERE id = ?', [name.trim(), f.id]));
    const deleteFamily = f => run(() => batch([
      { sql: 'UPDATE product_lines SET family_id = NULL WHERE family_id = ?', args: [f.id] },
      { sql: 'DELETE FROM product_families WHERE id = ?', args: [f.id] },
    ]));

    // --- Lines ---
    const addLine = () => run(async () => {
      const name = newLine.value.name.trim(); if (!name) return;
      await execute('INSERT INTO product_lines (name, family_id, sort_order) VALUES (?, ?, ?)',
        [name, newLine.value.family_id || null, lines.value.length + 1]);
      newLine.value = { name: '', family_id: newLine.value.family_id };
    });
    const renameLine = (l, name) => name?.trim() && run(() => execute('UPDATE product_lines SET name = ? WHERE id = ?', [name.trim(), l.id]));
    const setLineFamily = (l, familyId) => run(() => execute('UPDATE product_lines SET family_id = ? WHERE id = ?', [familyId || null, l.id]));
    const deleteLine = l => run(() => batch([
      { sql: 'UPDATE pw_plans SET line_id = NULL WHERE line_id = ?', args: [l.id] },
      { sql: 'DELETE FROM line_growth WHERE line_id = ?', args: [l.id] },
      { sql: 'DELETE FROM product_lines WHERE id = ?', args: [l.id] },
    ]));
    const moveLine = (l, dir) => {
      const sib = lines.value.filter(x => x.family_id === l.family_id);
      const i = sib.indexOf(l), j = i + dir;
      if (j < 0 || j >= sib.length) return;
      [sib[i], sib[j]] = [sib[j], sib[i]];
      run(() => batch(sib.map((x, k) => ({ sql: 'UPDATE product_lines SET sort_order = ? WHERE id = ?', args: [k + 1, x.id] }))));
    };

    // --- Plans ---
    const setPlanLine = (planIds, lineId) => run(() => batch(planIds.map(id => ({
      sql: 'UPDATE pw_plans SET line_id = ? WHERE plan_id = ?', args: [lineId ? Number(lineId) : null, id],
    }))));
    const moveSelected = async () => {
      if (!selected.value.length) return;
      await setPlanLine(selected.value, bulkLine.value);
      selected.value = [];
    };
    const allSelected = computed(() => plans.value.length > 0 && selected.value.length === plans.value.length);
    const toggleAll = () => { selected.value = allSelected.value ? [] : plans.value.map(p => p.plan_id); };

    const familyOptions = computed(() => [{ value: null, label: 'No family' }, ...families.value.map(f => ({ value: f.id, label: f.name }))]);
    const lineOptions = computed(() => [{ value: '', label: UNASSIGNED_LINE.name }, ...lines.value.map(l => ({ value: l.id, label: l.name }))]);
    const familyName = id => families.value.find(f => f.id === id)?.name || 'No family';
    const lineName = id => lines.value.find(l => l.id === id)?.name || UNASSIGNED_LINE.name;
    const plansOf = lineId => plans.value.filter(p => (p.line_id || null) === lineId);
    // Lines grouped under their family, families in order, lines without a family last
    const grouped = computed(() => [
      ...families.value.map(f => ({ family: f, lines: lines.value.filter(l => l.family_id === f.id) })),
      { family: null, lines: lines.value.filter(l => !l.family_id || !families.value.some(f => f.id === l.family_id)) },
    ]);

    return {
      CURRENCIES, families, lines, plans, lastMrr, settings, syncing, selected, bulkLine, newFamily, newLine,
      lastSync, syncNow, setPwCurrency, addFamily, renameFamily, deleteFamily, addLine, renameLine, setLineFamily,
      deleteLine, moveLine, setPlanLine, moveSelected, allSelected, toggleAll, familyOptions, lineOptions,
      familyName, lineName, plansOf, grouped, formatCents, lastActualMonth,
    };
  },
  template: `
    <div class="space-y-8">
      <!-- Sync -->
      <div>
        <h3 class="text-sm font-semibold text-gray-900 mb-1">ProfitWell</h3>
        <p class="text-sm text-gray-500 mb-3">
          MRR comes from ProfitWell for every month up to the last complete one; later months grow it by each product line's
          planned rate (on the Revenue page). Vintana re-reads the whole history once a month, from the 1st, when someone opens it.
        </p>
        <div class="flex flex-wrap items-center gap-3">
          <button type="button" @click="syncNow" :disabled="syncing" class="px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50">
            {{ syncing ? 'Syncing...' : 'Sync now' }}
          </button>
          <span class="text-sm text-gray-500">Last sync: {{ lastSync }}</span>
          <label class="flex items-center gap-2 text-sm text-gray-600 ml-auto">
            ProfitWell currency
            <select :value="settings?.profitwell_currency || settings?.currency" @change="setPwCurrency($event.target.value)"
              class="px-2 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500">
              <option v-for="c in CURRENCIES" :key="c" :value="c">{{ c }}</option>
            </select>
          </label>
        </div>
        <p v-if="settings?.profitwell_sync_note" class="mt-3 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">{{ settings.profitwell_sync_note }}</p>
        <p class="mt-3 text-xs text-gray-500">
          The relay needs the ProfitWell <em>private</em> API token as the secret <code>PROFITWELL_API_TOKEN</code> in the Bunny dashboard
          (ProfitWell: Account Settings, Integrations, ProfitWell API).
        </p>
      </div>

      <!-- Families and lines -->
      <div>
        <h3 class="text-sm font-semibold text-gray-900 mb-1">Families and product lines</h3>
        <p class="text-sm text-gray-500 mb-3">The Revenue page and the P&L show product lines, grouped by family. Click a name to rename it.</p>
        <div class="space-y-4">
          <div v-for="g in grouped" :key="g.family ? g.family.id : 'none'">
            <div v-if="g.family || g.lines.length" class="flex items-center gap-2 mb-1">
              <span v-if="g.family" class="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                <inline-edit :value="g.family.name" @save="v => renameFamily(g.family, v)"/>
              </span>
              <span v-else class="text-xs font-semibold text-gray-400 uppercase tracking-wide">No family</span>
              <button v-if="g.family" @click="deleteFamily(g.family)" class="text-gray-300 hover:text-red-500" :aria-label="'Delete family ' + g.family.name" title="Delete family (its lines stay)">
                <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg>
              </button>
            </div>
            <div v-if="g.lines.length" class="divide-y divide-gray-100 border border-gray-100 rounded-lg">
              <div v-for="l in g.lines" :key="l.id" class="flex flex-wrap items-center gap-3 px-3 py-1.5 text-sm">
                <div class="flex-1 min-w-[8rem] font-medium text-gray-900"><inline-edit :value="l.name" @save="v => renameLine(l, v)"/></div>
                <span class="text-xs text-gray-400 whitespace-nowrap">{{ plansOf(l.id).length }} plan{{ plansOf(l.id).length === 1 ? '' : 's' }}</span>
                <inline-edit :value="l.family_id" :options="familyOptions" :display="familyName(l.family_id)" @save="v => setLineFamily(l, v)"/>
                <button @click="moveLine(l, -1)" class="text-gray-400 hover:text-gray-700" aria-label="Move up" title="Move up">&uarr;</button>
                <button @click="moveLine(l, 1)" class="text-gray-400 hover:text-gray-700" aria-label="Move down" title="Move down">&darr;</button>
                <button @click="deleteLine(l)" class="text-gray-400 hover:text-red-500" :aria-label="'Delete ' + l.name" title="Delete (its plans become Unassigned)">
                  <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg>
                </button>
              </div>
            </div>
          </div>
        </div>
        <div class="flex flex-wrap items-center gap-3 mt-4">
          <form @submit.prevent="addLine" class="flex flex-wrap items-center gap-2 flex-1 min-w-[16rem]">
            <input v-model="newLine.name" placeholder="New product line (e.g. Premium Studio)" aria-label="New product line" class="flex-1 min-w-[10rem] px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"/>
            <select v-model="newLine.family_id" aria-label="Family" class="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500">
              <option value="">No family</option>
              <option v-for="f in families" :key="f.id" :value="f.id">{{ f.name }}</option>
            </select>
            <button type="submit" :disabled="!newLine.name.trim()" class="px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-40">Add line</button>
          </form>
          <form @submit.prevent="addFamily" class="flex items-center gap-2">
            <input v-model="newFamily" placeholder="New family" aria-label="New family" class="w-40 px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"/>
            <button type="submit" :disabled="!newFamily.trim()" class="px-4 py-2 text-sm border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-40">Add family</button>
          </form>
        </div>
      </div>

      <!-- Plans -->
      <div>
        <h3 class="text-sm font-semibold text-gray-900 mb-1">ProfitWell plans</h3>
        <p class="text-sm text-gray-500 mb-3">Put each plan in a product line. Tick several to move them together.</p>
        <p v-if="!plans.length" class="text-sm text-gray-400">No plans yet. Sync ProfitWell first.</p>
        <template v-else>
          <div class="flex flex-wrap items-center gap-2 mb-2">
            <span class="text-sm text-gray-600">{{ selected.length }} selected</span>
            <select v-model="bulkLine" aria-label="Move selected plans to" class="px-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500">
              <option v-for="o in lineOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
            </select>
            <button type="button" @click="moveSelected" :disabled="!selected.length" class="px-3 py-1.5 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-40">Move</button>
          </div>
          <div class="overflow-x-auto border border-gray-100 rounded-lg">
            <table class="w-full text-sm">
              <thead>
                <tr class="text-left text-xs text-gray-500 uppercase tracking-wider border-b border-gray-100">
                  <th class="sticky-col px-3 py-2 w-8"><input type="checkbox" :checked="allSelected" @change="toggleAll" aria-label="Select all plans"/></th>
                  <th class="px-3 py-2 font-medium">Plan</th>
                  <th class="px-3 py-2 font-medium text-right whitespace-nowrap">MRR {{ lastActualMonth() }}</th>
                  <th class="px-3 py-2 font-medium">Product line</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="p in plans" :key="p.plan_id" class="border-b border-gray-50">
                  <td class="sticky-col px-3 py-1.5"><input type="checkbox" :value="p.plan_id" v-model="selected" :aria-label="'Select ' + p.plan_id"/></td>
                  <td class="px-3 py-1.5 text-gray-900 break-all">{{ p.plan_id }}</td>
                  <td class="px-3 py-1.5 text-right tabular-nums text-gray-600 whitespace-nowrap">{{ lastMrr[p.plan_id] ? formatCents(lastMrr[p.plan_id]) : '' }}</td>
                  <td class="px-3 py-1.5"><inline-edit :value="p.line_id || ''" :options="lineOptions" :display="lineName(p.line_id)" @save="v => setPlanLine([p.plan_id], v)"/></td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>
      </div>
    </div>
  `,
};
