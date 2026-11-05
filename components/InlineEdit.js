// Click-to-edit value for table cells. With `options` it opens a dropdown, without it a text box.
// Emits `save` with the new value only when it changed; Escape cancels.
export default {
  name: 'InlineEdit',
  props: {
    value: { default: null },
    options: { type: Array, default: null }, // [{ value, label, group? }]
    display: { type: String, default: '' },
    placeholder: { type: String, default: 'Set...' },
    disabled: { type: Boolean, default: false },
    disabledTitle: { type: String, default: '' },
    inputClass: { type: String, default: '' },
  },
  emits: ['save'],
  setup(props, { emit }) {
    const { ref, nextTick, computed } = Vue;
    const editing = ref(false);
    const draft = ref('');
    const field = ref(null);

    const groups = computed(() => {
      if (!props.options) return [];
      const out = [];
      for (const o of props.options) {
        let g = out.find(x => x.name === (o.group || ''));
        if (!g) { g = { name: o.group || '', options: [] }; out.push(g); }
        g.options.push(o);
      }
      return out;
    });

    const start = async () => {
      if (props.disabled) return;
      draft.value = props.value ?? '';
      editing.value = true;
      await nextTick();
      field.value?.focus();
      if (!props.options) field.value?.select();
    };
    const commit = () => {
      if (!editing.value) return;
      editing.value = false;
      let v = draft.value;
      if (!props.options) v = String(v).trim();
      if (v === '' && !props.options) return; // never blank a text value by accident
      // <select> values are strings; compare loosely with the stored value
      if (String(v ?? '') !== String(props.value ?? '')) emit('save', v === '' ? null : v);
    };
    const cancel = () => { editing.value = false; };

    return { editing, draft, field, groups, start, commit, cancel };
  },
  template: `
    <span class="inline-block max-w-full" @click.stop>
      <template v-if="editing">
        <select v-if="options" ref="field" v-model="draft" @change="commit" @blur="commit" @keydown.esc.prevent="cancel"
          :class="['max-w-full px-2 py-1 text-sm border border-indigo-300 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500', inputClass]">
          <template v-for="g in groups" :key="g.name">
            <optgroup v-if="g.name" :label="g.name">
              <option v-for="o in g.options" :key="String(o.value)" :value="o.value ?? ''">{{ o.label }}</option>
            </optgroup>
            <template v-else>
              <option v-for="o in g.options" :key="String(o.value)" :value="o.value ?? ''">{{ o.label }}</option>
            </template>
          </template>
        </select>
        <input v-else ref="field" v-model="draft" @keydown.enter.prevent="commit" @keydown.esc.prevent="cancel" @blur="commit"
          :class="['w-full min-w-[8rem] px-2 py-1 text-sm border border-indigo-300 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500', inputClass]"/>
      </template>
      <button v-else type="button" data-value @click="start" :disabled="disabled"
        :title="disabled ? disabledTitle : 'Click to change'"
        :class="['text-left rounded px-1 -mx-1 max-w-full', disabled ? 'cursor-default' : 'hover:bg-indigo-50 hover:text-indigo-700 decoration-dotted decoration-gray-300 underline underline-offset-4']">
        <slot>{{ display || value }}</slot>
        <span v-if="!display && (value === null || value === '' || value === undefined)" class="text-gray-300">{{ placeholder }}</span>
      </button>
    </span>
  `,
};
