export function tokenize(expr) {
  const tokens = [];
  let i = 0;
  while (i < expr.length) {
    if (/\s/.test(expr[i])) { i++; continue; }
    if ('+-*/()'.includes(expr[i])) {
      tokens.push({ type: 'op', value: expr[i] });
      i++;
      continue;
    }
    if (/[0-9.]/.test(expr[i])) {
      let num = '';
      while (i < expr.length && /[0-9.]/.test(expr[i])) { num += expr[i]; i++; }
      tokens.push({ type: 'number', value: parseFloat(num) });
      continue;
    }
    if (/[a-zA-Z_]/.test(expr[i])) {
      let ident = '';
      while (i < expr.length && /[a-zA-Z0-9_.]/.test(expr[i])) { ident += expr[i]; i++; }
      tokens.push({ type: 'ident', value: ident });
      continue;
    }
    i++;
  }
  return tokens;
}

function parse(tokens) {
  let pos = 0;

  function peek() { return tokens[pos] || null; }
  function consume(type, value) {
    const t = tokens[pos];
    if (!t) throw new Error('Unexpected end of expression');
    if (type && t.type !== type) throw new Error(`Expected ${type}, got ${t.type}`);
    if (value && t.value !== value) throw new Error(`Expected ${value}, got ${t.value}`);
    pos++;
    return t;
  }

  function parseExpr() { return parseAdd(); }

  function parseAdd() {
    let left = parseMul();
    while (peek() && peek().type === 'op' && (peek().value === '+' || peek().value === '-')) {
      const op = consume().value;
      const right = parseMul();
      left = { type: 'binary', op, left, right };
    }
    return left;
  }

  function parseMul() {
    let left = parseUnary();
    while (peek() && peek().type === 'op' && (peek().value === '*' || peek().value === '/')) {
      const op = consume().value;
      const right = parseUnary();
      left = { type: 'binary', op, left, right };
    }
    return left;
  }

  function parseUnary() {
    if (peek() && peek().type === 'op' && peek().value === '-') {
      consume();
      const node = parsePrimary();
      return { type: 'unary', op: '-', operand: node };
    }
    return parsePrimary();
  }

  function parsePrimary() {
    const t = peek();
    if (!t) throw new Error('Unexpected end of expression');
    if (t.type === 'number') {
      consume();
      return { type: 'literal', value: t.value };
    }
    if (t.type === 'ident') {
      consume();
      return { type: 'variable', name: t.value };
    }
    if (t.type === 'op' && t.value === '(') {
      consume();
      const node = parseExpr();
      consume('op', ')');
      return node;
    }
    throw new Error(`Unexpected token: ${t.value}`);
  }

  const ast = parseExpr();
  if (pos < tokens.length) throw new Error(`Unexpected token: ${tokens[pos].value}`);
  return ast;
}

function evaluate(ast, ctx) {
  switch (ast.type) {
    case 'literal': return ast.value;
    case 'variable': {
      const val = ctx[ast.name];
      return (val === null || val === undefined) ? 0 : Number(val);
    }
    case 'unary':
      return -evaluate(ast.operand, ctx);
    case 'binary': {
      const l = evaluate(ast.left, ctx);
      const r = evaluate(ast.right, ctx);
      switch (ast.op) {
        case '+': return l + r;
        case '-': return l - r;
        case '*': return l * r;
        case '/': return r === 0 ? 0 : l / r;
      }
    }
  }
  return 0;
}

export function getDependencies(formula) {
  if (!formula) return [];
  const tokens = tokenize(formula);
  return tokens.filter(t => t.type === 'ident').map(t => t.value);
}

export function evalFormula(formula, context) {
  if (!formula) return 0;
  try {
    const tokens = tokenize(formula);
    const ast = parse(tokens);
    return Math.round(evaluate(ast, context));
  } catch {
    return 0;
  }
}

export function buildFormulaContext(month, revenueData, employeeData, expenseResults) {
  const ctx = {};
  let totalCustomers = 0;
  let totalRevenue = 0;

  if (revenueData) {
    for (const product of revenueData) {
      const mv = (product.monthlyValues || {})[month];
      const customers = mv ? mv.customers : 0;
      const arpu = mv ? mv.arpu : 0;
      const revenue = customers * arpu;
      const alias = product.alias || product.name.toLowerCase().replace(/[^a-z0-9]+/g, '_');
      ctx[`${alias}.customers`] = customers;
      ctx[`${alias}.arpu`] = arpu;
      ctx[`${alias}.revenue`] = revenue;
      totalCustomers += customers;
      totalRevenue += revenue;
    }
  }
  ctx['customers.total'] = totalCustomers;
  ctx['revenue.total'] = totalRevenue;

  let totalHeadcount = 0;
  let totalPayroll = 0;
  const deptData = {};

  if (employeeData) {
    for (const emp of employeeData) {
      if (emp.start_date > month) continue;
      if (emp.end_date && emp.end_date < month) continue;
      const dept = (emp.department || 'other').toLowerCase().replace(/[^a-z0-9]+/g, '_');
      if (!deptData[dept]) deptData[dept] = { headcount: 0, payroll: 0 };
      deptData[dept].headcount++;
      const cost = Math.round(emp.salary_monthly * (1 + (emp.tax_pct || 0) / 100));
      deptData[dept].payroll += cost;
      totalHeadcount++;
      totalPayroll += cost;
    }
  }

  for (const [dept, data] of Object.entries(deptData)) {
    ctx[`${dept}.headcount`] = data.headcount;
    ctx[`${dept}.payroll`] = data.payroll;
  }
  ctx['headcount.total'] = totalHeadcount;
  ctx['payroll.total'] = totalPayroll;

  if (expenseResults) {
    for (const [alias, amount] of Object.entries(expenseResults)) {
      ctx[alias] = amount;
    }
  }

  return ctx;
}

export function resolveFormulas(formulaItems, context) {
  const results = {};
  const resolved = new Set();
  const resolving = new Set();

  function resolve(item) {
    const alias = item.alias;
    if (resolved.has(alias)) return results[alias];
    if (resolving.has(alias)) return 0;
    resolving.add(alias);

    const deps = getDependencies(item.formula);
    for (const dep of deps) {
      const depParts = dep.split('.');
      const depAlias = depParts[0];
      const depItem = formulaItems.find(fi => fi.alias === depAlias);
      if (depItem && !resolved.has(depAlias)) {
        resolve(depItem);
        context[depAlias] = results[depAlias];
      }
    }

    results[alias] = evalFormula(item.formula, context);
    context[alias] = results[alias];
    resolved.add(alias);
    resolving.delete(alias);
    return results[alias];
  }

  for (const item of formulaItems) {
    if (item.alias && !resolved.has(item.alias)) {
      resolve(item);
    }
  }

  return results;
}
