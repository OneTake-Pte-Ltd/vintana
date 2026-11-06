const DB_URL_KEY = 'bdb_url';
const DB_TOKEN_KEY = 'bdb_token';

let _url = '';
let _token = '';

// Reads run in parallel. A write waits for everything sent before it, and anything sent after a write waits for
// it, so callers always see their own changes in the order they made them.
let _lastWrite = Promise.resolve();
const _inFlight = new Set();
const settle = p => p.then(() => {}, () => {});

const READ_SQL = /^\s*(SELECT|PRAGMA\s+table_info)\b/i;
const isRead = stmt => READ_SQL.test(typeof stmt === 'string' ? stmt : stmt.sql);

function schedule(read, run) {
  const after = read ? _lastWrite : Promise.all([_lastWrite, ..._inFlight]);
  const p = after.then(run);
  const done = settle(p);
  if (read) {
    _inFlight.add(done);
    done.then(() => _inFlight.delete(done));
  } else {
    _lastWrite = done;
  }
  return p;
}

// Browsers can't fetch libsql:// or ws(s):// URLs; the same host serves HTTP on https://
export function normalizeUrl(url) {
  const host = url.trim().replace(/^(libsql|wss|https?|ws):\/\//i, '').replace(/\/+$/, '');
  return host ? `https://${host}` : '';
}

export function getCredentials() {
  if (!_url || !_token) {
    _url = normalizeUrl(localStorage.getItem(DB_URL_KEY) || '');
    _token = localStorage.getItem(DB_TOKEN_KEY) || '';
  }
  return { url: _url, token: _token };
}

export function setCredentials(url, token) {
  _url = normalizeUrl(url);
  _token = token;
  localStorage.setItem(DB_URL_KEY, _url);
  localStorage.setItem(DB_TOKEN_KEY, _token);
}

export function clearCredentials() {
  _url = '';
  _token = '';
  localStorage.removeItem(DB_URL_KEY);
  localStorage.removeItem(DB_TOKEN_KEY);
}

export function hasCredentials() {
  const { url, token } = getCredentials();
  return !!(url && token);
}

function serializeArg(val) {
  if (val === null || val === undefined) return { type: 'null' };
  if (typeof val === 'number') {
    if (Number.isInteger(val)) return { type: 'integer', value: String(val) };
    return { type: 'float', value: val };
  }
  return { type: 'text', value: String(val) };
}

function parseResponse(result) {
  if (!result || result.type === 'error') {
    const msg = result?.error?.message || 'Unknown database error';
    throw new Error(msg);
  }
  const resp = result.response;
  if (resp.type === 'error') {
    throw new Error(resp.error?.message || 'Query error');
  }
  const r = resp.result;
  const cols = (r.cols || []).map(c => c.name);
  const rows = (r.rows || []).map(row =>
    row.map(cell => {
      if (!cell || cell.type === 'null') return null;
      if (cell.type === 'integer') return parseInt(cell.value, 10);
      if (cell.type === 'float') return cell.value;
      return cell.value;
    })
  );
  const lastInsertRowid = r.last_insert_rowid != null ? parseInt(r.last_insert_rowid, 10) : null;
  return { cols, rows, affectedRowCount: r.affected_row_count || 0, lastInsertRowid };
}

async function rawPipeline(requests) {
  const { url, token } = getCredentials();
  if (!url || !token) throw new Error('Not connected to database');
  const resp = await fetch(`${url}/v2/pipeline`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ requests }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Database HTTP ${resp.status}: ${text}`);
  }
  return resp.json();
}

export async function execute(sql, args = []) {
  return schedule(isRead(sql), async () => {
    const data = await rawPipeline([
      { type: 'execute', stmt: { sql, args: args.map(serializeArg) } },
      { type: 'close' },
    ]);
    return parseResponse(data.results[0]);
  });
}

export async function batch(statements) {
  return schedule(statements.every(isRead), async () => {
    const requests = statements.map(stmt => {
      if (typeof stmt === 'string') {
        return { type: 'execute', stmt: { sql: stmt, args: [] } };
      }
      return {
        type: 'execute',
        stmt: {
          sql: stmt.sql,
          args: (stmt.args || []).map(serializeArg),
        },
      };
    });
    requests.push({ type: 'close' });
    const data = await rawPipeline(requests);
    return data.results
      .filter(r => r.response?.type !== 'close')
      .map(parseResponse);
  });
}

export async function testConnection() {
  const result = await execute('SELECT 1');
  return result.rows.length > 0;
}

export function rowsToObjects(cols, rows) {
  return rows.map(row => {
    const obj = {};
    cols.forEach((col, i) => { obj[col] = row[i]; });
    return obj;
  });
}

export async function query(sql, args = []) {
  const { cols, rows } = await execute(sql, args);
  return rowsToObjects(cols, rows);
}
