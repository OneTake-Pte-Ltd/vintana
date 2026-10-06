const DB_URL_KEY = 'bdb_url';
const DB_TOKEN_KEY = 'bdb_token';

let _url = '';
let _token = '';
let _queue = Promise.resolve();

export function getCredentials() {
  if (!_url || !_token) {
    _url = localStorage.getItem(DB_URL_KEY) || '';
    _token = localStorage.getItem(DB_TOKEN_KEY) || '';
  }
  return { url: _url, token: _token };
}

export function setCredentials(url, token) {
  _url = url.replace(/\/+$/, '');
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
  return { cols, rows, affectedRowCount: r.affected_row_count || 0 };
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
  return new Promise((resolve, reject) => {
    _queue = _queue.then(async () => {
      try {
        const data = await rawPipeline([
          {
            type: 'execute',
            stmt: {
              sql,
              args: args.map(serializeArg),
            },
          },
          { type: 'close' },
        ]);
        resolve(parseResponse(data.results[0]));
      } catch (e) {
        reject(e);
      }
    });
  });
}

export async function batch(statements) {
  return new Promise((resolve, reject) => {
    _queue = _queue.then(async () => {
      try {
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
        const results = data.results
          .filter(r => r.type !== 'close')
          .map(parseResponse);
        resolve(results);
      } catch (e) {
        reject(e);
      }
    });
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
