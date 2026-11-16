// Month picker: a button showing the month, opening a popup with the year (arrows) and a grid of 12 months.
// Works the same in every browser (an <input type="month"> is a plain text box in Firefox and desktop Safari).
// v-model holds "YYYY-MM"; a "YYYY-MM-DD" value is read as its month. clearable adds a Clear button (value '').
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export default {
  name: 'MonthPicker',
  props: {
    modelValue: String,
    label: String,
    placeholder: { type: String, default: 'Choose a month' },
    clearable: { type: Boolean, default: false },
    block: { type: Boolean, default: false }, // full width, like the form inputs
    ariaLabel: String,
  },
  emits: ['update:modelValue'],
  setup(props, { emit }) {
    const { ref, computed, onBeforeUnmount } = Vue;
    const open = ref(false);
    const root = ref(null);
    const month = computed(() => (/^\d{4}-\d{2}/.test(props.modelValue || '') ? props.modelValue.slice(0, 7) : ''));
    const now = new Date();
    const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const year = ref(now.getFullYear());
    const display = computed(() => {
      if (!month.value) return '';
      const [y, m] = month.value.split('-').map(Number);
      return `${MONTHS[m - 1]} ${y}`;
    });

    const onOutside = e => { if (root.value && !root.value.contains(e.target)) close(); };
    const close = () => { open.value = false; document.removeEventListener('mousedown', onOutside); };
    const toggle = () => {
      if (open.value) return close();
      year.value = month.value ? Number(month.value.slice(0, 4)) : now.getFullYear();
      open.value = true;
      document.addEventListener('mousedown', onOutside);
    };
    onBeforeUnmount(() => document.removeEventListener('mousedown', onOutside));

    const key = i => `${year.value}-${String(i + 1).padStart(2, '0')}`;
    const pick = i => { emit('update:modelValue', key(i)); close(); };
    const clear = () => { emit('update:modelValue', ''); close(); };
    const today = () => { emit('update:modelValue', thisMonth); close(); };

    return { MONTHS, open, root, year, month, display, thisMonth, toggle, close, key, pick, clear, today };
  },
  template: `
    <div ref="root" class="relative" :class="block ? 'w-full' : ''" @keydown.esc="close">
      <label v-if="label" class="block text-xs font-medium text-gray-500 mb-1">{{ label }}</label>
      <button type="button" @click="toggle" :aria-label="ariaLabel || label || 'Month'" :aria-expanded="open" aria-haspopup="dialog"
        :class="['inline-flex items-center justify-between gap-2 text-sm border border-gray-200 rounded-lg bg-white text-left focus:outline-none focus:ring-2 focus:ring-indigo-500',
          block ? 'w-full px-3 py-2' : 'w-[9.5rem] md:w-auto px-2 md:px-3 py-1.5']">
        <span :class="display ? 'text-gray-900' : 'text-gray-400'">{{ display || placeholder }}</span>
        <svg class="w-4 h-4 text-gray-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
          <rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>
      </button>
      <div v-if="open" role="dialog" aria-label="Choose a month"
        class="absolute z-50 mt-1 w-60 rounded-xl border border-gray-200 bg-white p-3 shadow-lg">
        <div class="flex items-center justify-between mb-2">
          <button type="button" @click="year--" class="p-1 rounded hover:bg-gray-100 text-gray-600" aria-label="Previous year">
            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>
          </button>
          <span class="text-sm font-semibold text-gray-900 tabular-nums">{{ year }}</span>
          <button type="button" @click="year++" class="p-1 rounded hover:bg-gray-100 text-gray-600" aria-label="Next year">
            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M9 18l6-6-6-6"/></svg>
          </button>
        </div>
        <div class="grid grid-cols-3 gap-1">
          <button v-for="(m, i) in MONTHS" :key="m" type="button" @click="pick(i)" :aria-pressed="key(i) === month"
            :class="['px-2 py-1.5 text-sm rounded-md',
              key(i) === month ? 'bg-indigo-600 text-white' : key(i) === thisMonth ? 'text-indigo-700 ring-1 ring-indigo-200 hover:bg-indigo-50' : 'text-gray-700 hover:bg-gray-100']">
            {{ m }}
          </button>
        </div>
        <div class="flex items-center justify-between mt-2 pt-2 border-t border-gray-100 text-xs">
          <button type="button" @click="today" class="text-indigo-600 hover:text-indigo-800">This month</button>
          <button v-if="clearable" type="button" @click="clear" class="text-gray-500 hover:text-gray-800">Clear</button>
        </div>
      </div>
    </div>
  `,
};
