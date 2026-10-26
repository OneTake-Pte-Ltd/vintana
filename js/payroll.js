import { query } from './db.js';

export const DEFAULT_DEPT_MAPPING = {
  Engineering: 'Research & Development',
  Product: 'Research & Development',
  Design: 'Research & Development',
  Sales: 'Sales & Marketing',
  Marketing: 'Sales & Marketing',
  Admin: 'General & Administrative',
  Finance: 'General & Administrative',
  HR: 'General & Administrative',
  Legal: 'General & Administrative',
  Operations: 'General & Administrative',
};

// Base employees with the scenario's overrides applied, plus employees added only in that scenario
export async function loadScenarioEmployees(scenarioId) {
  const scRows = await query('SELECT is_base FROM scenarios WHERE id = ?', [scenarioId]);
  const isBase = scRows.length > 0 ? !!scRows[0].is_base : true;
  const base = await query('SELECT * FROM employees ORDER BY name');
  if (isBase) return { isBase, employees: base.map(e => ({ ...e, _source: 'base' })) };

  const overrides = await query('SELECT * FROM employee_overrides WHERE scenario_id = ?', [scenarioId]);
  const overMap = {};
  overrides.forEach(o => { overMap[o.employee_id] = o; });
  const merged = base.map(e => {
    const o = overMap[e.id];
    return { ...e, salary_monthly: o?.salary_monthly ?? e.salary_monthly, tax_pct: o?.tax_pct ?? e.tax_pct,
      start_date: o?.start_date ?? e.start_date, end_date: o?.end_date ?? e.end_date, _source: o ? 'override' : 'base' };
  });
  const extras = await query('SELECT * FROM scenario_employees WHERE scenario_id = ? ORDER BY name', [scenarioId]);
  extras.forEach(e => merged.push({ ...e, _source: 'scenario', _scenarioEmployeeId: e.id }));
  return { isBase, employees: merged };
}

export const employeeCost = e => Math.round(e.salary_monthly * (1 + (e.tax_pct || 0) / 100));

export function isEmployedIn(e, month) {
  return e.start_date.slice(0, 7) <= month && (!e.end_date || e.end_date.slice(0, 7) >= month);
}

// Expense category an employee's cost belongs to, from the Settings department mapping
export function payrollCategory(department, deptMapping) {
  const mapping = deptMapping && Object.keys(deptMapping).length ? deptMapping : DEFAULT_DEPT_MAPPING;
  return mapping[department] || 'Uncategorized / Other';
}
