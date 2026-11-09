import { batch, execute, query, getCredentials } from './db.js';

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
    assistant_relay_url TEXT DEFAULT 'https://assistant.vintana.onetake.ai',
    assistant_model   TEXT DEFAULT 'claude-opus-5-5',
    company_context   TEXT,
    payroll_pay_day   INTEGER,
    assistant_provider TEXT DEFAULT 'claude',
    assistant_openai_model TEXT,
    profitwell_currency TEXT,
    profitwell_last_sync TEXT,
    profitwell_sync_note TEXT,
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

  `CREATE TABLE IF NOT EXISTS expense_subcategories (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    category_id INTEGER NOT NULL REFERENCES expense_categories(id),
    name        TEXT NOT NULL,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    UNIQUE(category_id, name)
  )`,

  `CREATE TABLE IF NOT EXISTS expense_items (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL,
    alias         TEXT UNIQUE,
    company       TEXT,
    charge_label  TEXT,
    category_id   INTEGER NOT NULL REFERENCES expense_categories(id),
    subcategory_id INTEGER REFERENCES expense_subcategories(id),
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
    notes       TEXT,
    is_actual   INTEGER NOT NULL DEFAULT 0
  )`,

  // One account per bank. Balances are month-end, in the account's own currency.
  `CREATE TABLE IF NOT EXISTS bank_accounts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    bank_name  TEXT NOT NULL,
    label      TEXT,
    currency   TEXT NOT NULL DEFAULT 'EUR',
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  )`,

  `CREATE TABLE IF NOT EXISTS bank_balances (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL REFERENCES bank_accounts(id),
    month      TEXT NOT NULL,
    balance    INTEGER NOT NULL,
    source     TEXT NOT NULL DEFAULT 'manual',
    import_id  INTEGER,
    UNIQUE(account_id, month)
  )`,

  // One row per statement read. The PDF itself is never stored.
  `CREATE TABLE IF NOT EXISTS statement_imports (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id        INTEGER NOT NULL REFERENCES bank_accounts(id),
    file_name         TEXT,
    period_start      TEXT NOT NULL,
    period_end        TEXT NOT NULL,
    currency          TEXT,
    opening_balance   INTEGER,
    closing_balance   INTEGER,
    transaction_count INTEGER NOT NULL DEFAULT 0,
    discrepancies     TEXT DEFAULT '[]',
    read_by           TEXT,
    created_at        TEXT DEFAULT (datetime('now'))
  )`,

  // Statement lines. amount: account currency, signed (money in > 0); amount_reporting: converted at the month-end rate.
  `CREATE TABLE IF NOT EXISTS bank_transactions (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    import_id        INTEGER NOT NULL REFERENCES statement_imports(id),
    account_id       INTEGER NOT NULL REFERENCES bank_accounts(id),
    date             TEXT NOT NULL,
    month            TEXT NOT NULL,
    description      TEXT,
    counterparty     TEXT,
    amount           INTEGER NOT NULL,
    amount_reporting INTEGER NOT NULL,
    kind             TEXT NOT NULL,
    expense_item_id  INTEGER,
    employee_id      INTEGER,
    funding_event_id INTEGER
  )`,

  // Month-end exchange rates (European Central Bank, via Frankfurter): 1 base = rate quote
  `CREATE TABLE IF NOT EXISTS fx_rates (
    month     TEXT NOT NULL,
    base      TEXT NOT NULL,
    quote     TEXT NOT NULL,
    rate      REAL NOT NULL,
    rate_date TEXT,
    PRIMARY KEY (month, base, quote)
  )`,

  // Revenue comes from ProfitWell. Its plans are grouped into product lines, and lines into families, for display.
  // Plans without a line belong to the built-in "Unassigned" line (line id 0, not stored).
  `CREATE TABLE IF NOT EXISTS product_families (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL UNIQUE,
    sort_order INTEGER NOT NULL DEFAULT 0
  )`,

  `CREATE TABLE IF NOT EXISTS product_lines (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL UNIQUE,
    family_id  INTEGER REFERENCES product_families(id) ON DELETE SET NULL,
    sort_order INTEGER NOT NULL DEFAULT 0
  )`,

  // ProfitWell decides which plans exist; a sync adds new ones and keeps the line each one was given
  `CREATE TABLE IF NOT EXISTS pw_plans (
    plan_id      TEXT PRIMARY KEY,
    line_id      INTEGER REFERENCES product_lines(id) ON DELETE SET NULL,
    last_seen_at TEXT
  )`,

  // ProfitWell's monthly figures per plan, in the reporting currency (cents). Replaced in full by every sync.
  `CREATE TABLE IF NOT EXISTS pw_mrr (
    plan_id       TEXT NOT NULL,
    month         TEXT NOT NULL,
    mrr           INTEGER NOT NULL DEFAULT 0,
    customers     INTEGER NOT NULL DEFAULT 0,
    new_mrr       INTEGER NOT NULL DEFAULT 0,
    churned_mrr   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (plan_id, month)
  )`,

  // Planned MRR growth per product line, in % per month. The base scenario holds the defaults; another scenario's
  // row replaces the base one for that line.
  `CREATE TABLE IF NOT EXISTS line_growth (
    line_id     INTEGER NOT NULL,
    scenario_id INTEGER NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
    rate_pct    REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (line_id, scenario_id)
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

// Reads the schema markers in one request. ok: the database has the schema; upgraded: the upgrades below
// were already applied, so loading the app can skip them.
export async function checkSchema() {
  try {
    const rows = await query("SELECT key, value FROM _meta WHERE key IN ('schema_version', 'upgrades')");
    const meta = Object.fromEntries(rows.map(r => [r.key, r.value]));
    return { ok: meta.schema_version === SCHEMA_VERSION, upgraded: meta.upgrades === UPGRADES_SIGNATURE };
  } catch {
    return { ok: false, upgraded: false }; // no _meta table: not set up yet
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

// Added after schema version 1. Databases created earlier get them in ensureSchemaUpgrades(), on load.
// Upgrades only add tables, nullable columns and rows: existing data is never changed.
const ADDED_COLUMNS = {
  settings: {
    assistant_relay_url: "TEXT DEFAULT 'https://assistant.vintana.onetake.ai'",
    assistant_model: "TEXT DEFAULT 'claude-opus-5-5'",
    company_context: 'TEXT',
    payroll_pay_day: 'INTEGER',
    assistant_provider: "TEXT DEFAULT 'claude'",
    assistant_openai_model: 'TEXT',
    profitwell_currency: 'TEXT',
    profitwell_last_sync: 'TEXT',
    profitwell_sync_note: 'TEXT',
  },
  statement_imports: {
    read_by: 'TEXT',
  },
  expense_items: {
    subcategory_id: 'INTEGER REFERENCES expense_subcategories(id)',
    billing_threshold: 'INTEGER', // cents: for expenses billed each time spend reaches this amount
  },
  employees: {
    charge_label: 'TEXT',
  },
  funding_events: {
    is_actual: 'INTEGER NOT NULL DEFAULT 0',
  },
};

const ADDED_TABLES = ['expense_subcategories', 'bank_accounts', 'bank_balances', 'statement_imports', 'bank_transactions', 'fx_rates',
  'product_families', 'product_lines', 'pw_plans', 'pw_mrr', 'line_growth'];

// Changes whenever the lists above change, so new upgrades run once on every database, then never again
const UPGRADES_SIGNATURE = JSON.stringify([ADDED_TABLES, Object.entries(ADDED_COLUMNS).map(([t, c]) => [t, Object.keys(c)])]);

// Default sub-categories: a typical Singapore SaaS chart of accounts, under the five P&L categories.
// Payroll (salaries, employer CPF) is not here: it comes from the Payroll page.
export const DEFAULT_SUBCATEGORIES = {
  'Cost of Goods Sold (COGS)': [
    'Cloud hosting & infrastructure', 'Third-party APIs & AI services', 'Payment processing fees',
    'Customer support tools', 'Content & licensing costs',
  ],
  'Research & Development': [
    'Software & development tools', 'R&D contractors & freelancers', 'Research & testing',
  ],
  'Sales & Marketing': [
    'Advertising & paid acquisition', 'Marketing software', 'Events & sponsorships',
    'Affiliate & referral commissions', 'Sales commissions', 'Travel & entertainment (sales)',
  ],
  'General & Administrative': [
    'Rent & utilities', 'Office supplies & equipment', 'Accounting & audit fees', 'Legal & professional fees',
    'Corporate secretarial fees', 'Insurance', 'Bank charges', 'Telecommunications & internet',
    'Business software (SaaS)', 'Staff welfare & training', 'Travel (general)',
    'Licences, permits & government fees', 'Depreciation',
  ],
  'Uncategorized / Other': [
    'Foreign exchange gains & losses', 'Miscellaneous expenses',
  ],
};

export async function ensureSchemaUpgrades() {
  await batch(ADDED_TABLES.map(t => DDL.find(d => d.includes(`EXISTS ${t} (`))));
  const tables = Object.entries(ADDED_COLUMNS);
  const infos = await batch(tables.map(([table]) => `PRAGMA table_info(${table})`));
  const alters = [];
  tables.forEach(([table, columns], i) => {
    const nameCol = infos[i].cols.indexOf('name');
    const have = new Set(infos[i].rows.map(r => r[nameCol]));
    Object.keys(columns).filter(c => !have.has(c)).forEach(c => alters.push(`ALTER TABLE ${table} ADD COLUMN ${c} ${columns[c]}`));
  });
  if (alters.length) await batch(alters);
  // Seed the default sub-categories once; after that, deleted ones stay deleted
  const seeded = await query("SELECT value FROM _meta WHERE key = 'subcategories_seeded'");
  if (!seeded.length) {
    const stmts = [];
    for (const [category, names] of Object.entries(DEFAULT_SUBCATEGORIES)) {
      names.forEach((name, i) => stmts.push({
        sql: `INSERT OR IGNORE INTO expense_subcategories (category_id, name, sort_order)
              SELECT id, ?, ? FROM expense_categories WHERE name = ?`,
        args: [name, i + 1, category],
      }));
    }
    stmts.push("INSERT OR REPLACE INTO _meta (key, value) VALUES ('subcategories_seeded', '1')");
    await batch(stmts);
  }
  // There is always at least one bank account. The first one takes over the balances recorded before
  // accounts existed (they were in the reporting currency, so it starts in that currency).
  const accounts = await query('SELECT id FROM bank_accounts ORDER BY sort_order, id LIMIT 1');
  let firstId = accounts[0]?.id;
  if (!firstId) {
    const cur = (await query('SELECT currency FROM settings WHERE id = 1'))[0]?.currency || 'EUR';
    firstId = (await execute("INSERT INTO bank_accounts (bank_name, label, currency, sort_order) VALUES ('Main bank', 'Main account', ?, 1)", [cur])).lastInsertRowid;
  }
  const moved = await query("SELECT value FROM _meta WHERE key = 'cash_actuals_moved'");
  if (!moved.length && firstId) {
    await batch([
      { sql: `INSERT OR IGNORE INTO bank_balances (account_id, month, balance, source)
              SELECT ?, month, balance, 'manual' FROM cash_actuals`, args: [firstId] },
      "INSERT OR REPLACE INTO _meta (key, value) VALUES ('cash_actuals_moved', '1')",
    ]);
  }
  await execute("INSERT OR REPLACE INTO _meta (key, value) VALUES ('upgrades', ?)", [UPGRADES_SIGNATURE]);
}

export async function resetAllData() {
  const tables = [
    'bank_transactions', 'statement_imports', 'bank_balances', 'bank_accounts', 'fx_rates',
    'line_growth', 'pw_mrr', 'pw_plans', 'product_lines', 'product_families',
    'funding_events', 'cash_actuals', 'scenario_employees',
    'employee_overrides', 'employees', 'revenue_values',
    'revenue_products', 'expense_values', 'expense_items',
    'expense_subcategories', 'expense_categories', 'scenarios', 'settings', '_meta',
  ];
  await batch(tables.map(t => `DROP TABLE IF EXISTS ${t}`));
  await runMigrations();
  await ensureSchemaUpgrades();
}

export async function getSettings() {
  const rows = await query('SELECT * FROM settings WHERE id = 1');
  if (rows.length === 0) return null;
  const s = rows[0];
  try { s.dept_mapping = JSON.parse(s.dept_mapping || '{}'); } catch { s.dept_mapping = {}; }
  return s;
}

export async function updateSettings(fields) {
  const allowed = ['company_name', 'currency', 'fiscal_year_start', 'actuals_through', 'dept_mapping',
    'assistant_relay_url', 'assistant_model', 'company_context', 'payroll_pay_day',
    'assistant_provider', 'assistant_openai_model', 'profitwell_currency', 'profitwell_last_sync', 'profitwell_sync_note'];
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

// The base scenario can't be deleted, so its id is looked up once per database and page load
const baseIds = new Map();
export function getBaseScenarioId() {
  const db = getCredentials().url;
  if (!baseIds.has(db)) {
    baseIds.set(db, query('SELECT id FROM scenarios WHERE is_base = 1 LIMIT 1')
      .then(rows => rows[0]?.id || 1)
      .catch(e => { baseIds.delete(db); throw e; }));
  }
  return baseIds.get(db);
}
