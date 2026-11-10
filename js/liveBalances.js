// Live account balances from Wise and Airwallex, read through the Vintana relay (edge-scripts/assistant-relay.ts,
// /v1/balances), which holds the API keys. They are cached in live_balances for a day: pages that show cash call
// loadLiveBalances(), which refreshes the cache when it is older than that; cashPosition() reads the cache only.

import { query, batch, getCredentials } from './db.js';

const DEFAULT_RELAY_URL = 'https://assistant.vintana.onetake.ai';
export const LIVE_MAX_AGE_MS = 24 * 3600 * 1000;
const RETRY_AFTER_FAILURE_MS = 3600 * 1000; // a failed automatic refresh is not tried again for an hour
const ATTEMPT_KEY = 'vintana_live_balances_attempt';
export const LIVE_SOURCES = { wise: 'Wise', airwallex: 'Airwallex' };

const MESSAGES = {
  NOT_CONFIGURED: 'The relay has no Wise or Airwallex key. Add WISE_API_TOKEN, or AIRWALLEX_CLIENT_ID and AIRWALLEX_API_KEY, to the relay secrets.',
  UNAUTHORIZED: 'The relay does not recognise this database token. In Settings > Assistant, show the token fingerprint and add it to the relay secrets.',
  ORIGIN_NOT_ALLOWED: 'The relay does not accept requests from this address.',
  METHOD_NOT_ALLOWED: 'The relay does not have the balances route yet. Deploy the latest relay script.',
};

// Cached balances: [{ source, ref, currency, amount (cents), name, fetched_at (ISO) }]
export async function cachedLiveBalances() {
  try {
    return await query('SELECT source, ref, currency, amount, name, fetched_at FROM live_balances ORDER BY source, currency');
  } catch {
    return []; // table not created yet
  }
}

// Fetches balances from the relay and replaces the cache of each provider that answered.
// Returns { configured: { wise, airwallex }, errors: [{ source, message }] }. Throws when the relay itself refuses.
export async function refreshLiveBalances(settings) {
  const base = (settings?.assistant_relay_url || DEFAULT_RELAY_URL).replace(/\/+$/, '');
  let resp;
  try {
    resp = await fetch(`${base}/v1/balances`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${getCredentials().token}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
  } catch {
    throw new Error(`Could not reach the relay at ${base}.`);
  }
  if (!resp.ok) {
    let code = '', message = '';
    try { ({ error: code, message } = await resp.json()); } catch { /* not JSON */ }
    throw new Error(MESSAGES[code] || message || `The relay answered with HTTP ${resp.status}.`);
  }
  const data = await resp.json();
  const fetchedAt = data.fetched_at || new Date().toISOString();
  const stmts = [];
  const errors = [];
  for (const source of Object.keys(LIVE_SOURCES)) {
    const p = data[source];
    if (!p?.configured) { stmts.push({ sql: 'DELETE FROM live_balances WHERE source = ?', args: [source] }); continue; }
    if (p.error) { errors.push({ source, message: p.error }); continue; } // keep the last good balances
    stmts.push({ sql: 'DELETE FROM live_balances WHERE source = ?', args: [source] });
    for (const b of p.balances || []) {
      stmts.push({ sql: 'INSERT INTO live_balances (source, ref, currency, amount, name, fetched_at) VALUES (?,?,?,?,?,?)',
        args: [source, String(b.ref), String(b.currency).toUpperCase(), Math.round(Number(b.amount) * 100), b.name || null, fetchedAt] });
    }
  }
  await batch(stmts);
  return { configured: { wise: !!data.wise?.configured, airwallex: !!data.airwallex?.configured }, errors };
}

const lastAttempt = () => { try { return Number(localStorage.getItem(ATTEMPT_KEY)) || 0; } catch { return 0; } };
const setAttempt = v => { try { localStorage.setItem(ATTEMPT_KEY, String(v)); } catch { /* storage unavailable */ } };

// The cached balances, refreshed first when they are older than a day (or with force). A failed automatic refresh
// is retried after an hour, so a relay without keys isn't called on every page load.
// Returns { rows, error }: error is a message when the refresh failed (rows are then the previous cache).
export async function loadLiveBalances(settings, { force = false } = {}) {
  const rows = await cachedLiveBalances();
  const oldest = rows.reduce((t, r) => Math.min(t, Date.parse(r.fetched_at) || 0), Infinity);
  const stale = !rows.length || Date.now() - oldest > LIVE_MAX_AGE_MS;
  if (!force && (!stale || Date.now() - lastAttempt() < RETRY_AFTER_FAILURE_MS)) return { rows, error: null };
  try {
    const { errors } = await refreshLiveBalances(settings);
    setAttempt(errors.length ? Date.now() : 0);
    const fresh = await cachedLiveBalances();
    return { rows: fresh, error: errors.length ? errors.map(e => `${LIVE_SOURCES[e.source]}: ${e.message}`).join(' ') : null };
  } catch (e) {
    setAttempt(Date.now());
    return { rows, error: e.message };
  }
}

const key = b => `${b.source}:${b.ref}`;

// Live balance of each account: { [accountId]: balance row }. An account's live_source picks a balance ('none'
// turns it off); otherwise an account whose bank name contains "Wise" or "Airwallex" takes that provider's
// balance in its currency. A balance is used by one account only, explicit choices first.
export function matchLiveBalances(accounts, rows) {
  const out = {};
  const used = new Set();
  for (const a of accounts) {
    if (!a.live_source || a.live_source === 'none') continue;
    const b = rows.find(r => key(r) === a.live_source);
    if (b && !used.has(key(b))) { out[a.id] = b; used.add(key(b)); }
  }
  for (const a of accounts) {
    if (a.live_source) continue;
    const name = (a.bank_name || '').toLowerCase();
    const source = Object.keys(LIVE_SOURCES).find(s => name.includes(s));
    const b = source && rows.find(r => r.source === source && r.currency === a.currency && !used.has(key(r)));
    if (b) { out[a.id] = b; used.add(key(b)); }
  }
  return out;
}

export const liveBalanceLabel = b => `${LIVE_SOURCES[b.source]} ${b.currency}${b.name ? ' (' + b.name + ')' : ''}`;
