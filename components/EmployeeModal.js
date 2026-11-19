import { execute } from '../js/db.js';
import { updateSettings } from '../js/schema.js';
import { getReportingCurrency } from '../js/utils.js';
import { loadCategoryLookups } from '../js/expenses.js';
import { DEFAULT_DEPT_MAPPING } from '../js/payroll.js';
import { recomputeComputedExpenses } from '../js/budget.js';

const INPUT = 'w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500';
const NEW_DEPT = '__new__';

// Add or edit an employee. Used by the Payroll and Bank Statements pages.
// `employee` null = add, to the base employees when `scenarioIsBase`, else as an employee of `scenarioId` only.
// `prefill` sets fields of a new employee (e.g. from a bank statement line). A new department can be added here, with
// the P&L category its payroll is counted in (saved to the department mapping in Settings).
// Emits `saved` after a change, `created` with a new base employee's id, and `close` when dismissed.
export default {
  name: 'EmployeeModal',
  props: {
    employee: { type: Object, default: null },
    scenarioId: { type: Number, default: null },
    scenarioIsBase: { type: Boolean, default: true },
    departments: { type: Array, default: () => [] },
    prefill: { type: Object, default: null },
  },
  emits: ['close', 'saved', 'created'],
  setup(props, { emit }) {
    const { ref, computed, inject, onMounted } = Vue;
    const toast = inject('toast');
    const settings = inject('settings');
    const loadSettings = inject('loadSettings', null);

    const emp = props.employee;
    const form = ref(emp
      ? { name: emp.name, role: emp.role || '', department: emp.department || '',
          salary_eur: (emp.salary_monthly / 100).toFixed(2), tax_pct: emp.tax_pct || 0,
          start_date: emp.start_date, end_date: emp.end_date || '', notes: emp.notes || '', charge_label: emp.charge_label || '' }
      : { name: '', role: '', department: '', salary_eur: '', tax_pct: 0, start_date: '', end_date: '', notes: '', charge_label: '',
          ...(props.prefill || {}) });
    const saving = ref(false);
    const currency = computed(() => getReportingCurrency());

    // Departments: those in use, those mapped in Settings (or the default mapping), and the employee's own
    const mapping = computed(() => {
      const m = settings.value?.dept_mapping || {};
      return Object.keys(m).length ? m : DEFAULT_DEPT_MAPPING;
    });
    const deptOptions = computed(() => [...new Set([...props.departments, ...Object.keys(mapping.value), form.value.department]
      .filter(Boolean))].sort((a, b) => a.localeCompare(b)));

    // A new department and the P&L category its payroll goes to
    const newDept = ref(null); // { name, category } while one is being added
    const categoryNames = ref([]);
    onMounted(async () => {
      try { categoryNames.value = (await loadCategoryLookups()).categories.map(c => c.name); } catch { categoryNames.value = []; }
    });
    const onDeptSelect = e => {
      if (e.target.value === NEW_DEPT) {
        e.target.value = form.value.department;
        newDept.value = { name: '', category: categoryNames.value.find(n => n.startsWith('General')) || categoryNames.value[0] || '' };
        return;
      }
      newDept.value = null;
      form.value.department = e.target.value;
    };

    const canEditChargeLabel = computed(() => (emp ? emp._source !== 'scenario' : props.scenarioIsBase));

    const save = async () => {
      const f = form.value;
      const dept = newDept.value ? newDept.value.name.trim() : f.department;
      if (newDept.value && !dept) { toast('Name the new department', 'error'); return; }
      if (!f.name || !f.start_date || !f.salary_eur) { toast('Name, salary and start date are required', 'error'); return; }
      if (f.end_date && f.end_date.slice(0, 7) < f.start_date.slice(0, 7)) { toast('The end date is before the start date', 'error'); return; }
      const cents = Math.round(parseFloat(f.salary_eur) * 100);
      if (isNaN(cents) || cents < 0) { toast('Invalid salary', 'error'); return; }
      const end = f.end_date || null;
      saving.value = true;
      try {
        // The new department's P&L category, added to the mapping (which starts from the defaults when none is saved)
        if (newDept.value && newDept.value.category && mapping.value[dept] !== newDept.value.category) {
          await updateSettings({ dept_mapping: { ...mapping.value, [dept]: newDept.value.category } });
          await loadSettings?.();
        }
        if (emp) {
          if (emp._source === 'scenario') {
            await execute('UPDATE scenario_employees SET name=?,role=?,department=?,salary_monthly=?,tax_pct=?,start_date=?,end_date=?,notes=? WHERE id=?',
              [f.name, f.role, dept, cents, f.tax_pct, f.start_date, end, f.notes, emp._scenarioEmployeeId]);
          } else if (!props.scenarioIsBase) {
            await execute('INSERT OR REPLACE INTO employee_overrides (employee_id,scenario_id,salary_monthly,tax_pct,start_date,end_date) VALUES (?,?,?,?,?,?)',
              [emp.id, props.scenarioId, cents, f.tax_pct, f.start_date, end]);
            // The charge label is how bank statements name the person: the same in every scenario
            await execute('UPDATE employees SET charge_label=? WHERE id=?', [f.charge_label || null, emp.id]);
          } else {
            await execute('UPDATE employees SET name=?,role=?,department=?,salary_monthly=?,tax_pct=?,start_date=?,end_date=?,notes=?,charge_label=? WHERE id=?',
              [f.name, f.role, dept, cents, f.tax_pct, f.start_date, end, f.notes, f.charge_label || null, emp.id]);
          }
          toast('Employee updated', 'success');
        } else if (props.scenarioIsBase) {
          const res = await execute('INSERT INTO employees (name,role,department,salary_monthly,tax_pct,start_date,end_date,notes,charge_label) VALUES (?,?,?,?,?,?,?,?,?)',
            [f.name, f.role, dept, cents, f.tax_pct, f.start_date, end, f.notes, f.charge_label || null]);
          if (res.lastInsertRowid) emit('created', res.lastInsertRowid);
          toast('Employee added', 'success');
        } else {
          await execute('INSERT INTO scenario_employees (scenario_id,name,role,department,salary_monthly,tax_pct,start_date,end_date,notes) VALUES (?,?,?,?,?,?,?,?,?)',
            [props.scenarioId, f.name, f.role, dept, cents, f.tax_pct, f.start_date, end, f.notes]);
          toast('Employee added', 'success');
        }
        recomputeComputedExpenses().catch(() => 0); // formulas can use headcount.total and payroll.total
        emit('saved');
        emit('close');
      } catch (e) {
        toast('Save failed: ' + e.message, 'error');
      } finally {
        saving.value = false;
      }
    };

    return { INPUT, NEW_DEPT, form, saving, currency, deptOptions, newDept, categoryNames, onDeptSelect, canEditChargeLabel, save, emit, employee: emp };
  },
  template: `
  <div class="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" @click.self="emit('close')" @keydown.esc="emit('close')">
    <div class="bg-white rounded-xl w-full max-w-lg max-h-[90vh] overflow-y-auto p-6" role="dialog" aria-modal="true">
      <h3 class="text-lg font-semibold text-gray-900 mb-4">{{ employee ? 'Edit Employee' : 'Add Employee' }}</h3>
      <div class="space-y-4">
        <div class="grid grid-cols-2 gap-4">
          <div><label class="block text-xs font-medium text-gray-500 mb-1">Name *</label><input v-model="form.name" type="text" :class="INPUT"/></div>
          <div><label class="block text-xs font-medium text-gray-500 mb-1">Role</label><input v-model="form.role" type="text" :class="INPUT"/></div>
        </div>
        <div>
          <label class="block text-xs font-medium text-gray-500 mb-1">Department</label>
          <select :value="newDept ? NEW_DEPT : form.department" @change="onDeptSelect" :class="INPUT" aria-label="Department">
            <option value="">None</option>
            <option v-for="d in deptOptions" :key="d" :value="d">{{ d }}</option>
            <option :value="NEW_DEPT">+ New department...</option>
          </select>
          <div v-if="newDept" class="mt-2 rounded-lg border border-indigo-200 bg-indigo-50/50 p-3 grid grid-cols-2 gap-3">
            <div><label class="block text-xs font-medium text-gray-700 mb-1">New department</label>
              <input v-model="newDept.name" :class="INPUT" placeholder="e.g. Customer Success" aria-label="New department name"/></div>
            <div><label class="block text-xs font-medium text-gray-700 mb-1">Payroll counted in</label>
              <select v-model="newDept.category" :class="INPUT" aria-label="P&L category for this department">
                <option v-for="c in categoryNames" :key="c" :value="c">{{ c }}</option>
              </select></div>
            <p class="col-span-2 text-[11px] text-gray-500">Added to the department mapping in Settings when you save.</p>
          </div>
        </div>
        <div class="grid grid-cols-2 gap-4">
          <div><label class="block text-xs font-medium text-gray-500 mb-1">Monthly Salary ({{ currency }}) *</label><input v-model="form.salary_eur" type="number" step="0.01" min="0" :class="INPUT"/></div>
          <div><label class="block text-xs font-medium text-gray-500 mb-1">Tax % (employer)</label><input v-model.number="form.tax_pct" type="number" step="0.1" min="0" :class="INPUT"/></div>
        </div>
        <div class="grid grid-cols-2 gap-4">
          <div><label class="block text-xs font-medium text-gray-500 mb-1">Start Date *</label><month-picker v-model="form.start_date" block aria-label="Start date"/></div>
          <div><label class="block text-xs font-medium text-gray-500 mb-1">End Date</label><month-picker v-model="form.end_date" block clearable placeholder="Still employed" aria-label="End date"/></div>
        </div>
        <div v-if="canEditChargeLabel">
          <label class="block text-xs font-medium text-gray-500 mb-1">Charge label</label>
          <input v-model="form.charge_label" :class="INPUT" placeholder="As payments to this person appear on the bank statement"/>
          <p class="text-[11px] text-gray-400 mt-1">Used to recognise payments to this person when reading bank statements.</p>
        </div>
        <div><label class="block text-xs font-medium text-gray-500 mb-1">Notes</label><textarea v-model="form.notes" rows="2" :class="INPUT"></textarea></div>
      </div>
      <div class="flex justify-end gap-3 mt-6">
        <button @click="emit('close')" class="px-4 py-2 text-sm border border-gray-200 rounded-lg hover:bg-gray-50">Cancel</button>
        <button @click="save" :disabled="saving" class="px-4 py-2 text-sm font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-50">
          {{ saving ? 'Saving...' : employee ? 'Save Changes' : 'Add Employee' }}
        </button>
      </div>
    </div>
  </div>`,
};
