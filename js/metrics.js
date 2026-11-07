import { query } from './db.js';
import { getBaseScenarioId } from './schema.js';
import { currentMonth } from './utils.js';
import { loadScenarioEmployees, employeeCost, isEmployedIn } from './payroll.js';
import { cashPosition } from './bank.js';
import { loadMrrTotals } from './profitwell.js';

// Headline numbers for the current month in a scenario (scenario values replace base values). Amounts in cents.
export async function loadHeadlineMetrics(scenarioId) {
  const month = currentMonth();
  const baseId = await getBaseScenarioId();

  const [mrr, expRows, cash, { employees }] = await Promise.all([
    loadMrrTotals(scenarioId, month, month),
    query(`SELECT ev.expense_item_id, ev.scenario_id, ev.amount AS v FROM expense_values ev
           JOIN expense_items ei ON ei.id = ev.expense_item_id AND ei.visible = 1
           WHERE ev.scenario_id IN (?, ?) AND ev.month = ?`, [scenarioId, baseId, month]),
    cashPosition().catch(() => null),
    loadScenarioEmployees(scenarioId),
  ]);

  const overlaySum = (rows, keyCol) => {
    const byKey = {};
    rows.forEach(r => { if (!(r[keyCol] in byKey) || r.scenario_id === scenarioId) byKey[r[keyCol]] = r.v || 0; });
    return Object.values(byKey).reduce((a, b) => a + b, 0);
  };

  const revenue = mrr[month] || 0;
  const expenses = overlaySum(expRows, 'expense_item_id');
  const payroll = employees.filter(e => isEmployedIn(e, month)).reduce((s, e) => s + employeeCost(e), 0);

  return {
    month,
    revenue,
    expenses,
    payroll,
    burn: expenses + payroll - revenue,
    cash: cash ? cash.total : null,
    cashMonth: cash ? cash.month : null,
    cashComplete: cash ? cash.complete : false,
  };
}
