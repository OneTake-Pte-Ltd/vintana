import { hasCredentials, query } from './db.js';
import { checkSchema, getSettings, ensureSchemaUpgrades } from './schema.js';
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
import UpcomingChargesView from './views/UpcomingCharges.js';
import AssistantPanel from '../components/AssistantPanel.js';
import InlineEdit from '../components/InlineEdit.js';
import SettingsView from './views/Settings.js';

const routes = [
  { path: '/login', component: LoginView, meta: { public: true } },
  { path: '/', component: DashboardView },
  { path: '/expenses', component: ExpensesView },
  { path: '/upcoming', component: UpcomingChargesView },
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

    // Default: 12 months centred on the 1st of the current month (6 before, 6 from it).
    // A range picked by hand is remembered in this browser until reset.
    const RANGE_KEY = 'vintana_date_range';
    const defaultRange = () => ({ start: addMonths(currentMonth(), -6), end: addMonths(currentMonth(), 5) });
    const savedRange = () => {
      try {
        const r = JSON.parse(localStorage.getItem(RANGE_KEY) || 'null');
        if (r && /^\d{4}-\d{2}$/.test(r.start) && /^\d{4}-\d{2}$/.test(r.end)) return r;
      } catch { /* storage unavailable */ }
      return null;
    };
    const dateRange = ref(savedRange() || defaultRange());
    const rangeIsCustom = ref(!!savedRange());

    const setRange = (field, value) => {
      if (!/^\d{4}-\d{2}$/.test(value || '')) return;
      dateRange.value = { ...dateRange.value, [field]: value };
      rangeIsCustom.value = true;
      try { localStorage.setItem(RANGE_KEY, JSON.stringify(dateRange.value)); } catch { /* storage unavailable */ }
    };
    const resetRange = () => {
      dateRange.value = defaultRange();
      rangeIsCustom.value = false;
      try { localStorage.removeItem(RANGE_KEY); } catch { /* storage unavailable */ }
    };

    const isLoggedIn = computed(() => {
      // Read route.path first so Vue tracks it even while credentials are missing
      return route.path !== '/login' && hasCredentials();
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
    provide('loadSettings', loadSettings);

    const loadAppData = async () => {
      try {
        const ok = await checkSchema();
        if (ok) {
          // Read-only tokens can't upgrade the schema; the app works without the additions
          await ensureSchemaUpgrades().catch(() => {});
          await Promise.all([loadScenarios(), loadSettings()]);
        }
      } catch {
        // will redirect to login via router guard
      }
    };

    onMounted(async () => {
      if (hasCredentials()) await loadAppData();
      await nextTick();
      if (window.lucide) lucide.createIcons();
    });

    // Leaving the login screen means credentials (and possibly a fresh schema) were just set up
    watch(isLoggedIn, async (loggedIn, wasLoggedIn) => {
      if (loggedIn && !wasLoggedIn) await loadAppData();
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
      dateRange, rangeIsCustom, setRange, resetRange, isLoggedIn, companyName, toasts, toast,
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
app.component('assistant-panel', AssistantPanel);
app.component('inline-edit', InlineEdit);

app.use(router);
app.mount('#app');
