// Minimal CSV reader/writer: quoted fields, embedded commas/newlines, Excel BOM, and
// semicolon-separated files (Excel's default in locales that use a decimal comma).

export function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const firstLine = text.split(/\r?\n/, 1)[0];
  const delimiter = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ';' : ',';

  const records = [];
  let record = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === delimiter) {
      record.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      record.push(field); field = '';
      records.push(record); record = [];
    } else {
      field += c;
    }
  }
  if (field !== '' || record.length) { record.push(field); records.push(record); }

  const nonEmpty = records.filter(r => r.some(v => v.trim() !== ''));
  if (nonEmpty.length === 0) return { headers: [], rows: [] };
  const headers = nonEmpty[0].map(h => h.trim().toLowerCase().replace(/[\s-]+/g, '_'));
  const rows = nonEmpty.slice(1).map(r => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = (r[i] ?? '').trim(); });
    return obj;
  });
  return { headers, rows };
}

function escapeField(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(headers, rows) {
  const lines = [headers.join(',')];
  for (const row of rows) lines.push(headers.map(h => escapeField(row[h])).join(','));
  return lines.join('\r\n') + '\r\n';
}

export function downloadCsv(filename, content) {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// "1,440.50", "1 440,50", "1440" → cents; returns NaN when not a number
export function parseAmountToCents(raw) {
  let s = String(raw).replace(/[\s ']/g, '').replace(/[^\d.,-]/g, '');
  if (s === '') return NaN;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma > -1 && lastDot > -1) {
    // Whichever separator comes last is the decimal one
    s = lastComma > lastDot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (lastComma > -1) {
    // A lone comma followed by exactly 3 digits is a thousands separator ("1,440"); otherwise decimal ("12,50")
    s = /,\d{3}$/.test(s) && s.indexOf(',') === lastComma ? s.replace(',', '') : s.replace(',', '.');
  }
  if (!/^-?\d+(\.\d+)?$/.test(s)) return NaN;
  return Math.round(parseFloat(s) * 100);
}

// "2025-01", "2025-01-15", "2025/1", "01/2025" → "2025-01"; returns null when not a month
export function parseMonth(raw) {
  const s = String(raw).trim();
  let m = s.match(/^(\d{4})[-/.](\d{1,2})(?:[-/.]\d{1,2})?$/);
  if (m) return validMonth(m[1], m[2]);
  m = s.match(/^(\d{1,2})[-/.](\d{4})$/);
  if (m) return validMonth(m[2], m[1]);
  return null;
}

function validMonth(y, mo) {
  const n = parseInt(mo, 10);
  return n >= 1 && n <= 12 ? `${y}-${String(n).padStart(2, '0')}` : null;
}
