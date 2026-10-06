import { batch, execute, query } from './db.js';

const SCHEMA_VERSION = '1';

const DDL = [
  `CREATE TABLE IF NOT EXISTS _meta (
    key   TEXT PRIMARY KEY,
    value TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS settings (
    id                INTEGER PRIMARY KEY DEFAULT 1,
    company_name      TEXT NOT NULL DEFAULT 'My Company',
    currency          TEXT NOT NULL DEFAULT 'EUR',
    fiscal_year_start INTEGER NOT NULL DEFAULT 1,
    actuals_through   TEXT,
    dept_mapping      TEXT DEFAULT '{}',
    created_at        TEXT DEFAULT (datetime('now')),
    updated_at        TEXT DEFAULT (datetime('now'))
  )`,

  `CREATE TABLE IF NOT EXISTS scenarios (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE,
    description TEXT,
    is_base     INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT DEFAULT (datetime('now'))
  )`,

  `CREATE TABLE IF NOT EXISTS expense_categories (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    sort_order INTEGER NOT NULL DEFAULT 0
  )`,

  `CREATE TABLE IF NOT EXISTS expense_items (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL,
    alias         TEXT UNIQUE,
    company       TEXT,
    charge_label  TEXT,
    category_id   INTEGER NOT NULL REFERENCES expense_categories(id),
    formula       TEXT,
    recurrence    TEXT NOT NULL DEFAULT 'monthly',
    renewal_day   INTEGER,
    start_month   TEXT,
    end_month     TEXT,
    notes         TEXT,
    visible       INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT DEFAULT (datetime('now'))
  )`,

  `CREATE TABLE IF NOT EXISTS expense_values (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    expense_item_id INTEGER NOT NULL REFERENCES expense_items(id) ON DELETE CASCADE,
    scenario_id     INTEGER NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
    month           TEXT NOT NULL,
    amount          INTEGER NOT NULL,
    is_actual       INTEGER NOT NULL DEFAULT 0,
    UNIQUE(expense_item_id, scenario_id, month)
  )`,

  `CREATE TABLE IF NOT EXISTS revenue_products (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    name  TEXT NOT NULL UNIQUE,
    alias TEXT UNIQUE,
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`,

  `CREATE TABLE IF NOT EXISTS revenue_values (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id   INTEGER NOT NULL REFERENCES revenue_products(id) ON DELETE CASCADE,
    scenario_id  INTEGER NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
    month        TEXT NOT NULL,
    customers    INTEGER NOT NULL DEFAULT 0,
    arpu         INTEGER NOT NULL DEFAULT 0,
    is_actual    INTEGER NOT NULL DEFAULT 0,
    UNIQUE(product_id, scenario_id, month)
  )`,

  `CREATE TABLE IF NOT EXISTS employees (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT NOT NULL,
    role            TEXT,
    department      TEXT,
    salary_monthly  INTEGER NOT NULL,
    tax_pct         REAL NOT NULL DEFAULT 0,
    start_date      TEXT NOT NULL,
    end_date        TEXT,
    notes           TEXT,
    created_at      TEXT DEFAULT (datetime('now'))
  )`,

  `CREATE TABLE IF NOT EXISTS employee_overrides (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id     INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    scenario_id     INTEGER NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
    salary_monthly  INTEGER,
    tax_pct         REAL,
    start_date      TEXT,
    end_date        TEXT,
    UNIQUE(employee_id, scenario_id)
  )`,

  `CREATE TABLE IF NOT EXISTS scenario_employees (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    scenario_id     INTEGER NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    role            TEXT,
    department      TEXT,
    salary_monthly  INTEGER NOT NULL,
    tax_pct         REAL NOT NULL DEFAULT 0,
    start_date      TEXT NOT NULL,
    end_date        TEXT,
    notes           TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS cash_actuals (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    month   TEXT NOT NULL UNIQUE,
    balance INTEGER NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS funding_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    month       TEXT NOT NULL,
    amount      INTEGER NOT NULL,
    scenario_id INTEGER NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
    notes       TEXT
  )`,
];

const SEED = [
  `INSERT OR IGNORE INTO settings (id, company_name) VALUES (1, 'My Company')`,
  `INSERT OR IGNORE INTO scenarios (name, is_base) VALUES ('Base', 1)`,
  `INSERT OR IGNORE INTO expense_categories (name, sort_order) VALUES ('Cost of Goods Sold (COGS)', 1)`,
  `INSERT OR IGNORE INTO expense_categories (name, sort_order) VALUES ('Research & Development', 2)`,
  `INSERT OR IGNORE INTO expense_categories (name, sort_order) VALUES ('Sales & Marketing', 3)`,
  `INSERT OR IGNORE INTO expense_categories (name, sort_order) VALUES ('General & Administrative', 4)`,
  `INSERT OR IGNORE INTO expense_categories (name, sort_order) VALUES ('Uncategorized / Other', 5)`,
];

export async function checkSchema() {
  try {
    const result = await query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='_meta'"
    );
    if (result.length === 0) return false;
    const meta = await query("SELECT value FROM _meta WHERE key='schema_version'");
    return meta.length > 0 && meta[0].value === SCHEMA_VERSION;
  } catch {
    return false;
  }
}

export async function runMigrations() {
  const statements = [
    ...DDL,
    ...SEED,
    { sql: `INSERT OR REPLACE INTO _meta (key, value) VALUES ('schema_version', ?)`, args: [SCHEMA_VERSION] },
  ];
  await batch(statements);
}

export async function resetAllData() {
  const tables = [
    'funding_events', 'cash_actuals', 'scenario_employees',
    'employee_overrides', 'employees', 'revenue_values',
    'revenue_products', 'expense_values', 'expense_items',
    'expense_categories', 'scenarios', 'settings', '_meta',
  ];
  await batch(tables.map(t => `DROP TABLE IF EXISTS ${t}`));
  await runMigrations();
}

export async function getSettings() {
  const rows = await query('SELECT * FROM settings WHERE id = 1');
  if (rows.length === 0) return null;
  const s = rows[0];
  try { s.dept_mapping = JSON.parse(s.dept_mapping || '{}'); } catch { s.dept_mapping = {}; }
  return s;
}

export async function updateSettings(fields) {
  const allowed = ['company_name', 'currency', 'fiscal_year_start', 'actuals_through', 'dept_mapping'];
  const sets = [];
  const args = [];
  for (const key of allowed) {
    if (key in fields) {
      sets.push(`${key} = ?`);
      args.push(key === 'dept_mapping' ? JSON.stringify(fields[key]) : fields[key]);
    }
  }
  if (sets.length === 0) return;
  sets.push("updated_at = datetime('now')");
  await execute(`UPDATE settings SET ${sets.join(', ')} WHERE id = 1`, args);
}

export async function getBaseScenarioId() {
  const rows = await query('SELECT id FROM scenarios WHERE is_base = 1 LIMIT 1');
  return rows.length > 0 ? rows[0].id : 1;
}
