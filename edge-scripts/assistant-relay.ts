/**
 * Vintana Assistant relay: BunnyCDN Edge Script
 *
 * The Vintana app runs entirely in the browser, so it can't hold the Anthropic API key. This script holds it,
 * checks that the caller has a Vintana database token, and streams Claude's answer back.
 *
 * DEPLOYMENT: Bunny script 101199 at https://assistant.vintana.onetake.ai. Deployed by
 *   .github/workflows/deploy-assistant-relay.yml on every change to this file pushed to main.
 *   The app reads the relay address from the settings table (Settings > Assistant).
 *
 * SECRETS (Bunny dashboard):
 *   ANTHROPIC_API_KEY    required
 *   DB_TOKEN_RW_SHA256   SHA-256 (hex) of the read-write Turso token   } at least one; Settings > Assistant >
 *   DB_TOKEN_RO_SHA256   SHA-256 (hex) of the read-only Turso token    } "Show my token's fingerprint" gives it
 *   ALLOWED_ORIGINS      optional, comma-separated, replaces the default https://vintana.onetake.ai
 *                        (add e.g. http://localhost:8000 to test a local copy of the app)
 *   Only fingerprints are stored here, never the tokens: a leak of these secrets gives no database access.
 *   When a Turso token is rotated, replace its fingerprint here too, or the assistant stops answering.
 *
 * ENDPOINTS:
 *   GET  /health   {"ok": true}
 *   POST /v1/chat  Authorization: Bearer <database token>
 *                  body {"model": "...", "system": "...", "messages": [{role, content}, ...]}
 *                  The relay sets everything else (max_tokens, thinking, effort, fallbacks): the browser can't use
 *                  it as a general Anthropic proxy. Answers with Claude's event stream (text/event-stream).
 *
 * ERRORS (JSON {"error": CODE, "message"?}):
 *   400 BAD_REQUEST, 400 MODEL_NOT_ALLOWED, 401 UNAUTHORIZED, 403 ORIGIN_NOT_ALLOWED, 405 METHOD_NOT_ALLOWED,
 *   413 TOO_LARGE, 500 NOT_CONFIGURED, 502 UPSTREAM (message carries Anthropic's error text)
 *
 * PRIVACY: request and answer bodies hold the company's financial data. Never log them, nor the token.
 */

import * as BunnySDK from "https://esm.sh/@bunny.net/edgescript-sdk@0.11.2";

const ANTHROPIC_URL     = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2026-10-21';
const DEFAULT_ORIGINS   = ['https://vintana.onetake.ai'];
const MAX_BODY_BYTES    = 3 * 1024 * 1024;
const MAX_MESSAGES      = 60;
const MAX_TOKENS        = 16000;

// Models the app may ask for. Opus and Sonnet re-run a declined request on Anthropic's recommended fallback model.
const MODELS: Record<string, { fallback: boolean }> = {
  'claude-opus-5-5':   { fallback: true },
  'claude-sonnet-5-5': { fallback: true },
  'claude-haiku-5-5':  { fallback: false },
};

const allowedOrigins = (): string[] => {
  const list = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  return list.length ? list : DEFAULT_ORIGINS;
};

const corsHeaders = (origin: string | null): Record<string, string> => {
  const h: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age':       '86400',
    'Vary':                         'Origin',
  };
  if (origin && allowedOrigins().includes(origin)) h['Access-Control-Allow-Origin'] = origin;
  return h;
};

const json = (body: unknown, status: number, origin: string | null) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...corsHeaders(origin) },
  });

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function isAuthorised(req: Request): Promise<boolean> {
  const auth = req.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) return false;
  const hash = await sha256Hex(token);
  const known = [process.env.DB_TOKEN_RW_SHA256, process.env.DB_TOKEN_RO_SHA256]
    .map(h => (h || '').trim().toLowerCase()).filter(h => /^[0-9a-f]{64}$/.test(h));
  // Compare against every fingerprint, so the time taken doesn't tell which one matched
  return known.map(h => timingSafeEqual(h, hash)).some(Boolean);
}

type ChatBody = { model?: unknown; system?: unknown; messages?: unknown };

function validMessages(messages: unknown): messages is { role: string; content: unknown }[] {
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_MESSAGES) return false;
  return messages.every((m: any, i: number) => !!m && typeof m === 'object'
    && m.role === (i % 2 === 0 ? 'user' : 'assistant')
    && (typeof m.content === 'string' || Array.isArray(m.content)))
    && (messages[messages.length - 1] as any).role === 'user';
}

BunnySDK.net.http.serve(async (req: Request) => {
  const origin = req.headers.get('origin');
  const path = new URL(req.url).pathname;

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) });
  if (req.method === 'GET' && path === '/health') return json({ ok: true }, 200, origin);
  if (req.method !== 'POST' || path !== '/v1/chat') return json({ error: 'METHOD_NOT_ALLOWED' }, 405, origin);

  // Browsers send Origin; a call without one comes from a script, which the token check still covers
  if (origin && !allowedOrigins().includes(origin)) {
    console.log(`Refused POST /v1/chat: ORIGIN_NOT_ALLOWED (origin ${origin})`);
    return json({ error: 'ORIGIN_NOT_ALLOWED' }, 403, origin);
  }
  if (!process.env.ANTHROPIC_API_KEY || !(process.env.DB_TOKEN_RW_SHA256 || process.env.DB_TOKEN_RO_SHA256)) {
    console.log('Refused POST /v1/chat: NOT_CONFIGURED');
    return json({ error: 'NOT_CONFIGURED' }, 500, origin);
  }
  if (!(await isAuthorised(req))) {
    console.log(`Refused POST /v1/chat: UNAUTHORIZED (origin ${origin || '-'})`);
    return json({ error: 'UNAUTHORIZED' }, 401, origin);
  }

  const raw = await req.text();
  if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) return json({ error: 'TOO_LARGE' }, 413, origin);
  let body: ChatBody;
  try { body = JSON.parse(raw); } catch { return json({ error: 'BAD_REQUEST', message: 'Body is not JSON' }, 400, origin); }

  const model = typeof body.model === 'string' ? body.model : '';
  if (!MODELS[model]) return json({ error: 'MODEL_NOT_ALLOWED' }, 400, origin);
  if (body.system !== undefined && typeof body.system !== 'string') return json({ error: 'BAD_REQUEST', message: 'system must be a string' }, 400, origin);
  if (!validMessages(body.messages)) return json({ error: 'BAD_REQUEST', message: 'messages must alternate user/assistant and end with user' }, 400, origin);

  const headers: Record<string, string> = {
    'Content-Type':      'application/json',
    'x-api-key':         process.env.ANTHROPIC_API_KEY as string,
    'anthropic-version': ANTHROPIC_VERSION,
  };
  const payload: Record<string, unknown> = {
    model,
    max_tokens: MAX_TOKENS,
    stream: true,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'medium' },
    system: body.system || undefined,
    messages: body.messages,
  };
  if (MODELS[model].fallback) {
    headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
    payload.fallbacks = 'default';
  }

  let upstream: Response;
  try {
    upstream = await fetch(ANTHROPIC_URL, { method: 'POST', headers, body: JSON.stringify(payload) });
  } catch (e) {
    console.log(`Anthropic fetch failed: ${e}`);
    return json({ error: 'UPSTREAM', message: 'Claude could not be reached. Try again in a moment.' }, 502, origin);
  }

  if (!upstream.ok || !upstream.body) {
    let message = `Claude answered with HTTP ${upstream.status}.`;
    try { message = (await upstream.json())?.error?.message || message; } catch { /* not JSON */ }
    console.log(`Anthropic error ${upstream.status} for model ${model}`);
    return json({ error: 'UPSTREAM', message }, 502, origin);
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      'Content-Type':  'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      ...corsHeaders(origin),
    },
  });
});
