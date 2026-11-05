// Assistant: reads what the current page shows and talks to Claude through the Vintana relay
// (edge-scripts/assistant-relay.ts). The relay holds the Anthropic API key; the browser only proves it
// has a valid database token.

export const ASSISTANT_MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 (default)' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (faster, cheaper)' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 (fastest, cheapest)' },
];
export const DEFAULT_MODEL = 'claude-opus-5-5';
export const DEFAULT_RELAY_URL = 'https://assistant.vintana.onetake.ai';

// Large enough for a 24-month P&L; anything beyond is cut and the panel says so
const MAX_SNAPSHOT_CHARS = 400000;

const SKIP_TAGS = new Set(['BUTTON', 'SCRIPT', 'STYLE', 'CANVAS', 'TEMPLATE', 'NOSCRIPT', 'svg', 'SVG']);
const BLOCK_TAGS = new Set(['DIV', 'P', 'SECTION', 'HEADER', 'FOOTER', 'UL', 'OL', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'FORM', 'TABLE', 'MAIN', 'ARTICLE', 'NAV']);

const isHidden = el => el.hidden || el.getAttribute('aria-hidden') === 'true' || el.offsetParent === null
  || el.classList.contains('fixed'); // modals and overlays

function fieldValue(el) {
  if (el.tagName === 'SELECT') return el.options[el.selectedIndex]?.text || '';
  if (el.type === 'checkbox' || el.type === 'radio') return el.checked ? '[x]' : '[ ]';
  return el.value || '';
}

// Text of one table cell, on one line
function cellText(cell) {
  const parts = [];
  const walk = node => {
    if (node.nodeType === Node.TEXT_NODE) { parts.push(node.textContent); return; }
    if (node.nodeType !== Node.ELEMENT_NODE || SKIP_TAGS.has(node.tagName)) return;
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(node.tagName)) { parts.push(' ' + fieldValue(node) + ' '); return; }
    if (BLOCK_TAGS.has(node.tagName)) parts.push(' ');
    node.childNodes.forEach(walk);
  };
  walk(cell);
  return parts.join('').replace(/\s+/g, ' ').trim();
}

function tableText(table) {
  const lines = [];
  for (const tr of table.querySelectorAll('tr')) {
    if (tr.closest('table') !== table || isHidden(tr)) continue;
    const cells = [...tr.children].filter(c => c.tagName === 'TD' || c.tagName === 'TH').map(cellText);
    if (cells.some(Boolean)) lines.push('| ' + cells.join(' | ') + ' |');
  }
  return lines.join('\n');
}

// Plain-text copy of what the page shows: headings, KPI cards, tables (one row per line), field values.
// Charts are skipped: their numbers are in the tables or KPI cards.
export function snapshotPage(root = document.querySelector('main')) {
  if (!root) return { text: '', truncated: false };
  const out = [];
  const walk = node => {
    if (node.nodeType === Node.TEXT_NODE) { out.push(node.textContent.replace(/\s+/g, ' ')); return; }
    if (node.nodeType !== Node.ELEMENT_NODE || SKIP_TAGS.has(node.tagName) || isHidden(node)) return;
    if (node.tagName === 'TABLE') { out.push('\n' + tableText(node) + '\n'); return; }
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(node.tagName)) { out.push(' ' + fieldValue(node) + ' '); return; }
    const block = BLOCK_TAGS.has(node.tagName);
    if (block) out.push('\n');
    if (/^H[1-6]$/.test(node.tagName)) out.push('#'.repeat(Number(node.tagName[1])) + ' ');
    node.childNodes.forEach(walk);
    if (block) out.push('\n');
  };
  walk(root);
  let text = out.join('').split('\n').map(l => l.trim()).filter(Boolean).join('\n');
  const truncated = text.length > MAX_SNAPSHOT_CHARS;
  if (truncated) text = text.slice(0, MAX_SNAPSHOT_CHARS) + '\n[... page data cut here: too long to send in full]';
  return { text, truncated };
}

export function hashText(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return h;
}

export async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

const RELAY_ERRORS = {
  UNAUTHORIZED: 'The relay does not recognise this database token. In Settings > Assistant, show the token fingerprint and add it to the relay secrets.',
  NOT_CONFIGURED: 'The relay is missing its secrets (Anthropic API key or token fingerprints).',
  MODEL_NOT_ALLOWED: 'The relay does not allow this model. Pick another one in Settings > Assistant.',
  BAD_REQUEST: 'The relay refused the request.',
  TOO_LARGE: 'This page has too much data to send. Narrow the date range and try again.',
  ORIGIN_NOT_ALLOWED: 'The relay does not accept requests from this address.',
};

export class AssistantError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// Sends the conversation and streams the answer. Returns the complete assistant content blocks (thinking blocks
// included, unchanged, so they can be sent back on the next turn) plus the stop reason.
export async function streamChat({ relayUrl, token, model, system, messages, onText, signal }) {
  let resp;
  try {
    resp = await fetch(relayUrl.replace(/\/+$/, '') + '/v1/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ model, system, messages }),
      signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new AssistantError('NETWORK', `Could not reach the relay at ${relayUrl}. Check the address in Settings > Assistant and your connection.`);
  }
  if (!resp.ok) {
    let body = {};
    try { body = await resp.json(); } catch { /* not JSON */ }
    const code = body.error || `HTTP_${resp.status}`;
    throw new AssistantError(code, RELAY_ERRORS[code] || body.message || `The relay answered with an error (${resp.status}).`);
  }

  const blocks = [];
  let stopReason = null, stopDetails = null, servedBy = model;
  const textSoFar = () => blocks.filter(b => b?.type === 'text').map(b => b.text).join('');

  const handle = ev => {
    switch (ev.type) {
      case 'message_start': servedBy = ev.message?.model || servedBy; break;
      case 'content_block_start': blocks[ev.index] = { ...ev.content_block }; break;
      case 'content_block_delta': {
        const b = blocks[ev.index], d = ev.delta;
        if (!b) break;
        if (d.type === 'text_delta') { b.text = (b.text || '') + d.text; onText?.(textSoFar()); }
        else if (d.type === 'thinking_delta') b.thinking = (b.thinking || '') + d.thinking;
        else if (d.type === 'signature_delta') b.signature = d.signature;
        else if (d.type === 'citations_delta') (b.citations ||= []).push(d.citation);
        break;
      }
      case 'message_delta':
        if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
        if (ev.delta?.stop_details) stopDetails = ev.delta.stop_details;
        break;
      case 'error':
        throw new AssistantError('UPSTREAM', ev.error?.message || 'Claude stopped with an error.');
    }
  };

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let sep;
    while ((sep = buf.indexOf('\n\n')) !== -1) {
      const chunk = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      const data = chunk.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
      if (data) handle(JSON.parse(data));
    }
  }
  if (!stopReason) throw new AssistantError('INTERRUPTED', 'The answer was cut off before the end. Try again.');
  return { content: blocks.filter(Boolean), text: textSoFar(), stopReason, stopDetails, servedBy };
}

// Minimal Markdown to HTML for answers: paragraphs, bold, italics, inline code, headings, lists, tables.
// Everything is escaped first, so the answer can never inject markup.
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const inline = s => esc(s)
  .replace(/`([^`]+)`/g, '<code class="px-1 rounded bg-gray-100 text-[0.85em]">$1</code>')
  .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');

export function renderMarkdown(md) {
  const lines = (md || '').replace(/\r/g, '').split('\n');
  const html = [];
  let list = null, para = [], table = [];
  const flushPara = () => { if (para.length) { html.push(`<p>${para.map(inline).join('<br>')}</p>`); para = []; } };
  const flushList = () => { if (list) { html.push(`<${list.tag} class="${list.tag === 'ul' ? 'list-disc' : 'list-decimal'} pl-5 space-y-1">${list.items.map(i => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`); list = null; } };
  const flushTable = () => {
    if (!table.length) return;
    const rows = table.filter(r => !/^\|?\s*:?-{2,}/.test(r)).map(r => r.replace(/^\||\|$/g, '').split('|').map(c => c.trim()));
    html.push('<div class="overflow-x-auto"><table class="text-xs border-collapse">' + rows.map((r, i) =>
      '<tr>' + r.map(c => `<${i ? 'td' : 'th'} class="border border-gray-200 px-2 py-1 ${i ? '' : 'bg-gray-50 font-medium'}">${inline(c)}</${i ? 'td' : 'th'}>`).join('') + '</tr>').join('') + '</table></div>');
    table = [];
  };
  const flushAll = () => { flushPara(); flushList(); flushTable(); };

  for (const raw of lines) {
    const line = raw.trimEnd();
    let m;
    if (!line.trim()) { flushAll(); continue; }
    if (line.trim().startsWith('|')) { flushPara(); flushList(); table.push(line.trim()); continue; }
    flushTable();
    if ((m = line.match(/^#{1,6}\s+(.*)$/))) { flushAll(); html.push(`<p class="font-semibold text-gray-900">${inline(m[1])}</p>`); continue; }
    if ((m = line.match(/^\s*[-*•]\s+(.*)$/))) { flushPara(); if (list?.tag !== 'ul') { flushList(); list = { tag: 'ul', items: [] }; } list.items.push(m[1]); continue; }
    if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) { flushPara(); if (list?.tag !== 'ol') { flushList(); list = { tag: 'ol', items: [] }; } list.items.push(m[1]); continue; }
    flushList();
    para.push(line);
  }
  flushAll();
  return html.join('');
}
