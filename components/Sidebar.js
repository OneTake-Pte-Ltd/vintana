export default {
  name: 'AppSidebar',
  props: {
    collapsed: { type: Boolean, default: false },
    // Phones: the sidebar is an off-canvas drawer shown over the page
    mobile: { type: Boolean, default: false },
    open: { type: Boolean, default: false },
  },
  emits: ['toggle', 'close'],
  setup(props, { emit }) {
    const { ref, computed } = Vue;
    const route = VueRouter.useRoute();
    const router = VueRouter.useRouter();

    const items = [
      { icon: 'layout-dashboard', label: 'Dashboard', path: '/' },
      { icon: 'receipt', label: 'Expenses', path: '/expenses' },
      { icon: 'calendar-clock', label: 'Upcoming Charges', path: '/upcoming' },
      { icon: 'trending-up', label: 'Revenue', path: '/revenue' },
      { icon: 'users', label: 'Payroll', path: '/payroll' },
      { icon: 'file-spreadsheet', label: 'P&L', path: '/pnl' },
      { icon: 'wallet', label: 'Cash Flow', path: '/cashflow' },
      { icon: 'landmark', label: 'Bank Statements', path: '/statements' },
      { icon: 'git-branch', label: 'Scenarios', path: '/scenarios' },
      { icon: 'settings', label: 'Settings', path: '/settings' },
    ];

    const isActive = (path) => {
      if (path === '/') return route.path === '/';
      return route.path.startsWith(path);
    };

    // On phones the drawer always shows labels; collapsing only applies on wider screens
    const showLabels = computed(() => props.mobile || !props.collapsed);

    return { items, isActive, emit, props, showLabels };
  },
  template: `
    <div>
      <transition name="fade">
        <div v-if="props.mobile && props.open" class="fixed inset-0 bg-gray-900/50 z-40" @click="emit('close')"></div>
      </transition>
      <aside
        :class="[
          'fixed left-0 top-0 h-full bg-gray-900 text-gray-300 z-50 transition-all duration-200 flex flex-col',
          props.mobile
            ? ['w-64 shadow-xl', props.open ? 'translate-x-0' : '-translate-x-full']
            : (props.collapsed ? 'w-16' : 'w-56')
        ]"
        :aria-hidden="props.mobile && !props.open ? 'true' : null"
      >
        <div class="flex items-center h-14 px-4 border-b border-gray-800">
          <button v-if="props.mobile" @click="emit('close')" class="text-gray-400 hover:text-white" aria-label="Close menu">
            <i data-lucide="x" class="w-5 h-5"></i>
          </button>
          <button v-else @click="emit('toggle')" class="text-gray-400 hover:text-white" :aria-label="props.collapsed ? 'Expand menu' : 'Collapse menu'">
            <i :data-lucide="props.collapsed ? 'menu' : 'panel-left-close'" class="w-5 h-5"></i>
          </button>
          <span v-if="showLabels" class="ml-3 font-semibold text-white text-sm tracking-wide">Vintana</span>
        </div>
        <nav class="flex-1 py-3 overflow-y-auto">
          <router-link
            v-for="item in items"
            :key="item.path"
            :to="item.path"
            :title="showLabels ? null : item.label"
            :class="[
              'flex items-center px-4 py-2.5 mx-2 rounded-lg text-sm transition-colors',
              isActive(item.path)
                ? 'bg-indigo-600/20 text-indigo-300'
                : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'
            ]"
          >
            <i :data-lucide="item.icon" class="w-5 h-5 flex-shrink-0"></i>
            <span v-if="showLabels" class="ml-3">{{ item.label }}</span>
          </router-link>
        </nav>
      </aside>
    </div>
  `,
};
