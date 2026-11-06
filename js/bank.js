// Bank accounts, month-end balances and exchange rates.
// Total cash is always the sum of the accounts' balances, converted into the reporting currency at the
// month-end rate.
import { query, execute } from './db.js';
import { getReportingCurrency } from './utils.js';

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
const memo = new Map();
export async function getRate(month, base, quote = getReportingCurrency()) {
  if (!base || !quote || base === quote) return 1;
  const key = `${month}:${base}:${quote}`;
  if (memo.has(key)) return memo.get(key);
  try {
    const rows = await query('SELECT rate FROM fx_rates WHERE month = ? AND base = ? AND quote = ?', [month, base, quote]);
    if (rows.length) { memo.set(key, rows[0].rate); return rows[0].rate; }
  } catch { /* table missing: fetch without caching */ }

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
  memo.set(key, rate);
  if (finished) {
    try {
      await execute('INSERT OR REPLACE INTO fx_rates (month, base, quote, rate, rate_date) VALUES (?, ?, ?, ?, ?)',
        [month, base, quote, rate, data.date || end]);
    } catch { /* read-only token: keep it for this session only */ }
  }
  return rate;
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
  const totals = {};
  for (const [month, byAccount] of Object.entries(balances)) {
    let total = 0, missing = 0;
    const errors = [];
    for (const a of accounts) {
      if (!(a.id in byAccount)) { missing++; continue; }
      try { total += convert(byAccount[a.id], await getRate(month, a.currency)); }
      catch (e) { errors.push(e.message); missing++; }
    }
    totals[month] = { total, complete: missing === 0, errors };
  }
  return totals;
}

// Current cash position: each account's latest balance, converted at that balance's month-end rate.
export async function cashPosition() {
  const accounts = await loadAccounts();
  const balances = await loadBalances();
  const months = Object.keys(balances).sort();
  if (!accounts.length || !months.length) return null;
  let total = 0, latestMonth = null;
  const perAccount = [];
  for (const a of accounts) {
    const month = [...months].reverse().find(m => a.id in balances[m]);
    if (!month) { perAccount.push({ account: a, month: null, balance: null }); continue; }
    const rate = await getRate(month, a.currency).catch(() => null);
    const converted = rate === null ? null : convert(balances[month][a.id], rate);
    if (converted !== null) total += converted;
    if (!latestMonth || month > latestMonth) latestMonth = month;
    perAccount.push({ account: a, month, balance: balances[month][a.id], converted });
  }
  return {
    total, month: latestMonth, perAccount,
    complete: perAccount.every(p => p.month === latestMonth && p.converted !== null),
  };
}
