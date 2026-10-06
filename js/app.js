import { hasCredentials, query } from './db.js';
import { checkSchema, getSettings, getBaseScenarioId } from './schema.js';
import { currentMonth, addMonths } from './utils.js';

import Sidebar from '../components/Sidebar.js';
import KpiCard from '../components/KpiCard.js';
import DataTable from '../components/DataTable.js';
import MonthPicker from '../components/MonthPicker.js';
import ScenarioSelector from '../components/ScenarioSelector.js';
import ChartWrapper from '../components/ChartWrapper.js';
import FormulaInput from '../components/FormulaInput.js';

import LoginView from './views/Login.js';
import DashboardView from './views/Dashboard.js';
import ExpensesView from './views/Expenses.js';
import RevenueView from './views/Revenue.js';
import PayrollView from './views/Payroll.js';
import ProfitLossView from './views/ProfitLoss.js';
import CashFlowView from './views/CashFlow.js';
import ScenariosView from './views/Scenarios.js';
import SettingsView from './views/Settings.js';

const routes = [
  { path: '/login', component: LoginView, meta: { public: true } },
  { path: '/', component: DashboardView },
  { path: '/expenses', component: ExpensesView },
  { path: '/revenue', component: RevenueView },
  { path: '/payroll', component: PayrollView },
  { path: '/pnl', component: ProfitLossView },
  { path: '/cashflow', component: CashFlowView },
  { path: '/scenarios', component: ScenariosView },
  { path: '/settings', component: SettingsView },
];

const router = VueRouter.createRouter({
  history: VueRouter.createWebHashHistory(),
  routes,
});

router.beforeEach(async (to) => {
  if (to.meta.public) return true;
  if (!hasCredentials()) return '/login';
  return true;
});

const app = Vue.createApp({
  setup() {
    const { ref, computed, provide, onMounted, watch, nextTick } = Vue;
    const route = VueRouter.useRoute();

    const sidebarCollapsed = ref(false);
    const scenarioId = ref(null);
    const scenarios = ref([]);
    const settings = ref(null);
    const toasts = ref([]);
    let toastCounter = 0;

    const dateRange = ref({
      start: addMonths(currentMonth(), -11),
      end: addMonths(currentMonth(), 12),
    });

    const isLoggedIn = computed(() => {
      return hasCredentials() && route.path !== '/login';
    });

    const companyName = computed(() => settings.value?.company_name || 'Vintana');

    const toast = (message, type = 'success') => {
      const id = ++toastCounter;
      toasts.value.push({ id, message, type });
      setTimeout(() => {
        toasts.value = toasts.value.filter(t => t.id !== id);
      }, 3000);
    };

    const loadScenarios = async () => {
      try {
        scenarios.value = await query('SELECT * FROM scenarios ORDER BY is_base DESC, name');
        if (!scenarioId.value && scenarios.value.length > 0) {
          const base = scenarios.value.find(s => s.is_base);
          scenarioId.value = base ? base.id : scenarios.value[0].id;
        }
      } catch {
        scenarios.value = [];
      }
    };

    const loadSettings = async () => {
      try {
        settings.value = await getSettings();
      } catch {
        settings.value = null;
      }
    };

    provide('scenarioId', Vue.computed(() => scenarioId.value));
    provide('scenarios', scenarios);
    provide('dateRange', dateRange);
    provide('settings', Vue.computed(() => settings.value));
    provide('toast', toast);
    provide('loadScenarios', loadScenarios);

    onMounted(async () => {
      if (hasCredentials()) {
        try {
          const ok = await checkSchema();
          if (ok) {
            await Promise.all([loadScenarios(), loadSettings()]);
          }
        } catch {
          // will redirect to login via router guard
        }
      }
      await nextTick();
      if (window.lucide) lucide.createIcons();
    });

    watch(route, async () => {
      await nextTick();
      if (window.lucide) lucide.createIcons();
    });

    watch([scenarioId, () => dateRange.value.start, () => dateRange.value.end], async () => {
      await nextTick();
      if (window.lucide) lucide.createIcons();
    });

    return {
      sidebarCollapsed, scenarioId, scenarios, settings,
      dateRange, isLoggedIn, companyName, toasts, toast,
    };
  },
});

app.component('app-sidebar', Sidebar);
app.component('kpi-card', KpiCard);
app.component('data-table', DataTable);
app.component('month-picker', MonthPicker);
app.component('scenario-selector', ScenarioSelector);
app.component('chart-wrapper', ChartWrapper);
app.component('formula-input', FormulaInput);

app.use(router);
app.mount('#app');
