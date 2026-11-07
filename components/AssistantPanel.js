import { getCredentials } from '../js/db.js';
import { formatCents, monthLabelFull } from '../js/utils.js';
import { loadHeadlineMetrics } from '../js/metrics.js';
import {
  assistantChoice, DEFAULT_RELAY_URL,
  snapshotPage, hashText, streamChat, renderMarkdown,
} from '../js/assistant.js';

const EXAMPLES = [
  'What stands out on this page?',
  'What is driving our burn this month?',
  'Where could we save money without slowing growth?',
];

export default {
  name: 'AssistantPanel',
  setup() {
    const { ref, reactive, computed, inject, nextTick, watch, onMounted, onBeforeUnmount } = Vue;
    const route = VueRouter.useRoute();
    const settings = inject('settings');
    const scenarioId = inject('scenarioId');
    const scenarios = inject('scenarios');
    const dateRange = inject('dateRange');

    const open = ref(false);
    const input = ref('');
    const busy = ref(false);
    const scrollEl = ref(null);
    const inputEl = ref(null);
    let controller = null;

    // One conversation per page, kept while the app is open
    const conversations = reactive({});
    const convo = computed(() => {
      const key = route.path;
      if (!conversations[key]) conversations[key] = { system: null, messages: [], display: [], lastSnapshot: null };
      return conversations[key];
    });

    const choice = computed(() => assistantChoice(settings.value));
    const modelLabel = computed(() => choice.value.model || 'No model chosen');
    const relayUrl = computed(() => settings.value?.assistant_relay_url || DEFAULT_RELAY_URL);
    const scenarioName = computed(() => scenarios.value.find(s => s.id === scenarioId.value)?.name || 'Base');
    const pageTitle = () => (document.querySelector('main h1')?.textContent.trim() || 'this page').replace(/"/g, "'");

    const scrollDown = async () => { await nextTick(); if (scrollEl.value) scrollEl.value.scrollTop = scrollEl.value.scrollHeight; };

    const toggle = async () => {
      open.value = !open.value;
      if (open.value) { await nextTick(); inputEl.value?.focus(); scrollDown(); }
    };
    const onKey = e => { if (e.key === 'Escape' && open.value) open.value = false; };
    onMounted(() => window.addEventListener('keydown', onKey));
    onBeforeUnmount(() => window.removeEventListener('keydown', onKey));

    const reset = () => {
      if (busy.value) return;
      conversations[route.path] = { system: null, messages: [], display: [], lastSnapshot: null };
    };

    const buildSystem = async () => {
      const s = settings.value || {};
      const cur = s.currency || 'EUR';
      const money = c => formatCents(c, cur);
      let numbers;
      try {
        const m = await loadHeadlineMetrics(scenarioId.value);
        numbers = [
          `Headline numbers for ${monthLabelFull(m.month)}, scenario "${scenarioName.value}":`,
          `- Cash position: ${m.cash === null ? 'no bank balance recorded yet' : `${money(m.cash)} (sum of the bank accounts' latest balances, end of ${monthLabelFull(m.cashMonth)}${m.cashComplete ? '' : '; some accounts have older or missing balances'})`}`,
          `- Revenue this month: ${money(m.revenue)}`,
          `- Burn this month: ${money(m.burn)} (expenses ${money(m.expenses)} + payroll ${money(m.payroll)} - revenue; a negative burn means the company is cash positive)`,
        ].join('\n');
      } catch {
        numbers = 'Headline numbers (cash, burn, revenue) could not be loaded.';
      }
      const context = (s.company_context || '').trim();
      return [
        `You are the financial analysis assistant inside Vintana, the financial planning app of ${s.company_name || 'the company'}.`,
        'The person asking is on the team running the company. They see a page of the app and ask about it.',
        `Today is ${new Date().toISOString().slice(0, 10)}. Amounts are in ${cur}.`,
        s.actuals_through ? `Months up to ${s.actuals_through} are actuals; later months are forecasts.` : 'No "actuals through" month is set, so treat every month as a forecast unless the page says otherwise.',
        '',
        '<company_context>',
        context || 'No company description has been written yet.',
        '</company_context>',
        '',
        numbers,
        '',
        'Each question may come with the page data inside <page> tags: a text copy of what the screen shows, with tables as one row per line and cells separated by "|". Amounts in brackets, like (1,200.00), are negative.',
        '',
        'How to answer:',
        '- Base your answer on the page data and the numbers above. When something you need is not there, say what is missing rather than guessing.',
        '- When you compute a figure, show the short calculation so it can be checked.',
        '- Go straight to the answer. Keep it short unless asked for detail.',
        '- Write plain text: short paragraphs, "-" bullet lists and **bold** only. No tables, no headings.',
        '- Never use em dashes; use a semicolon or a comma instead.',
        '- Answer in the language of the question.',
      ].join('\n');
    };

    const send = async (text) => {
      const question = (text ?? input.value).trim();
      if (!question || busy.value) return;
      const c = convo.value;
      const token = getCredentials().token;
      busy.value = true;
      input.value = '';

      const snap = snapshotPage();
      const range = `${monthLabelFull(dateRange.value.start)} to ${monthLabelFull(dateRange.value.end)}`;
      const snapHash = hashText(snap.text + scenarioName.value + range);
      let content = question;
      // Page data goes with the first question, and again only when the page changed: earlier turns are never edited
      if (c.lastSnapshot !== snapHash) {
        const intro = c.messages.length ? 'The page has changed since my last question. It now shows:\n' : '';
        content = `${intro}<page title="${pageTitle()}" scenario="${scenarioName.value}" period="${range}">\n${snap.text}\n</page>\n\n${question}`;
      }

      c.display.push({ role: 'user', text: question });
      const answer = reactive({ role: 'assistant', text: '', model: '', error: '', note: snap.truncated ? 'This page was too long to send in full; the end of it was cut.' : '', pending: true });
      c.display.push(answer);
      scrollDown();

      controller = new AbortController();
      try {
        if (!c.system) c.system = await buildSystem();
        const messages = [...c.messages, { role: 'user', content }];
        const result = await streamChat({
          relayUrl: relayUrl.value, token, provider: choice.value.provider, model: choice.value.model, system: c.system, messages,
          signal: controller.signal,
          onText: t => { answer.text = t; scrollDown(); },
        });
        answer.text = result.text;
        answer.model = result.servedBy; // what the provider reports, so a fallback model shows as such
        if (result.stopReason === 'refusal') {
          answer.error = 'The model declined to answer this question.';
        } else {
          c.messages.push({ role: 'user', content }, { role: 'assistant', content: result.content });
          c.lastSnapshot = snapHash;
          if (result.stopReason === 'max_tokens') answer.note = 'The answer reached its length limit and was cut.';
        }
      } catch (e) {
        // The failed turn is not kept, so the conversation stays valid; the question goes back in the box
        answer.error = e.name === 'AbortError' ? 'Stopped.' : e.message;
        if (e.name === 'AbortError' && answer.text) answer.note = 'Stopped before the end; this answer is not kept in the conversation.';
        if (!input.value) input.value = question;
      } finally {
        answer.pending = false;
        busy.value = false;
        controller = null;
        scrollDown();
      }
    };

    const stop = () => controller?.abort();
    const onEnter = e => { if (!e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } };

    watch(() => route.path, () => { if (busy.value) stop(); });

    return {
      open, input, busy, convo, modelLabel, scrollEl, inputEl, EXAMPLES,
      toggle, reset, send, stop, onEnter, renderMarkdown,
    };
  },
  template: `
    <div>
      <button v-if="!open" @click="toggle" aria-label="Open the assistant"
        class="fixed bottom-4 right-4 z-40 flex items-center gap-2 pl-3 pr-4 py-2.5 rounded-full bg-indigo-600 text-white text-sm font-medium shadow-lg hover:bg-indigo-700 transition-colors">
        <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2z"/></svg>
        Ask
      </button>

      <aside v-if="open" role="dialog" aria-label="Assistant"
        class="fixed top-0 right-0 z-50 h-full w-full sm:w-[440px] bg-white border-l border-gray-200 shadow-xl flex flex-col">
        <div class="flex items-center justify-between px-4 h-14 border-b border-gray-200 flex-shrink-0">
          <div>
            <div class="text-sm font-semibold text-gray-900">Assistant</div>
            <div class="text-xs text-gray-400">{{ modelLabel }} · sees this page</div>
          </div>
          <div class="flex items-center gap-1">
            <button v-if="convo.display.length" @click="reset" :disabled="busy" class="px-2 py-1 text-xs text-gray-500 hover:text-gray-900 disabled:opacity-40">New conversation</button>
            <button @click="toggle" aria-label="Close the assistant" class="p-1.5 text-gray-400 hover:text-gray-700">
              <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg>
            </button>
          </div>
        </div>

        <div ref="scrollEl" class="flex-1 overflow-y-auto px-4 py-4 space-y-4">
          <div v-if="!convo.display.length" class="text-sm text-gray-500 space-y-3">
            <p>Ask a question about what this page shows. The assistant also knows the company description from Settings and this month's cash, burn and revenue.</p>
            <div class="flex flex-col items-start gap-2">
              <button v-for="q in EXAMPLES" :key="q" @click="send(q)" :disabled="busy"
                class="text-left px-3 py-1.5 rounded-lg border border-gray-200 text-gray-700 hover:bg-gray-50">{{ q }}</button>
            </div>
          </div>
          <div v-for="(m, i) in convo.display" :key="i" :class="m.role === 'user' ? 'flex justify-end' : ''">
            <div v-if="m.role === 'user'" class="max-w-[85%] px-3 py-2 rounded-2xl bg-indigo-600 text-white text-sm whitespace-pre-wrap">{{ m.text }}</div>
            <div v-else class="text-sm text-gray-800 space-y-2 leading-relaxed">
              <div v-if="m.text" class="space-y-2" v-html="renderMarkdown(m.text)"></div>
              <div v-else-if="m.pending" class="flex items-center gap-2 text-gray-400">
                <span class="inline-block w-2 h-2 rounded-full bg-indigo-400 animate-pulse"></span> Thinking...
              </div>
              <p v-if="m.error" class="text-red-600">{{ m.error }}</p>
              <p v-if="m.note" class="text-xs text-gray-400">{{ m.note }}</p>
              <p v-if="m.model && !m.pending" class="text-[11px] text-gray-400">Answered by {{ m.model }}</p>
            </div>
          </div>
        </div>

        <div class="border-t border-gray-200 p-3 flex-shrink-0">
          <div class="flex items-end gap-2">
            <textarea ref="inputEl" v-model="input" @keydown.enter="onEnter" rows="2" placeholder="Ask about this page..."
              class="flex-1 resize-none px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"></textarea>
            <button v-if="busy" @click="stop" class="px-3 py-2 text-sm border border-gray-200 rounded-lg hover:bg-gray-50">Stop</button>
            <button v-else @click="send()" :disabled="!input.trim()" class="px-3 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-40">Send</button>
          </div>
          <p class="mt-1.5 text-[11px] text-gray-400">Enter to send, Shift+Enter for a new line. Answers can be wrong; check important figures.</p>
        </div>
      </aside>
    </div>
  `,
};
