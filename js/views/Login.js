import { setCredentials, testConnection } from '../db.js';
import { checkSchema, runMigrations } from '../schema.js';

export default {
  name: 'LoginView',
  setup() {
    const { ref } = Vue;
    const router = VueRouter.useRouter();

    const dbUrl = ref('');
    const dbToken = ref('');
    const error = ref('');
    const loading = ref(false);

    const connect = async () => {
      error.value = '';
      if (!dbUrl.value || !dbToken.value) {
        error.value = 'Both fields are required.';
        return;
      }
      loading.value = true;
      try {
        setCredentials(dbUrl.value.trim(), dbToken.value.trim());
        await testConnection();
        const hasSchema = await checkSchema();
        if (!hasSchema) {
          await runMigrations();
        }
        router.push('/');
      } catch (e) {
        error.value = `Connection failed: ${e.message}`;
      } finally {
        loading.value = false;
      }
    };

    return { dbUrl, dbToken, error, loading, connect };
  },
  template: `
    <div class="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div class="w-full max-w-md">
        <div class="text-center mb-8">
          <div class="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-indigo-600 text-white mb-4">
            <i data-lucide="bar-chart-3" class="w-7 h-7"></i>
          </div>
          <h1 class="text-2xl font-bold text-gray-900">Vintana</h1>
          <p class="text-sm text-gray-500 mt-1">Financial Planning</p>
        </div>
        <form @submit.prevent="connect" class="bg-white rounded-2xl border border-gray-200 p-8 shadow-sm">
          <h2 class="text-lg font-semibold text-gray-900 mb-6">Connect to Database</h2>
          <div class="space-y-4">
            <div>
              <label class="block text-sm font-medium text-gray-700 mb-1">Database URL</label>
              <input
                v-model="dbUrl"
                type="url"
                placeholder="https://abc123.lite.bunnydb.net"
                class="w-full px-4 py-2.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                :disabled="loading"
              />
            </div>
            <div>
              <label class="block text-sm font-medium text-gray-700 mb-1">Access Token</label>
              <input
                v-model="dbToken"
                type="password"
                placeholder="bdb_tok_xxxxxxxxxxxx"
                class="w-full px-4 py-2.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                :disabled="loading"
              />
            </div>
          </div>
          <div v-if="error" class="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-600">
            {{ error }}
          </div>
          <button
            type="submit"
            :disabled="loading"
            class="w-full mt-6 px-4 py-2.5 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 transition-colors disabled:opacity-50"
          >
            {{ loading ? 'Connecting...' : 'Connect' }}
          </button>
        </form>
        <p class="text-center text-xs text-gray-400 mt-6">
          Data stored in your own Bunny Database instance.
        </p>
      </div>
    </div>
  `,
};
