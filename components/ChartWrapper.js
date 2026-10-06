export default {
  name: 'ChartWrapper',
  props: {
    type: { type: String, required: true },
    data: { type: Object, required: true },
    options: { type: Object, default: () => ({}) },
    height: { type: String, default: '300px' },
  },
  setup(props) {
    const { ref, onMounted, onBeforeUnmount, watch } = Vue;
    const canvasRef = ref(null);
    let chart = null;

    const createChart = () => {
      if (chart) chart.destroy();
      if (!canvasRef.value) return;
      const ctx = canvasRef.value.getContext('2d');
      chart = new Chart(ctx, {
        type: props.type,
        data: JSON.parse(JSON.stringify(props.data)),
        options: {
          responsive: true,
          maintainAspectRatio: false,
          ...props.options,
        },
      });
    };

    onMounted(() => createChart());
    onBeforeUnmount(() => { if (chart) chart.destroy(); });

    watch(
      () => [props.data, props.type, props.options],
      () => createChart(),
      { deep: true }
    );

    return { canvasRef };
  },
  template: `
    <div :style="{ height }">
      <canvas ref="canvasRef"></canvas>
    </div>
  `,
};
