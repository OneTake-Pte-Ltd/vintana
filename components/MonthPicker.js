import { monthLabelFull } from '../js/utils.js';

export default {
  name: 'MonthPicker',
  props: {
    modelValue: String,
    label: String,
  },
  emits: ['update:modelValue'],
  setup(props, { emit }) {
    const { computed } = Vue;
    const displayValue = computed(() => props.modelValue ? monthLabelFull(props.modelValue) : '');
    const onInput = (e) => emit('update:modelValue', e.target.value);
    return { displayValue, onInput };
  },
  template: `
    <div>
      <label v-if="label" class="block text-xs font-medium text-gray-500 mb-1">{{ label }}</label>
      <input
        type="month"
        :value="modelValue"
        @input="onInput"
        class="px-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent bg-white"
      />
    </div>
  `,
};
