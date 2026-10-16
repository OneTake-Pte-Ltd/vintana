export function formatCents(cents, currency = 'EUR') {
  if (cents === null || cents === undefined) cents = 0;
  const sign = cents < 0 ? -1 : 1;
  const abs = Math.abs(cents);
  const euros = (abs / 100).toFixed(2);
  const parts = euros.split('.');
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const symbol = currency === 'EUR' ? '€' : currency;
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

export function monthlyShare(chargeCents, recurrence) {
  return Math.round(chargeCents / (RECURRENCE_MONTHS[recurrence] || 1));
}

export function chargeFromMonthly(monthlyCents, recurrence) {
  return monthlyCents * (RECURRENCE_MONTHS[recurrence] || 1);
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

// True when a renewal falls in `month`: every month, every 3 months or every 12 months from the start month,
// and never outside the start/end months
export function isChargeMonth(recurrence, startMonth, month, endMonth = null) {
  const every = RECURRENCE_MONTHS[recurrence];
  if (!every) return false;
  if (endMonth && month > endMonth) return false;
  if (!startMonth || every === 1) return !startMonth || month >= startMonth;
  const diff = monthDiff(startMonth, month);
  return diff >= 0 && diff % every === 0;
}
