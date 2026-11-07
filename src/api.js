// Thin client for the Blog Automation Customer API (/api/v1/ext). The key is passed in per client – never stored or logged.
import { randomUUID } from 'node:crypto';

export const DEFAULT_BASE = 'https://app.blog-automation.com/api/v1/ext';
export const KEY_RE = /^ba_live_[A-Za-z0-9_-]{30,64}$/;
const UA = 'BlogAutomation-MCP/1.0 (+https://blog-automation.com)';

export class ApiError extends Error {
  constructor(status, body, headers) {
    super(body?.message || body?.error || `HTTP ${status}`);
    this.status = status; this.body = body || {}; this.retryAfter = headers?.get?.('retry-after') || null;
  }
}

/** Readable text for an API error (shown to the model / person as an isError tool result). */
export function explain(e) {
  if (!(e instanceof ApiError)) return `Blog Automation could not be reached: ${e?.message || e}`;
  const b = e.body;
  if (e.status === 401) return 'The Blog Automation API key is missing, invalid, expired or revoked. Create a key in Blog Automation → Entwickler / API.';
  if (e.status === 402) return `Not enough tokens for this AI action (needed ${b.needed ?? '?'}, balance ${b.balance ?? '?'}). Buy a refill or upgrade in Blog Automation → Tokens.`;
  if (e.status === 403 && b.error === 'plan_required') return `The API is not included in this plan${b.plans ? ` (available in: ${b.plans.join(', ')})` : ''}.`;
  if (e.status === 403 && b.error === 'insufficient_scope') return `The API key lacks the scope ${(b.missing || []).join(', ') || '(unknown)'}. Add it to the key in Blog Automation → Entwickler / API.`;
  if (e.status === 404) return `Not found: ${b.message || 'the record does not exist or belongs to another account'}.`;
  if (e.status === 429) return `Rate limit reached – try again in ${e.retryAfter || 60} seconds.`;
  return `Blog Automation error ${e.status}${b.error ? ` (${b.error})` : ''}: ${b.message || 'unknown error'}`;
}

/** createClient({ apiKey, base?, fetch? }) → { get, post } */
export function createClient({ apiKey, base = process.env.BA_API_BASE || DEFAULT_BASE, fetch: f = globalThis.fetch } = {}) {
  const root = String(base).replace(/\/+$/, '');
  async function call(method, path, { query, body, idempotent = false } = {}) {
    if (!apiKey) throw new ApiError(401, { error: 'unauthorized', message: 'No API key.' });
    const u = new URL(root + path);
    for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
    const headers = { Authorization: `Bearer ${apiKey}`, Accept: 'application/json', 'User-Agent': UA };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (idempotent) headers['Idempotency-Key'] = `mcp-${randomUUID()}`;
    const r = await f(u, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(180000) });
    const text = await r.text();
    let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { error: 'invalid_response', message: text.slice(0, 200) }; }
    if (!r.ok) throw new ApiError(r.status, data, r.headers);
    return data;
  }
  return {
    get: (path, query) => call('GET', path, { query }),
    post: (path, body, opts = {}) => call('POST', path, { body: body ?? {}, ...opts }),
  };
}
