import { execute, query } from '../db.js';
import { formatCents, currentMonth, generateMonthRange, monthLabel } from '../utils.js';
const money = v => formatCents(Math.round(v * 100));
import { loadScenarioEmployees, employeeCost, isEmployedIn, DEFAULT_DEPT_MAPPING } from '../payroll.js';
import { recomputeComputedExpenses } from '../budget.js';
import EmployeeModal from '../../components/EmployeeModal.js';

const COLORS = ['#6366f1','#10b981','#f59e0b','#ef4444','#8b5cf6','#06b6d4','#ec4899','#84cc16','#f97316','#14b8a6'];

export default {
  name: 'PayrollView',
  components: { EmployeeModal },
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
    const route = VueRouter.useRoute();
    const router = VueRouter.useRouter();
    const scenarioIsBase = ref(true);
    const donutCanvas = ref(null);
    const lineCanvas = ref(null);
    let donutChart = null, lineChart = null;


    // Salaries actually paid, from bank statements: the latest month for each employee
    const lastPaid = ref({});
    async function loadLastPaid() {
      try {
        const rows = await query(`SELECT employee_id AS id, month, -SUM(amount_reporting) AS total FROM bank_transactions
          WHERE kind = 'salary' AND employee_id IS NOT NULL GROUP BY employee_id, month ORDER BY month`);
        const out = {};
        rows.forEach(r => { out[r.id] = r; });
        lastPaid.value = out;
      } catch { lastPaid.value = {}; }
    }
    const paidFor = emp => emp._source === 'scenario' ? null : lastPaid.value[emp.id] || null;
    const paidDiffers = emp => { const p = paidFor(emp); return p && Math.abs(p.total - empCost(emp)) > Math.max(100, empCost(emp) * 0.01); };

    async function loadEmployees() {
      loadLastPaid();
      loading.value = true;
      try {
        const res = await loadScenarioEmployees(scenarioId.value);
        scenarioIsBase.value = res.isBase;
        employees.value = res.employees;
      } catch (e) { toast('Failed to load employees: ' + e.message, 'error'); }
      finally { loading.value = false; }
    }

    const cm = computed(() => currentMonth());
    const activeEmployees = computed(() => employees.value.filter(e => isEmployedIn(e, cm.value)));
    const empCost = employeeCost;
    const totalCost = computed(() => activeEmployees.value.reduce((s, e) => s + empCost(e), 0));
    const headcount = computed(() => activeEmployees.value.length);
    const departments = computed(() => [...new Set(employees.value.map(e => e.department).filter(Boolean))].sort());
    const costByDept = computed(() => {
      const m = {};
      activeEmployees.value.forEach(e => { const d = e.department || 'Unassigned'; m[d] = (m[d] || 0) + empCost(e); });
      return m;
    });
    // Hidden by default: employment dates that don't overlap the viewed period
    const showAll = ref(false);
    const isCurrent = (e) => {
      const { start, end } = dateRange.value;
      return (e.start_date || '').slice(0, 7) <= end && (!e.end_date || e.end_date.slice(0, 7) >= start);
    };
    const hiddenCount = computed(() => employees.value.filter(e => !isCurrent(e)
      && (!deptFilter.value || e.department === deptFilter.value)).length);
    const filteredEmployees = computed(() => {
      let list = deptFilter.value ? employees.value.filter(e => e.department === deptFilter.value) : employees.value;
      if (!showAll.value) list = list.filter(isCurrent);
      const col = sortCol.value, asc = sortAsc.value ? 1 : -1;
      return [...list].sort((a, b) => {
        let va = col === 'total_cost' ? empCost(a) : a[col];
        let vb = col === 'total_cost' ? empCost(b) : b[col];
        if (va == null) return 1; if (vb == null) return -1;
        return (typeof va === 'number' ? va - vb : String(va).localeCompare(String(vb))) * asc;
      });
    });
    // --- Inline edits: name, role and department. These describe the person, not a scenario assumption,
    // so they are saved on the employee record (or the scenario-only employee) whatever the scenario.
    const NEW_DEPT = '__new__';
    const deptOptions = computed(() => {
      const known = new Set([...departments.value, ...Object.keys(settings.value?.dept_mapping || {}), ...Object.keys(DEFAULT_DEPT_MAPPING)]);
      return [{ value: null, label: 'None' }, ...[...known].sort().map(d => ({ value: d, label: d })), { value: NEW_DEPT, label: 'New department...' }];
    });
    async function saveField(emp, field, value) {
      if (field === 'department' && value === NEW_DEPT) {
        value = (window.prompt('Name of the new department') || '').trim();
        if (!value) return;
      }
      try {
        if (emp._source === 'scenario') await execute(`UPDATE scenario_employees SET ${field}=? WHERE id=?`, [value, emp._scenarioEmployeeId]);
        else await execute(`UPDATE employees SET ${field}=? WHERE id=?`, [value, emp.id]);
        emp[field] = value;
        toast('Saved', 'success');
        if (field === 'department') { await nextTick(); renderCharts(); }
      } catch (e) { toast('Save failed: ' + e.message, 'error'); }
    }

    // Opened from another page with ?edit=<id> (or s<id> for an employee added in a scenario)
    async function openFromQuery() {
      const key = route.query.edit;
      if (!key) return;
      const emp = employees.value.find(e => key.startsWith('s') ? e._source === 'scenario' && String(e._scenarioEmployeeId) === key.slice(1) : e._source !== 'scenario' && String(e.id) === key);
      router.replace({ path: '/payroll' });
      if (emp) openEdit(emp); else toast('This employee is not in the selected scenario', 'error');
    }

    function toggleSort(c) { if (sortCol.value === c) sortAsc.value = !sortAsc.value; else { sortCol.value = c; sortAsc.value = true; } }
    function openAdd() { editingEmployee.value = null; showModal.value = true; }
    function openEdit(emp) { editingEmployee.value = emp; showModal.value = true; }
    async function onEmployeeSaved() { await loadEmployees(); await nextTick(); renderCharts(); }
    async function deleteEmployee(emp) {
      try {
        if (emp._source === 'scenario') await execute('DELETE FROM scenario_employees WHERE id=?', [emp._scenarioEmployeeId]);
        else if (scenarioIsBase.value) await execute('DELETE FROM employees WHERE id=?', [emp.id]);
        else { toast('Cannot delete base employees in a non-base scenario', 'error'); confirmDelete.value = null; return; }
        toast('Employee deleted', 'success'); confirmDelete.value = null;
        recomputeComputedExpenses().catch(() => 0); // formulas can use headcount.total and payroll.total
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
              tooltip:{ callbacks:{ label:c=>`${c.label}: ${money(c.parsed)}` } } } } });
      }
      if (lineCanvas.value && dateRange.value) {
        const months = generateMonthRange(dateRange.value.start, dateRange.value.end);
        const data = months.map(m => {
          const act = employees.value.filter(e => isEmployedIn(e, m));
          return act.reduce((s,e) => s + empCost(e), 0) / 100;
        });
        lineChart = new Chart(lineCanvas.value.getContext('2d'), { type:'line',
          data:{ labels:months.map(monthLabel), datasets:[{ label:'Total Payroll', data, borderColor:'#6366f1',
            backgroundColor:'rgba(99,102,241,0.08)', fill:true, tension:0.3, pointRadius:2, borderWidth:2 }] },
          options:{ responsive:true, maintainAspectRatio:false,
            scales:{ y:{ beginAtZero:true, ticks:{ callback:v=>money(v).replace(/\.00$/,'') }, grid:{color:'#f3f4f6'} }, x:{ grid:{display:false} } },
            plugins:{ legend:{display:false}, tooltip:{ callbacks:{ label:c=>money(c.parsed.y) } } } } });
      }
    }
    onMounted(async () => { await loadEmployees(); await nextTick(); renderCharts(); openFromQuery(); });
    onBeforeUnmount(() => { if (donutChart) donutChart.destroy(); if (lineChart) lineChart.destroy(); });
    watch([scenarioId, dateRange], async () => { await loadEmployees(); await nextTick(); renderCharts(); }, { deep:true });

    return { loading, filteredEmployees, paidFor, paidDiffers, monthLabel, showAll, hiddenCount, departments, deptOptions, saveField, deptFilter, sortCol, sortAsc, toggleSort,
      totalCost, headcount, showModal, editingEmployee, openAdd, openEdit, onEmployeeSaved, scenarioId,
      confirmDelete, deleteEmployee, empCost, donutCanvas, lineCanvas, formatCents, scenarioIsBase };
  },
  template: `
<div class="space-y-6">
  <div class="flex items-center justify-between flex-wrap gap-3">
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
      <div class="p-4 border-b border-gray-200 flex flex-wrap items-center gap-3">
        <select v-model="deptFilter" class="text-sm border border-gray-200 rounded-lg px-3 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500">
          <option value="">All Departments</option>
          <option v-for="d in departments" :key="d" :value="d">{{ d }}</option>
        </select>
        <button v-if="hiddenCount || showAll" @click="showAll = !showAll" class="text-sm text-indigo-600 hover:text-indigo-800"
          title="Employees whose contract doesn't overlap the viewed period">
          {{ showAll ? 'Hide ' + hiddenCount + ' not current' : 'Show ' + hiddenCount + ' not current' }}
        </button>
        <span class="text-xs text-gray-400 ml-auto">{{ filteredEmployees.length }} employee{{ filteredEmployees.length !== 1 ? 's' : '' }}</span>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead><tr class="bg-gray-50 border-b border-gray-200">
            <th v-for="col in [{key:'name',label:'Name'},{key:'role',label:'Role'},{key:'department',label:'Dept'},{key:'salary_monthly',label:'Gross Salary'},{key:'tax_pct',label:'Tax %'},{key:'total_cost',label:'Total Cost'},{key:'start_date',label:'Start'},{key:'end_date',label:'End'}]"
              :key="col.key" @click="toggleSort(col.key)" :class="col.key === 'name' ? 'sticky-col bg-gray-50' : ''" class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:text-gray-700 select-none whitespace-nowrap">
              {{ col.label }}<span v-if="sortCol===col.key" class="ml-1">{{ sortAsc ? '\\u25B2' : '\\u25BC' }}</span>
            </th>
            <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider whitespace-nowrap" title="From imported bank statements">Last Paid</th>
            <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
          </tr></thead>
          <tbody class="divide-y divide-gray-100">
            <tr v-for="emp in filteredEmployees" :key="emp.id||emp._scenarioEmployeeId" class="hover:bg-gray-50 transition-colors">
              <td class="sticky-col px-4 py-3 font-medium text-gray-900"><inline-edit :value="emp.name" @save="v => saveField(emp, 'name', v)"/></td>
              <td class="px-4 py-3 text-gray-600"><inline-edit :value="emp.role" placeholder="Add role" @save="v => saveField(emp, 'role', v)"/></td>
              <td class="px-4 py-3 text-gray-600"><inline-edit :value="emp.department" :options="deptOptions" placeholder="None" @save="v => saveField(emp, 'department', v)"/></td>
              <td class="px-4 py-3 text-gray-900">{{ formatCents(emp.salary_monthly) }}</td>
              <td class="px-4 py-3 text-gray-600">{{ emp.tax_pct }}%</td>
              <td class="px-4 py-3 text-gray-900 font-medium">{{ formatCents(empCost(emp)) }}</td>
              <td class="px-4 py-3 text-gray-600">{{ emp.start_date }}</td>
              <td class="px-4 py-3 text-gray-600">{{ emp.end_date||'Current' }}</td>
              <td class="px-4 py-3 whitespace-nowrap">
                <template v-if="paidFor(emp)">
                  <span :class="paidDiffers(emp) ? 'text-amber-700 font-medium' : 'text-gray-900'" :title="paidDiffers(emp) ? 'Differs from the total cost on this page' : ''">{{ formatCents(paidFor(emp).total) }}</span>
                  <span class="text-xs text-gray-400 ml-1">{{ monthLabel(paidFor(emp).month) }}</span>
                </template>
                <span v-else class="text-gray-300">—</span>
              </td>
              <td class="px-4 py-3"><div class="flex items-center gap-2">
                <button @click="openEdit(emp)" class="text-indigo-600 hover:text-indigo-800 text-xs font-medium">Edit</button>
                <button @click="confirmDelete=emp" class="text-red-500 hover:text-red-700 text-xs font-medium">Delete</button>
              </div></td>
            </tr>
            <tr v-if="filteredEmployees.length===0"><td colspan="10" class="px-4 py-8 text-center text-gray-400">No employees</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </template>
  <employee-modal v-if="showModal" :employee="editingEmployee" :scenario-id="scenarioId" :scenario-is-base="scenarioIsBase"
    :departments="departments" @saved="onEmployeeSaved" @close="showModal = false"/>
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
