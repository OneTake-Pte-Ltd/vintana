// Runway history: the base scenario's runway in days, one figure per day, kept for the homepage chart.
// Vintana has no server of its own, so the figure is recorded when someone opens it: the homepage records the latest
// figure of the day while it shows the base scenario, and loading the app records one if the day has none yet.
import { query, execute } from './db.js';
import { getBaseScenarioId } from './schema.js';
import { cashPosition } from './bank.js';
import { loadMrrSeries } from './profitwell.js';
import { loadScenarioEmployees, employeeCost, isEmployedIn } from './payroll.js';
import { loadRunway } from './charges.js';
import { currentMonth } from './utils.js';

const DAYS_PER_MONTH = 365.25 / 12;

// Today in the browser's time zone, as YYYY-MM-DD
export function today(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

// A runway (charges.js computeRunway) in days. null when the company isn't burning cash; undefined when it can't be
// known (no cash balance), so nothing is recorded.
export function runwayInDays(r) {
  if (!r || r.unit === 'none') return undefined;
  if (r.unit === 'positive') return null;
  if (r.unit === 'days') return r.value;
  return Math.round(r.months * DAYS_PER_MONTH);
}

// Records the runway as today's figure, replacing an earlier one of the same day
export async function saveRunwayDay(r, now = new Date()) {
  const days = runwayInDays(r);
  if (days === undefined) return;
  await execute('INSERT OR REPLACE INTO runway_history (day, days, recorded_at) VALUES (?, ?, datetime(\'now\'))', [today(now), days]);
}

// [{ day, days }] from `fromDay` (YYYY-MM-DD) on, oldest first
export async function loadRunwayHistory(fromDay) {
  return query('SELECT day, days FROM runway_history WHERE day >= ? ORDER BY day', [fromDay]);
}

// The base scenario's runway, computed as on the homepage: today's cash (cached live balances, else the latest
// month-end balances) against this month's burn (expenses and payroll minus MRR)
async function baseRunway(settings) {
  const sid = await getBaseScenarioId();
  const month = currentMonth();
  const [cash, expenses, { employees }, mrr] = await Promise.all([
    cashPosition().catch(() => null),
    query('SELECT COALESCE(SUM(amount), 0) AS v FROM expense_values WHERE scenario_id = ? AND month = ?', [sid, month]),
    loadScenarioEmployees(sid),
    loadMrrSeries(sid, month, month),
  ]);
  if (!cash) return { unit: 'none' };
  const payroll = employees.filter(e => isEmployedIn(e, month)).reduce((s, e) => s + employeeCost(e), 0);
  const burn = (expenses[0]?.v || 0) + payroll - (mrr.totals[month] || 0);
  return loadRunway(sid, cash.total, burn, settings);
}

// Records today's figure when the day has none yet. Runs in the background when the app loads.
export async function recordRunwayIfMissing(settings) {
  const seen = await query('SELECT 1 FROM runway_history WHERE day = ?', [today()]);
  if (seen.length) return;
  await saveRunwayDay(await baseRunway(settings));
}
