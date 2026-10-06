import { formatCents, formatPct } from '../js/utils.js';

export default {
  name: 'KpiCard',
  props: {
    title: String,
    value: [Number, String],
    format: { type: String, default: 'currency' },
    delta: Object,
    subtitle: String,
    color: { type: String, default: 'indigo' },
  },
  setup(props) {
    const { computed } = Vue;

    const displayValue = computed(() => {
      if (typeof props.value === 'string') return props.value;
      if (props.format === 'currency') return formatCents(props.value || 0);
      if (props.format === 'number') return (props.value || 0).toLocaleString();
      if (props.format === 'months') {
        const v = props.value || 0;
        if (v === Infinity || v > 999) return '∞';
        return `${v.toFixed(1)} mo`;
      }
      return String(props.value || 0);
    });

    const deltaDisplay = computed(() => {
      if (!props.delta) return null;
      const pctStr = props.delta.pct !== null && props.delta.pct !== undefined
        ? formatPct(props.delta.pct)
        : null;
      const positive = (props.delta.abs || 0) >= 0;
      return { pctStr, positive };
    });

    return { displayValue, deltaDisplay };
  },
  template: `
    <div class="bg-white rounded-xl border border-gray-200 p-5 hover:shadow-sm transition-shadow">
      <div class="flex items-center justify-between mb-1">
        <span class="text-xs font-medium text-gray-500 uppercase tracking-wider">{{ title }}</span>
        <span
          v-if="deltaDisplay"
          :class="[
            'text-xs font-medium px-2 py-0.5 rounded-full',
            deltaDisplay.positive ? 'bg-emerald-50 text-emerald-600' : 'bg-red-50 text-red-600'
          ]"
        >
          {{ deltaDisplay.positive ? '+' : '' }}{{ deltaDisplay.pctStr }}
        </span>
      </div>
      <div class="text-2xl font-bold text-gray-900 mt-2">{{ displayValue }}</div>
      <div v-if="subtitle" class="text-xs text-gray-400 mt-1">{{ subtitle }}</div>
    </div>
  `,
};
