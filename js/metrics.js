import { query } from './db.js';
import { currentMonth } from './utils.js';
import { loadScenarioEmployees, employeeCost, isEmployedIn } from './payroll.js';

// Headline numbers for the current month in a scenario (scenario values replace base values). Amounts in cents.
export async function loadHeadlineMetrics(scenarioId) {
  const month = currentMonth();
  const baseRows = await query('SELECT id FROM scenarios WHERE is_base = 1 LIMIT 1');
  const baseId = baseRows[0]?.id || 1;

  const [revRows, expRows, cashRows, { employees }] = await Promise.all([
    query(`SELECT product_id, scenario_id, customers * arpu AS v FROM revenue_values
           WHERE scenario_id IN (?, ?) AND month = ?`, [scenarioId, baseId, month]),
    query(`SELECT ev.expense_item_id, ev.scenario_id, ev.amount AS v FROM expense_values ev
           JOIN expense_items ei ON ei.id = ev.expense_item_id AND ei.visible = 1
           WHERE ev.scenario_id IN (?, ?) AND ev.month = ?`, [scenarioId, baseId, month]),
    query('SELECT month, balance FROM cash_actuals ORDER BY month DESC LIMIT 1'),
    loadScenarioEmployees(scenarioId),
  ]);

  const overlaySum = (rows, keyCol) => {
    const byKey = {};
    rows.forEach(r => { if (!(r[keyCol] in byKey) || r.scenario_id === scenarioId) byKey[r[keyCol]] = r.v || 0; });
    return Object.values(byKey).reduce((a, b) => a + b, 0);
  };

  const revenue = overlaySum(revRows, 'product_id');
  const expenses = overlaySum(expRows, 'expense_item_id');
  const payroll = employees.filter(e => isEmployedIn(e, month)).reduce((s, e) => s + employeeCost(e), 0);

  return {
    month,
    revenue,
    expenses,
    payroll,
    burn: expenses + payroll - revenue,
    cash: cashRows.length ? cashRows[0].balance : null,
    cashMonth: cashRows.length ? cashRows[0].month : null,
  };
}
