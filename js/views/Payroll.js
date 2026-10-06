import { query, execute } from '../db.js';
import { formatCents, currentMonth, generateMonthRange, monthLabel } from '../utils.js';

const COLORS = ['#6366f1','#10b981','#f59e0b','#ef4444','#8b5cf6','#06b6d4','#ec4899','#84cc16','#f97316','#14b8a6'];
const INPUT = 'w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500';

export default {
  name: 'PayrollView',
  setup() {
    const { ref, computed, onMounted, onBeforeUnmount, watch, inject, nextTick } = Vue;
    const scenarioId = inject('scenarioId');
    const dateRange = inject('dateRange');
    const settings = inject('settings');
    const toast = inject('toast');

    const employees = ref([]);
    const loading = ref(true);
    const deptFilter = ref('');
    const sortCol = ref('name');
    const sortAsc = ref(true);
    const showModal = ref(false);
    const editingEmployee = ref(null);
    const confirmDelete = ref(null);
    const scenarioIsBase = ref(true);
    const donutCanvas = ref(null);
    const lineCanvas = ref(null);
    let donutChart = null, lineChart = null;

    const blankForm = () => ({ name:'', role:'', department:'', salary_eur:'', tax_pct:0, start_date:'', end_date:'', notes:'' });
    const form = ref(blankForm());

    async function loadEmployees() {
      loading.value = true;
      try {
        const scId = scenarioId.value;
        const scRows = await query('SELECT is_base FROM scenarios WHERE id = ?', [scId]);
        scenarioIsBase.value = scRows.length > 0 ? !!scRows[0].is_base : true;
        const base = await query('SELECT * FROM employees ORDER BY name');
        let merged;
        if (scenarioIsBase.value) {
          merged = base.map(e => ({ ...e, _source: 'base' }));
        } else {
          const overrides = await query('SELECT * FROM employee_overrides WHERE scenario_id = ?', [scId]);
          const overMap = {};
          overrides.forEach(o => { overMap[o.employee_id] = o; });
          merged = base.map(e => {
            const o = overMap[e.id];
            return { ...e, salary_monthly: o?.salary_monthly ?? e.salary_monthly, tax_pct: o?.tax_pct ?? e.tax_pct,
              start_date: o?.start_date ?? e.start_date, end_date: o?.end_date ?? e.end_date, _source: o ? 'override' : 'base' };
          });
          const extras = await query('SELECT * FROM scenario_employees WHERE scenario_id = ? ORDER BY name', [scId]);
          extras.forEach(e => merged.push({ ...e, _source: 'scenario', _scenarioEmployeeId: e.id }));
        }
        employees.value = merged;
      } catch (e) { toast('Failed to load employees: ' + e.message, 'error'); }
      finally { loading.value = false; }
    }

    const cm = computed(() => currentMonth());
    const activeEmployees = computed(() => employees.value.filter(e =>
      e.start_date <= cm.value && (!e.end_date || e.end_date >= cm.value)));
    const empCost = e => Math.round(e.salary_monthly * (1 + (e.tax_pct || 0) / 100));
    const totalCost = computed(() => activeEmployees.value.reduce((s, e) => s + empCost(e), 0));
    const headcount = computed(() => activeEmployees.value.length);
    const departments = computed(() => [...new Set(employees.value.map(e => e.department).filter(Boolean))].sort());
    const costByDept = computed(() => {
      const m = {};
      activeEmployees.value.forEach(e => { const d = e.department || 'Unassigned'; m[d] = (m[d] || 0) + empCost(e); });
      return m;
    });
    const filteredEmployees = computed(() => {
      let list = deptFilter.value ? employees.value.filter(e => e.department === deptFilter.value) : employees.value;
      const col = sortCol.value, asc = sortAsc.value ? 1 : -1;
      return [...list].sort((a, b) => {
        let va = col === 'total_cost' ? empCost(a) : a[col];
        let vb = col === 'total_cost' ? empCost(b) : b[col];
        if (va == null) return 1; if (vb == null) return -1;
        return (typeof va === 'number' ? va - vb : String(va).localeCompare(String(vb))) * asc;
      });
    });
    function toggleSort(c) { if (sortCol.value === c) sortAsc.value = !sortAsc.value; else { sortCol.value = c; sortAsc.value = true; } }
    function openAdd() { editingEmployee.value = null; form.value = blankForm(); showModal.value = true; }
    function openEdit(emp) {
      editingEmployee.value = emp;
      form.value = { name: emp.name, role: emp.role||'', department: emp.department||'',
        salary_eur: (emp.salary_monthly/100).toFixed(2), tax_pct: emp.tax_pct||0,
        start_date: emp.start_date, end_date: emp.end_date||'', notes: emp.notes||'' };
      showModal.value = true;
    }
    async function saveEmployee() {
      const f = form.value;
      if (!f.name || !f.start_date || !f.salary_eur) { toast('Name, salary and start date are required', 'error'); return; }
      const cents = Math.round(parseFloat(f.salary_eur) * 100);
      if (isNaN(cents) || cents < 0) { toast('Invalid salary', 'error'); return; }
      const end = f.end_date || null;
      try {
        if (editingEmployee.value) {
          const emp = editingEmployee.value;
          if (emp._source === 'scenario') {
            await execute('UPDATE scenario_employees SET name=?,role=?,department=?,salary_monthly=?,tax_pct=?,start_date=?,end_date=?,notes=? WHERE id=?',
              [f.name, f.role, f.department, cents, f.tax_pct, f.start_date, end, f.notes, emp._scenarioEmployeeId]);
          } else if (!scenarioIsBase.value) {
            await execute('INSERT OR REPLACE INTO employee_overrides (employee_id,scenario_id,salary_monthly,tax_pct,start_date,end_date) VALUES (?,?,?,?,?,?)',
              [emp.id, scenarioId.value, cents, f.tax_pct, f.start_date, end]);
          } else {
            await execute('UPDATE employees SET name=?,role=?,department=?,salary_monthly=?,tax_pct=?,start_date=?,end_date=?,notes=? WHERE id=?',
              [f.name, f.role, f.department, cents, f.tax_pct, f.start_date, end, f.notes, emp.id]);
          }
          toast('Employee updated', 'success');
        } else {
          if (scenarioIsBase.value) {
            await execute('INSERT INTO employees (name,role,department,salary_monthly,tax_pct,start_date,end_date,notes) VALUES (?,?,?,?,?,?,?,?)',
              [f.name, f.role, f.department, cents, f.tax_pct, f.start_date, end, f.notes]);
          } else {
            await execute('INSERT INTO scenario_employees (scenario_id,name,role,department,salary_monthly,tax_pct,start_date,end_date,notes) VALUES (?,?,?,?,?,?,?,?,?)',
              [scenarioId.value, f.name, f.role, f.department, cents, f.tax_pct, f.start_date, end, f.notes]);
          }
          toast('Employee added', 'success');
        }
        showModal.value = false;
        await loadEmployees(); await nextTick(); renderCharts();
      } catch (e) { toast('Save failed: ' + e.message, 'error'); }
    }
    async function deleteEmployee(emp) {
      try {
        if (emp._source === 'scenario') await execute('DELETE FROM scenario_employees WHERE id=?', [emp._scenarioEmployeeId]);
        else if (scenarioIsBase.value) await execute('DELETE FROM employees WHERE id=?', [emp.id]);
        else { toast('Cannot delete base employees in a non-base scenario', 'error'); confirmDelete.value = null; return; }
        toast('Employee deleted', 'success'); confirmDelete.value = null;
        await loadEmployees(); await nextTick(); renderCharts();
      } catch (e) { toast('Delete failed: ' + e.message, 'error'); }
    }
    function renderCharts() {
      if (donutChart) donutChart.destroy(); if (lineChart) lineChart.destroy();
      const depts = costByDept.value, labels = Object.keys(depts);
      if (donutCanvas.value && labels.length) {
        donutChart = new Chart(donutCanvas.value.getContext('2d'), { type:'doughnut',
          data:{ labels, datasets:[{ data:labels.map(l=>depts[l]/100), backgroundColor:labels.map((_,i)=>COLORS[i%COLORS.length]), borderWidth:0 }] },
          options:{ responsive:true, maintainAspectRatio:false, cutout:'65%',
            plugins:{ legend:{ position:'bottom', labels:{ boxWidth:12, padding:8, font:{size:11} } },
              tooltip:{ callbacks:{ label:c=>`${c.label}: €${c.parsed.toLocaleString(undefined,{minimumFractionDigits:2})}` } } } } });
      }
      if (lineCanvas.value && dateRange.value) {
        const months = generateMonthRange(dateRange.value.start, dateRange.value.end);
        const data = months.map(m => {
          const act = employees.value.filter(e => e.start_date <= m && (!e.end_date || e.end_date >= m));
          return act.reduce((s,e) => s + empCost(e), 0) / 100;
        });
        lineChart = new Chart(lineCanvas.value.getContext('2d'), { type:'line',
          data:{ labels:months.map(monthLabel), datasets:[{ label:'Total Payroll', data, borderColor:'#6366f1',
            backgroundColor:'rgba(99,102,241,0.08)', fill:true, tension:0.3, pointRadius:2, borderWidth:2 }] },
          options:{ responsive:true, maintainAspectRatio:false,
            scales:{ y:{ beginAtZero:true, ticks:{ callback:v=>'€'+v.toLocaleString() }, grid:{color:'#f3f4f6'} }, x:{ grid:{display:false} } },
            plugins:{ legend:{display:false}, tooltip:{ callbacks:{ label:c=>`€${c.parsed.y.toLocaleString(undefined,{minimumFractionDigits:2})}` } } } } });
      }
    }
    onMounted(async () => { await loadEmployees(); await nextTick(); renderCharts(); });
    onBeforeUnmount(() => { if (donutChart) donutChart.destroy(); if (lineChart) lineChart.destroy(); });
    watch([scenarioId, dateRange], async () => { await loadEmployees(); await nextTick(); renderCharts(); }, { deep:true });

    return { loading, filteredEmployees, departments, deptFilter, sortCol, sortAsc, toggleSort,
      totalCost, headcount, showModal, editingEmployee, form, openAdd, openEdit, saveEmployee,
      confirmDelete, deleteEmployee, empCost, donutCanvas, lineCanvas, formatCents, scenarioIsBase, INPUT };
  },
  template: `
<div class="space-y-6">
  <div class="flex items-center justify-between">
    <h1 class="text-2xl font-bold text-gray-900">Payroll</h1>
    <button @click="openAdd" class="px-4 py-2 text-sm font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 transition-colors">+ Add Employee</button>
  </div>
  <div v-if="loading" class="text-gray-400 py-12 text-center">Loading...</div>
  <template v-else>
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
      <div class="bg-white rounded-xl border border-gray-200 p-5">
        <span class="text-xs font-medium text-gray-500 uppercase tracking-wider">Monthly Payroll Cost</span>
        <div class="text-2xl font-bold text-gray-900 mt-2">{{ formatCents(totalCost) }}</div>
      </div>
      <div class="bg-white rounded-xl border border-gray-200 p-5">
        <span class="text-xs font-medium text-gray-500 uppercase tracking-wider">Headcount</span>
        <div class="text-2xl font-bold text-gray-900 mt-2">{{ headcount }}</div>
      </div>
      <div class="bg-white rounded-xl border border-gray-200 p-5">
        <span class="text-xs font-medium text-gray-500 uppercase tracking-wider">Cost by Department</span>
        <div style="height:160px" class="mt-2"><canvas ref="donutCanvas"></canvas></div>
      </div>
      <div class="bg-white rounded-xl border border-gray-200 p-5">
        <span class="text-xs font-medium text-gray-500 uppercase tracking-wider">Payroll Over Time</span>
        <div style="height:160px" class="mt-2"><canvas ref="lineCanvas"></canvas></div>
      </div>
    </div>
    <div class="bg-white rounded-xl border border-gray-200">
      <div class="p-4 border-b border-gray-200 flex items-center gap-3">
        <select v-model="deptFilter" class="text-sm border border-gray-200 rounded-lg px-3 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500">
          <option value="">All Departments</option>
          <option v-for="d in departments" :key="d" :value="d">{{ d }}</option>
        </select>
        <span class="text-xs text-gray-400 ml-auto">{{ filteredEmployees.length }} employee{{ filteredEmployees.length !== 1 ? 's' : '' }}</span>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead><tr class="bg-gray-50 border-b border-gray-200">
            <th v-for="col in [{key:'name',label:'Name'},{key:'role',label:'Role'},{key:'department',label:'Dept'},{key:'salary_monthly',label:'Gross Salary'},{key:'tax_pct',label:'Tax %'},{key:'total_cost',label:'Total Cost'},{key:'start_date',label:'Start'},{key:'end_date',label:'End'}]"
              :key="col.key" @click="toggleSort(col.key)" class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:text-gray-700 select-none whitespace-nowrap">
              {{ col.label }}<span v-if="sortCol===col.key" class="ml-1">{{ sortAsc ? '\\u25B2' : '\\u25BC' }}</span>
            </th>
            <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
          </tr></thead>
          <tbody class="divide-y divide-gray-100">
            <tr v-for="emp in filteredEmployees" :key="emp.id||emp._scenarioEmployeeId" class="hover:bg-gray-50 transition-colors">
              <td class="px-4 py-3 font-medium text-gray-900">{{ emp.name }}</td>
              <td class="px-4 py-3 text-gray-600">{{ emp.role||'\\u2014' }}</td>
              <td class="px-4 py-3 text-gray-600">{{ emp.department||'\\u2014' }}</td>
              <td class="px-4 py-3 text-gray-900">{{ formatCents(emp.salary_monthly) }}</td>
              <td class="px-4 py-3 text-gray-600">{{ emp.tax_pct }}%</td>
              <td class="px-4 py-3 text-gray-900 font-medium">{{ formatCents(empCost(emp)) }}</td>
              <td class="px-4 py-3 text-gray-600">{{ emp.start_date }}</td>
              <td class="px-4 py-3 text-gray-600">{{ emp.end_date||'Current' }}</td>
              <td class="px-4 py-3"><div class="flex items-center gap-2">
                <button @click="openEdit(emp)" class="text-indigo-600 hover:text-indigo-800 text-xs font-medium">Edit</button>
                <button @click="confirmDelete=emp" class="text-red-500 hover:text-red-700 text-xs font-medium">Delete</button>
              </div></td>
            </tr>
            <tr v-if="filteredEmployees.length===0"><td colspan="9" class="px-4 py-8 text-center text-gray-400">No employees</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </template>
  <div v-if="showModal" class="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
    <div class="bg-white rounded-xl w-full max-w-lg max-h-[90vh] overflow-y-auto p-6">
      <h3 class="text-lg font-semibold text-gray-900 mb-4">{{ editingEmployee ? 'Edit Employee' : 'Add Employee' }}</h3>
      <div class="space-y-4">
        <div class="grid grid-cols-2 gap-4">
          <div><label class="block text-xs font-medium text-gray-500 mb-1">Name *</label><input v-model="form.name" type="text" :class="INPUT"/></div>
          <div><label class="block text-xs font-medium text-gray-500 mb-1">Role</label><input v-model="form.role" type="text" :class="INPUT"/></div>
        </div>
        <div><label class="block text-xs font-medium text-gray-500 mb-1">Department</label>
          <input v-model="form.department" type="text" list="dept-list" :class="INPUT"/>
          <datalist id="dept-list"><option v-for="d in departments" :key="d" :value="d"/></datalist>
        </div>
        <div class="grid grid-cols-2 gap-4">
          <div><label class="block text-xs font-medium text-gray-500 mb-1">Monthly Salary (EUR) *</label><input v-model="form.salary_eur" type="number" step="0.01" min="0" :class="INPUT"/></div>
          <div><label class="block text-xs font-medium text-gray-500 mb-1">Tax % (employer)</label><input v-model.number="form.tax_pct" type="number" step="0.1" min="0" :class="INPUT"/></div>
        </div>
        <div class="grid grid-cols-2 gap-4">
          <div><label class="block text-xs font-medium text-gray-500 mb-1">Start Date *</label><input v-model="form.start_date" type="month" :class="INPUT"/></div>
          <div><label class="block text-xs font-medium text-gray-500 mb-1">End Date</label><input v-model="form.end_date" type="month" :class="INPUT"/></div>
        </div>
        <div><label class="block text-xs font-medium text-gray-500 mb-1">Notes</label><textarea v-model="form.notes" rows="2" :class="INPUT"></textarea></div>
      </div>
      <div class="flex justify-end gap-3 mt-6">
        <button @click="showModal=false" class="px-4 py-2 text-sm border border-gray-200 rounded-lg hover:bg-gray-50">Cancel</button>
        <button @click="saveEmployee" class="px-4 py-2 text-sm font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700">{{ editingEmployee ? 'Save Changes' : 'Add Employee' }}</button>
      </div>
    </div>
  </div>
  <div v-if="confirmDelete" class="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
    <div class="bg-white rounded-xl p-6 max-w-sm">
      <h3 class="text-lg font-semibold text-gray-900 mb-2">Delete Employee</h3>
      <p class="text-sm text-gray-600 mb-6">Remove <strong>{{ confirmDelete.name }}</strong>? This cannot be undone.</p>
      <div class="flex justify-end gap-3">
        <button @click="confirmDelete=null" class="px-4 py-2 text-sm border border-gray-200 rounded-lg hover:bg-gray-50">Cancel</button>
        <button @click="deleteEmployee(confirmDelete)" class="px-4 py-2 text-sm text-white bg-red-600 rounded-lg hover:bg-red-700">Delete</button>
      </div>
    </div>
  </div>
</div>`,
};
