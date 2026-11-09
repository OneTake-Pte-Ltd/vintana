// Currencies the exchange-rate source (European Central Bank, via Frankfurter) publishes
export const CURRENCIES = ['AUD', 'BGN', 'BRL', 'CAD', 'CHF', 'CNY', 'CZK', 'DKK', 'EUR', 'GBP', 'HKD', 'HUF', 'IDR',
  'ILS', 'INR', 'ISK', 'JPY', 'KRW', 'MXN', 'MYR', 'NOK', 'NZD', 'PHP', 'PLN', 'RON', 'SEK', 'SGD', 'THB', 'TRY',
  'USD', 'ZAR'];
const SYMBOLS = { EUR: '€', USD: '$', GBP: '£', SGD: 'S$', AUD: 'A$', CAD: 'C$', HKD: 'HK$', NZD: 'NZ$', JPY: '¥', CNY: 'CN¥', INR: '₹' };
export const currencySymbol = code => SYMBOLS[code] || code;

// The reporting currency (Settings). Reactive, so amounts re-render when it changes.
const reportingCurrency = Vue.ref('EUR');
export const setReportingCurrency = code => { reportingCurrency.value = code || 'EUR'; };
export const getReportingCurrency = () => reportingCurrency.value;

export function formatCents(cents, currency = reportingCurrency.value) {
  if (cents === null || cents === undefined) cents = 0;
  const sign = cents < 0 ? -1 : 1;
  const abs = Math.abs(cents);
  const euros = (abs / 100).toFixed(2);
  const parts = euros.split('.');
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const symbol = currencySymbol(currency);
  const formatted = `${symbol} ${parts.join('.')}`;
  if (sign < 0) return `(${formatted})`;
  return formatted;
}

export function formatPct(value, decimals = 1) {
  if (value === null || value === undefined || isNaN(value)) return '—';
  return `${value.toFixed(decimals)}%`;
}

export function formatDelta(current, previous) {
  if (!previous || previous === 0) return { abs: current || 0, pct: null };
  const abs = (current || 0) - previous;
  const pct = (abs / Math.abs(previous)) * 100;
  return { abs, pct };
}

export function monthLabel(yyyymm) {
  const [y, m] = yyyymm.split('-').map(Number);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[m - 1]} '${String(y).slice(2)}`;
}

export function monthLabelFull(yyyymm) {
  const [y, m] = yyyymm.split('-').map(Number);
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return `${months[m - 1]} ${y}`;
}

export function generateMonthRange(start, end) {
  const months = [];
  let [sy, sm] = start.split('-').map(Number);
  const [ey, em] = end.split('-').map(Number);
  while (sy < ey || (sy === ey && sm <= em)) {
    months.push(`${sy}-${String(sm).padStart(2, '0')}`);
    sm++;
    if (sm > 12) { sm = 1; sy++; }
  }
  return months;
}

export function currentMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function prevMonth(yyyymm) {
  let [y, m] = yyyymm.split('-').map(Number);
  m--;
  if (m < 1) { m = 12; y--; }
  return `${y}-${String(m).padStart(2, '0')}`;
}

export function nextMonth(yyyymm) {
  let [y, m] = yyyymm.split('-').map(Number);
  m++;
  if (m > 12) { m = 1; y++; }
  return `${y}-${String(m).padStart(2, '0')}`;
}

export function addMonths(yyyymm, n) {
  let [y, m] = yyyymm.split('-').map(Number);
  m += n;
  while (m > 12) { m -= 12; y++; }
  while (m < 1) { m += 12; y--; }
  return `${y}-${String(m).padStart(2, '0')}`;
}

export function monthDiff(a, b) {
  const [ay, am] = a.split('-').map(Number);
  const [by, bm] = b.split('-').map(Number);
  return (by - ay) * 12 + (bm - am);
}

export function ordinalDay(d) {
  if (!d) return '';
  const s = ['th', 'st', 'nd', 'rd'];
  const v = d % 100;
  return d + (s[(v - 20) % 10] || s[v] || s[0]);
}

export function debounce(fn, ms = 300) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export function departmentToKey(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

// Number of months one charge covers; quarterly and annual charges are spread evenly over them
export const RECURRENCE_MONTHS = { monthly: 1, quarterly: 3, annual: 12 };

// Weekly charges: 52 a year, so a month holds 52/12 of them on average. The monthly value of a weekly expense is
// that average; a month actually has 4 or 5 charge dates (see weeklyChargeDates).
export const WEEKS_PER_MONTH = 52 / 12;

export function monthlyShare(chargeCents, recurrence) {
  if (recurrence === 'weekly') return Math.round(chargeCents * WEEKS_PER_MONTH);
  return Math.round(chargeCents / (RECURRENCE_MONTHS[recurrence] || 1));
}

export function chargeFromMonthly(monthlyCents, recurrence) {
  if (recurrence === 'weekly') return Math.round(monthlyCents / WEEKS_PER_MONTH);
  return monthlyCents * (RECURRENCE_MONTHS[recurrence] || 1);
}

const isoDate = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// Date of the charge that anchors a weekly expense: its start month and renewal day, or null when either is missing
export function weeklyAnchor(item) {
  if (!item.start_month || !item.renewal_day) return null;
  const [y, m] = item.start_month.split('-').map(Number);
  return new Date(y, m - 1, Math.min(item.renewal_day, new Date(y, m, 0).getDate()));
}

// Charge dates of a weekly expense between `from` and `to` (Dates, inclusive): the anchor date (its first charge)
// and every 7 days after it
export function weeklyChargeDates(anchor, from, to) {
  if (!anchor) return [];
  const DAY = 864e5;
  const day = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const start = day > anchor ? day : anchor;
  const offset = Math.round((start - anchor) / DAY);
  let d = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() + Math.ceil(offset / 7) * 7);
  const out = [];
  while (d <= to) {
    out.push(d);
    d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 7);
  }
  return out;
}

// Charge dates of a weekly expense in a month (YYYY-MM), as ISO dates
export function weeklyChargeDatesIn(anchor, month) {
  const [y, m] = month.split('-').map(Number);
  return weeklyChargeDates(anchor, new Date(y, m - 1, 1), new Date(y, m, 0)).map(isoDate);
}

// Forecast horizon for expenses without an end month: the visible range or two years out, whichever is later
export function forecastEnd(rangeEnd) {
  const twoYears = addMonths(currentMonth(), 24);
  return rangeEnd && rangeEnd > twoYears ? rangeEnd : twoYears;
}

// Monthly values (in cents) for an expense charged `chargeCents` on the given recurrence
export function expenseMonthlyValues(chargeCents, recurrence, startMonth, endMonth) {
  if (recurrence === 'one_time') return [{ month: startMonth, amount: chargeCents }];
  const amount = monthlyShare(chargeCents, recurrence);
  return generateMonthRange(startMonth, endMonth).map(month => ({ month, amount }));
}

// True when a renewal falls in `month`: every month (monthly and weekly), every 3 months or every 12 months
// from the start month
export function isChargeMonth(recurrence, startMonth, month) {
  if (recurrence === 'weekly') return true;
  const every = RECURRENCE_MONTHS[recurrence];
  if (!every) return false;
  if (!startMonth || every === 1) return true;
  const diff = monthDiff(startMonth, month);
  return diff >= 0 && diff % every === 0;
}
