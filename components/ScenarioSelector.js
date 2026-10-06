export default {
  name: 'ScenarioSelector',
  props: {
    scenarios: { type: Array, default: () => [] },
    modelValue: { type: Number, default: null },
  },
  emits: ['update:modelValue'],
  setup(props, { emit }) {
    const onChange = (e) => emit('update:modelValue', parseInt(e.target.value));
    return { onChange };
  },
  template: `
    <div class="flex items-center gap-2">
      <i data-lucide="git-branch" class="w-4 h-4 text-gray-400"></i>
      <select
        :value="modelValue"
        @change="onChange"
        class="text-sm border border-gray-200 rounded-lg px-3 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
      >
        <option v-for="s in scenarios" :key="s.id" :value="s.id">
          {{ s.name }}{{ s.is_base ? ' (Base)' : '' }}
        </option>
      </select>
    </div>
  `,
};
