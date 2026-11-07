// MRR from ProfitWell, read through the Vintana relay (edge-scripts/assistant-relay.ts, /v1/profitwell), which holds
// the API token. ProfitWell is the source of truth for past months; later months are projected from each product
// line's planned growth rate.
//
// Plans are grouped into product lines and lines into families (Settings > Products). A plan without a line
// belongs to the built-in "Unassigned" line, id 0.
import { query, batch, getCredentials } from './db.js';
import { getBaseScenarioId, getSettings, updateSettings } from './schema.js';
import { currentMonth, addMonths, prevMonth, monthDiff, getReportingCurrency } from './utils.js';
import { getRate } from './bank.js';

export const UNASSIGNED_LINE = { id: 0, name: 'Unassigned', family_id: null, sort_order: 1e9 };
const DEFAULT_RELAY_URL = 'https://assistant.vintana.onetake.ai';
const PLAN_METRICS = ['recurring_revenue', 'active_customers', 'new_recurring_revenue', 'churned_recurring_revenue'];
const PLAN_LIMIT = 150; // ProfitWell returns at most this many plan ids
const TREND_MONTHS = 3;

// --- Relay -----------------------------------------------------------------------------------------------------

export class ProfitwellError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const MESSAGES = {
  NOT_CONFIGURED: 'The relay has no ProfitWell token. Add PROFITWELL_API_TOKEN to the relay secrets (Settings > Products).',
  UNAUTHORIZED: 'The relay does not recognise this database token. In Settings > Assistant, show the token fingerprint and add it to the relay secrets.',
  ORIGIN_NOT_ALLOWED: 'The relay does not accept requests from this address.',
  METHOD_NOT_ALLOWED: 'The relay does not have the ProfitWell route yet. Deploy the latest relay script.',
};

async function relayCall(relayUrl, body) {
  const { token } = getCredentials();
  const base = (relayUrl || DEFAULT_RELAY_URL).replace(/\/+$/, '');
  let resp;
  try {
    resp = await fetch(`${base}/v1/profitwell`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ProfitwellError('NETWORK', `Could not reach the relay at ${base}.`);
  }
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const code = data.error || 'HTTP';
    throw new ProfitwellError(code, (code === 'UPSTREAM' && data.message) || MESSAGES[code] || data.message || `The relay answered with HTTP ${resp.status}.`);
  }
  return data;
}

// Runs fn over items, `limit` at a time
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

// { metric: { 'YYYY-MM': value } } from ProfitWell's { data: { metric: [{date, value}] } }
const byMonth = data => Object.fromEntries(Object.entries(data?.data || {}).map(([metric, rows]) =>
  [metric, Object.fromEntries((rows || []).map(r => [r.date, Number(r.value) || 0]))]));

// --- Sync ------------------------------------------------------------------------------------------------------

// Reads every plan's full history from ProfitWell and replaces pw_mrr with it. Line assignments are kept.
// Returns { plans, months, note } where note is a warning for Settings, or null.
export async function syncProfitwell() {
  const settings = await getSettings();
  const relayUrl = settings?.assistant_relay_url;
  const reporting = settings?.currency || getReportingCurrency();
  const pwCurrency = settings?.profitwell_currency || reporting;

  const { plan_ids: planIds = [] } = await relayCall(relayUrl, { kind: 'plans' });
  const [total, ...perPlan] = await mapLimit([null, ...planIds], 4, planId =>
    relayCall(relayUrl, planId === null
      ? { kind: 'monthly', metrics: ['recurring_revenue'] }
      : { kind: 'monthly', plan_id: planId, metrics: PLAN_METRICS }).then(byMonth));

  // Amounts come in ProfitWell's account currency with two decimals; store reporting-currency cents
  const months = new Set();
  perPlan.forEach(m => Object.keys(m.recurring_revenue || {}).forEach(mo => months.add(mo)));
  const rates = {};
  if (pwCurrency !== reporting) {
    await Promise.all([...months].map(async mo => { rates[mo] = await getRate(mo, pwCurrency, reporting); }));
  }
  const cents = (value, month) => Math.round(value * 100 * (rates[month] ?? 1));

  const now = new Date().toISOString();
  const stmts = ['DELETE FROM pw_mrr'];
  planIds.forEach((planId, i) => {
    const m = perPlan[i];
    stmts.push({ sql: `INSERT INTO pw_plans (plan_id, last_seen_at) VALUES (?, ?)
                       ON CONFLICT(plan_id) DO UPDATE SET last_seen_at = excluded.last_seen_at`, args: [planId, now] });
    for (const [month, mrr] of Object.entries(m.recurring_revenue || {})) {
      const customers = Math.round(m.active_customers?.[month] || 0);
      const newMrr = m.new_recurring_revenue?.[month] || 0;
      const churned = m.churned_recurring_revenue?.[month] || 0;
      if (!mrr && !customers && !newMrr && !churned) continue;
      stmts.push({ sql: 'INSERT INTO pw_mrr (plan_id, month, mrr, customers, new_mrr, churned_mrr) VALUES (?, ?, ?, ?, ?, ?)',
        args: [planId, month, cents(mrr, month), customers, cents(newMrr, month), cents(Math.abs(churned), month)] });
    }
  });

  // Warnings shown in Settings: a truncated plan list, or plans that don't add up to the company total
  const notes = [];
  if (planIds.length >= PLAN_LIMIT) notes.push(`ProfitWell returned ${PLAN_LIMIT} plans, its maximum: some plans may be missing.`);
  const last = prevMonth(currentMonth());
  const companyTotal = total.recurring_revenue?.[last];
  if (companyTotal !== undefined) {
    const planSum = perPlan.reduce((s, m) => s + (m.recurring_revenue?.[last] || 0), 0);
    const gap = Math.round((companyTotal - planSum) * 100);
    if (Math.abs(gap) >= 100) notes.push(`For ${last}, the plans add up to ${planSum.toFixed(2)} ${pwCurrency} but ProfitWell's company MRR is ${companyTotal.toFixed(2)} ${pwCurrency}.`);
  }
  const note = notes.join(' ') || null;
  await batch(stmts);
  await updateSettings({ profitwell_last_sync: now, profitwell_sync_note: note });

  // ProfitWell replaces the hand-entered revenue: clear it after the first successful sync
  const cleared = await query("SELECT value FROM _meta WHERE key = 'manual_revenue_cleared'");
  if (!cleared.length) {
    await batch(['DELETE FROM revenue_values', 'DELETE FROM revenue_products',
      "INSERT OR REPLACE INTO _meta (key, value) VALUES ('manual_revenue_cleared', '1')"]).catch(() => {});
  }
  return { plans: planIds.length, months: months.size, note };
}

// True when no sync has run since the 1st of the current month
export function syncDue(settings) {
  const last = settings?.profitwell_last_sync;
  if (!last) return true;
  const d = new Date();
  return new Date(last) < new Date(d.getFullYear(), d.getMonth(), 1);
}

// --- Products: families, lines, plans -----------------------------------------------------------------------

export async function loadProducts() {
  try {
    const [families, lines, plans] = await Promise.all([
      query('SELECT * FROM product_families ORDER BY sort_order, name'),
      query('SELECT * FROM product_lines ORDER BY sort_order, name'),
      query('SELECT * FROM pw_plans ORDER BY plan_id'),
    ]);
    return { families, lines: [...lines, UNASSIGNED_LINE], plans };
  } catch {
    return { families: [], lines: [UNASSIGNED_LINE], plans: [] }; // tables not created yet
  }
}

// Growth rates (% per month) per line for a scenario; the scenario's own rows replace the base ones
export async function loadGrowthRates(scenarioId) {
  const baseId = await getBaseScenarioId();
  let rows = [];
  try {
    rows = await query('SELECT line_id, scenario_id, rate_pct FROM line_growth WHERE scenario_id IN (?, ?)', [scenarioId, baseId]);
  } catch { /* table not created yet */ }
  const rates = {};
  rows.filter(r => r.scenario_id === baseId).forEach(r => { rates[r.line_id] = r.rate_pct; });
  if (scenarioId !== baseId) rows.filter(r => r.scenario_id === scenarioId).forEach(r => { rates[r.line_id] = r.rate_pct; });
  return rates;
}

export async function saveGrowthRates(scenarioId, lineIds, ratePct) {
  await batch(lineIds.map(id => ({
    sql: 'INSERT OR REPLACE INTO line_growth (line_id, scenario_id, rate_pct) VALUES (?, ?, ?)',
    args: [id, scenarioId, ratePct],
  })));
}

// --- MRR series --------------------------------------------------------------------------------------------------

// The last month ProfitWell has in full: the month before the current one
export const lastActualMonth = () => prevMonth(currentMonth());

// MRR per product line and in total for every month in [from, to], in reporting-currency cents.
// Months up to lastActualMonth() come from ProfitWell; later ones grow each line's last actual MRR by its planned
// rate, compounded monthly. `trend` grows it by the line's average net growth over its last 3 actual months
// instead, for reference.
// Returns { months, lines: [{ line, family, values: {month: {mrr, customers}}, rate, trendRate, planned, trend }],
//           totals: {month: mrr}, trendTotals: {month: mrr}, isActual(month), lastActual }
export async function loadMrrSeries(scenarioId, from, to) {
  const lastActual = lastActualMonth();
  const [{ families, lines }, rates, rows] = await Promise.all([
    loadProducts(),
    loadGrowthRates(scenarioId),
    query(`SELECT p.line_id, m.month, SUM(m.mrr) AS mrr, SUM(m.customers) AS customers
           FROM pw_mrr m LEFT JOIN pw_plans p ON p.plan_id = m.plan_id
           WHERE m.month <= ? GROUP BY p.line_id, m.month`, [lastActual]).catch(() => []),
  ]);

  const months = [];
  for (let m = from; m <= to; m = addMonths(m, 1)) months.push(m);

  const actualByLine = {};
  rows.forEach(r => {
    const id = r.line_id ?? 0;
    (actualByLine[id] ||= {})[r.month] = { mrr: r.mrr || 0, customers: r.customers || 0 };
  });

  const familyById = Object.fromEntries(families.map(f => [f.id, f]));
  const out = lines.map(line => {
    const actual = actualByLine[line.id] || {};
    const base = actual[lastActual]?.mrr || 0;
    const rate = rates[line.id] ?? 0;
    // Average month-on-month net growth over the last TREND_MONTHS actual months
    const growths = [];
    for (let i = 0; i < TREND_MONTHS; i++) {
      const cur = actual[addMonths(lastActual, -i)]?.mrr || 0;
      const prev = actual[addMonths(lastActual, -i - 1)]?.mrr || 0;
      if (prev > 0) growths.push(cur / prev - 1);
    }
    const trendRate = growths.length ? growths.reduce((a, b) => a + b, 0) / growths.length * 100 : 0;
    const values = {}, planned = {}, trend = {};
    for (const m of months) {
      if (m <= lastActual) {
        values[m] = actual[m] || { mrr: 0, customers: 0 };
      } else {
        const n = monthDiff(lastActual, m);
        values[m] = { mrr: Math.round(base * Math.pow(1 + rate / 100, n)), customers: null };
        trend[m] = Math.round(base * Math.pow(1 + trendRate / 100, n));
      }
      planned[m] = values[m].mrr;
    }
    return { line, family: familyById[line.family_id] || null, values, rate, trendRate, planned, trend };
  });

  const totals = {}, trendTotals = {};
  for (const m of months) {
    totals[m] = out.reduce((s, l) => s + l.values[m].mrr, 0);
    trendTotals[m] = m <= lastActual ? totals[m] : out.reduce((s, l) => s + (l.trend[m] || 0), 0);
  }
  return { months, lines: out, families, totals, trendTotals, isActual: m => m <= lastActual, lastActual };
}

// Total MRR per month for [from, to]; the shape other pages need
export async function loadMrrTotals(scenarioId, from, to) {
  return (await loadMrrSeries(scenarioId, from, to)).totals;
}

// Runs a background sync on app load when one is due. Silent when the relay isn't set up for ProfitWell.
export async function autoSync(settings, toast) {
  if (!settings || !syncDue(settings)) return false;
  try {
    const r = await syncProfitwell();
    toast?.(`ProfitWell synced: ${r.plans} plans`, 'success');
    return true;
  } catch (e) {
    if (e.code !== 'NOT_CONFIGURED' && e.code !== 'METHOD_NOT_ALLOWED') toast?.('ProfitWell sync failed: ' + e.message, 'error');
    return false;
  }
}


// Chart.js datasets for a total MRR line: ProfitWell actuals solid, planned growth dashed, trend dotted. The two
// projections start from the last actual month so the lines join. Values are in currency units, not cents.
export function mrrChartDatasets(series) {
  const { months, totals, trendTotals, isActual, lastActual } = series;
  const joins = m => isActual(m) ? (m === lastActual ? totals[m] / 100 : null) : undefined;
  const pick = (src, m) => { const j = joins(m); return j === undefined ? src[m] / 100 : j; };
  const sets = [{
    label: 'MRR (ProfitWell)', data: months.map(m => isActual(m) ? totals[m] / 100 : null),
    borderColor: '#6366f1', backgroundColor: 'rgba(99,102,241,0.08)', fill: true, tension: 0.3, pointRadius: 2, borderWidth: 2,
  }];
  if (months.some(m => !isActual(m))) {
    sets.push({
      label: 'Planned', data: months.map(m => pick(totals, m)),
      borderColor: '#6366f1', borderDash: [6, 4], fill: false, tension: 0.3, pointRadius: 2, borderWidth: 2,
    }, {
      label: 'Trend', data: months.map(m => pick(trendTotals, m)),
      borderColor: '#9ca3af', borderDash: [2, 3], fill: false, tension: 0.3, pointRadius: 0, borderWidth: 1.5,
    });
  }
  return sets;
}
