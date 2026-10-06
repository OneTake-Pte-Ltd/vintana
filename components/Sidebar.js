export default {
  name: 'AppSidebar',
  props: {
    collapsed: { type: Boolean, default: false },
  },
  emits: ['toggle'],
  setup(props, { emit }) {
    const { ref, computed } = Vue;
    const route = VueRouter.useRoute();
    const router = VueRouter.useRouter();

    const items = [
      { icon: 'layout-dashboard', label: 'Dashboard', path: '/' },
      { icon: 'receipt', label: 'Expenses', path: '/expenses' },
      { icon: 'trending-up', label: 'Revenue', path: '/revenue' },
      { icon: 'users', label: 'Payroll', path: '/payroll' },
      { icon: 'file-spreadsheet', label: 'P&L', path: '/pnl' },
      { icon: 'wallet', label: 'Cash Flow', path: '/cashflow' },
      { icon: 'git-branch', label: 'Scenarios', path: '/scenarios' },
      { icon: 'settings', label: 'Settings', path: '/settings' },
    ];

    const isActive = (path) => {
      if (path === '/') return route.path === '/';
      return route.path.startsWith(path);
    };

    return { items, isActive, emit, props };
  },
  template: `
    <aside
      :class="[
        'fixed left-0 top-0 h-full bg-gray-900 text-gray-300 z-40 transition-all duration-200 flex flex-col',
        props.collapsed ? 'w-16' : 'w-56'
      ]"
    >
      <div class="flex items-center h-14 px-4 border-b border-gray-800">
        <button @click="emit('toggle')" class="text-gray-400 hover:text-white">
          <i :data-lucide="props.collapsed ? 'menu' : 'panel-left-close'" class="w-5 h-5"></i>
        </button>
        <span v-if="!props.collapsed" class="ml-3 font-semibold text-white text-sm tracking-wide">Vintana</span>
      </div>
      <nav class="flex-1 py-3 overflow-y-auto">
        <router-link
          v-for="item in items"
          :key="item.path"
          :to="item.path"
          :class="[
            'flex items-center px-4 py-2.5 mx-2 rounded-lg text-sm transition-colors',
            isActive(item.path)
              ? 'bg-indigo-600/20 text-indigo-300'
              : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'
          ]"
        >
          <i :data-lucide="item.icon" class="w-5 h-5 flex-shrink-0"></i>
          <span v-if="!props.collapsed" class="ml-3">{{ item.label }}</span>
        </router-link>
      </nav>
    </aside>
  `,
};
