export default {
  name: 'FormulaInput',
  props: {
    modelValue: String,
    variables: { type: Array, default: () => [] },
  },
  emits: ['update:modelValue'],
  setup(props, { emit }) {
    const { ref, computed } = Vue;
    const showSuggestions = ref(false);
    const inputRef = ref(null);

    const onInput = (e) => {
      emit('update:modelValue', e.target.value);
      showSuggestions.value = true;
    };

    const insertVariable = (v) => {
      const current = props.modelValue || '';
      emit('update:modelValue', current + v);
      showSuggestions.value = false;
      if (inputRef.value) inputRef.value.focus();
    };

    const filteredVars = computed(() => {
      const parts = (props.modelValue || '').split(/[\s+\-*/()]+/);
      const last = parts[parts.length - 1].toLowerCase();
      if (!last) return props.variables.slice(0, 10);
      return props.variables.filter(v => v.toLowerCase().includes(last)).slice(0, 10);
    });

    return { showSuggestions, inputRef, onInput, insertVariable, filteredVars };
  },
  template: `
    <div class="relative">
      <div class="flex items-center gap-2">
        <i data-lucide="function-square" class="w-4 h-4 text-indigo-400 flex-shrink-0"></i>
        <input
          ref="inputRef"
          :value="modelValue"
          @input="onInput"
          @focus="showSuggestions = true"
          @blur="setTimeout(() => showSuggestions = false, 200)"
          placeholder="e.g. customers.total * 15"
          class="flex-1 px-3 py-1.5 text-sm font-mono border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
        />
      </div>
      <div
        v-if="showSuggestions && filteredVars.length > 0"
        class="absolute z-10 mt-1 w-full bg-white border border-gray-200 rounded-lg shadow-lg max-h-48 overflow-y-auto"
      >
        <button
          v-for="v in filteredVars"
          :key="v"
          @mousedown.prevent="insertVariable(v)"
          class="w-full text-left px-3 py-1.5 text-sm font-mono hover:bg-indigo-50 text-gray-700"
        >
          {{ v }}
        </button>
      </div>
    </div>
  `,
};
