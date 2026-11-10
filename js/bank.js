// Bank accounts, month-end balances and exchange rates.
// Total cash is always the sum of the accounts' balances, converted into the reporting currency at the
// month-end rate.
import { query, batch } from './db.js';
import { getReportingCurrency, currentMonth } from './utils.js';
import { cachedLiveBalances, matchLiveBalances } from './liveBalances.js';

const FX_URL = 'https://api.frankfurter.dev/v1/';

export async function loadAccounts() {
  try {
    return await query('SELECT * FROM bank_accounts ORDER BY sort_order, id');
  } catch {
    return []; // not set up on this database yet
  }
}

export const accountLabel = a => a ? (a.label ? `${a.label} (${a.bank_name})` : a.bank_name) : '';

const pad = n => String(n).padStart(2, '0');
const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
export function monthEnd(month) {
  const [y, m] = month.split('-').map(Number);
  return `${month}-${pad(new Date(y, m, 0).getDate())}`;
}

export class FxError extends Error {}

// Rate at the end of `month`: 1 `base` = rate `quote`. A finished month's rate is saved in the database, so it
// is fetched once; the current month uses the latest published rate and is fetched again next time.
// The European Central Bank publishes on working days; for a weekend or holiday, Frankfurter returns the last
// rate before it.
// Each rate is looked up once per page load. The first lookup into a currency reads every saved rate into it in
// a single request; only rates missing from the database go to Frankfurter, and those requests run in parallel.
const memo = new Map();
const saved = new Map(); // quote currency -> Promise of { "month:base": rate }

function savedRates(quote) {
  if (!saved.has(quote)) {
    saved.set(quote, query('SELECT month, base, rate FROM fx_rates WHERE quote = ?', [quote])
      .then(rows => Object.fromEntries(rows.map(r => [`${r.month}:${r.base}`, r.rate])))
      .catch(() => ({}))); // table missing: fetch without caching
  }
  return saved.get(quote);
}

export function getRate(month, base, quote = getReportingCurrency()) {
  if (!base || !quote || base === quote) return Promise.resolve(1);
  const key = `${month}:${base}:${quote}`;
  if (!memo.has(key)) {
    const p = lookupRate(month, base, quote);
    memo.set(key, p);
    p.catch(() => memo.delete(key)); // a failed lookup is tried again next time
  }
  return memo.get(key);
}

async function lookupRate(month, base, quote) {
  const known = (await savedRates(quote))[`${month}:${base}`];
  if (typeof known === 'number') return known;

  const end = monthEnd(month);
  const finished = end < todayIso();
  let data;
  try {
    const resp = await fetch(`${FX_URL}${finished ? end : 'latest'}?base=${encodeURIComponent(base)}&symbols=${encodeURIComponent(quote)}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    data = await resp.json();
  } catch (e) {
    throw new FxError(`Could not get the ${base} to ${quote} exchange rate for ${month} (${e.message}). Check your connection and try again.`);
  }
  const rate = data?.rates?.[quote];
  if (typeof rate !== 'number') {
    throw new FxError(`No ${base} to ${quote} exchange rate is published for ${month}. The European Central Bank does not cover every currency.`);
  }
  if (finished) saveRate([month, base, quote, rate, data.date || end]);
  return rate;
}

// New rates are saved together in one request, in the background
const unsaved = [];
let saveTimer = null;
function saveRate(args) {
  unsaved.push(args);
  saveTimer ||= setTimeout(async () => {
    saveTimer = null;
    const rows = unsaved.splice(0);
    try {
      await batch(rows.map(r => ({ sql: 'INSERT OR REPLACE INTO fx_rates (month, base, quote, rate, rate_date) VALUES (?, ?, ?, ?, ?)', args: r })));
    } catch { /* read-only token: keep them for this session only */ }
  }, 50);
}

export const convert = (cents, rate) => Math.round(cents * rate);

// Month-end balances: { [month]: { [accountId]: cents in the account currency } }
export async function loadBalances() {
  try {
    const rows = await query('SELECT account_id, month, balance, source FROM bank_balances ORDER BY month');
    const out = {};
    rows.forEach(r => { (out[r.month] ||= {})[r.account_id] = r.balance; });
    return out;
  } catch {
    return {};
  }
}

// Total cash for each month that has at least one balance, in the reporting currency.
// complete: every account has a balance for that month. Unconvertible balances are skipped and reported.
export async function cashTotals(accounts, balances) {
  const entries = Object.entries(balances);
  const results = await Promise.all(entries.map(([month, byAccount]) => Promise.all(accounts.map(a =>
    a.id in byAccount
      ? getRate(month, a.currency).then(rate => ({ cents: convert(byAccount[a.id], rate) }), e => ({ error: e.message }))
      : { missing: true }))));
  const totals = {};
  entries.forEach(([month], i) => {
    const list = results[i];
    totals[month] = {
      total: list.reduce((s, r) => s + (r.cents || 0), 0),
      complete: list.every(r => 'cents' in r),
      errors: list.filter(r => r.error).map(r => r.error),
    };
  });
  return totals;
}

// Current cash position: each account's live balance (Wise, Airwallex; cached, see liveBalances.js) converted at the
// current rate, unless a statement gives a more recent month-end balance; otherwise its latest statement balance,
// converted at that balance's month-end rate.
// Returns { total, month (latest statement month used), perAccount, complete, liveCount, liveAt (oldest live fetch) }.
export async function cashPosition() {
  const [accounts, balances, liveRows] = await Promise.all([loadAccounts(), loadBalances(), cachedLiveBalances()]);
  const months = Object.keys(balances).sort().reverse();
  const live = matchLiveBalances(accounts, liveRows);
  if (!accounts.length || (!months.length && !Object.keys(live).length)) return null;
  const perAccount = await Promise.all(accounts.map(async a => {
    const month = months.find(m => a.id in balances[m]);
    const b = live[a.id];
    if (b && (!month || monthEnd(month) < b.fetched_at.slice(0, 10))) {
      const rate = await getRate(currentMonth(), b.currency).catch(() => null);
      return { account: a, month: null, balance: b.amount, converted: rate === null ? null : convert(b.amount, rate),
        live: true, source: b.source, fetchedAt: b.fetched_at };
    }
    if (!month) return { account: a, month: null, balance: null };
    const rate = await getRate(month, a.currency).catch(() => null);
    const converted = rate === null ? null : convert(balances[month][a.id], rate);
    return { account: a, month, balance: balances[month][a.id], converted };
  }));
  const total = perAccount.reduce((s, p) => s + (p.converted || 0), 0);
  const latestMonth = perAccount.reduce((m, p) => (p.month && (!m || p.month > m) ? p.month : m), null);
  const liveOnes = perAccount.filter(p => p.live);
  return {
    total, month: latestMonth, perAccount,
    complete: perAccount.every(p => (p.live || p.month === latestMonth) && p.converted !== null),
    liveCount: liveOnes.length,
    liveAt: liveOnes.reduce((t, p) => (!t || p.fetchedAt < t ? p.fetchedAt : t), null),
  };
}

// One line saying where the cash figure comes from, e.g. "Live: Wise, Airwallex · 10 Nov 15:20 · others: Oct 2026 statements"
export function cashSourceText(position) {
  if (!position) return '';
  const parts = [];
  if (position.liveCount) {
    const names = [...new Set(position.perAccount.filter(p => p.live).map(p => p.source === 'wise' ? 'Wise' : 'Airwallex'))];
    const at = new Date(position.liveAt);
    parts.push(`Live: ${names.join(', ')} · ${at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} ${at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`);
  }
  if (position.month) {
    const label = new Date(position.month + '-01T00:00:00').toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
    parts.push(`${position.liveCount ? 'others' : 'from'}: end of ${label} statements`);
  }
  return parts.join(' · ');
}
