export default {
  name: 'DataTable',
  props: {
    columns: { type: Array, required: true },
    rows: { type: Array, required: true },
    searchable: { type: Boolean, default: false },
    searchFields: { type: Array, default: () => [] },
    emptyText: { type: String, default: 'No data' },
  },
  emits: ['row-click'],
  setup(props, { emit }) {
    const { ref, computed } = Vue;
    const searchQuery = ref('');

    const filteredRows = computed(() => {
      if (!searchQuery.value || !props.searchable) return props.rows;
      const q = searchQuery.value.toLowerCase();
      return props.rows.filter(row => {
        const fields = props.searchFields.length > 0
          ? props.searchFields
          : Object.keys(row);
        return fields.some(f => {
          const v = row[f];
          return v && String(v).toLowerCase().includes(q);
        });
      });
    });

    return { searchQuery, filteredRows, emit };
  },
  template: `
    <div>
      <div v-if="searchable" class="mb-4">
        <div class="relative">
          <i data-lucide="search" class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400"></i>
          <input
            v-model="searchQuery"
            type="text"
            placeholder="Search..."
            class="w-full pl-10 pr-4 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
          />
        </div>
      </div>
      <div class="overflow-x-auto rounded-lg border border-gray-200">
        <table class="w-full text-sm">
          <thead>
            <tr class="bg-gray-50 border-b border-gray-200">
              <th
                v-for="col in columns"
                :key="col.key"
                :class="['px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider', col.class || '']"
                :style="col.width ? { width: col.width } : {}"
              >
                {{ col.label }}
              </th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-100">
            <tr
              v-for="(row, idx) in filteredRows"
              :key="row.id || idx"
              class="hover:bg-gray-50 transition-colors cursor-pointer"
              @click="emit('row-click', row)"
            >
              <td
                v-for="col in columns"
                :key="col.key"
                :class="['px-4 py-3', col.cellClass || '']"
              >
                <slot :name="'cell-' + col.key" :row="row" :value="row[col.key]">
                  {{ row[col.key] }}
                </slot>
              </td>
            </tr>
            <tr v-if="filteredRows.length === 0">
              <td :colspan="columns.length" class="px-4 py-8 text-center text-gray-400">
                {{ emptyText }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  `,
};
