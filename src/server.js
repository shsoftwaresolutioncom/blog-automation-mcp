// Blog Automation MCP server: buildServer() for any transport, createHttpServer() = streamable HTTP (stateless, key per request).
import http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createClient, KEY_RE } from './api.js';
import { registerTools } from './tools.js';

export const VERSION = '1.1.0';
export const DEFAULT_RESOURCE = 'https://mcp.blog-automation.com/mcp';
export const DEFAULT_ISSUER = 'https://app.blog-automation.com';
const SCOPES = ['articles:read', 'articles:write', 'articles:publish', 'ai:generate', 'ideas:read', 'ideas:write', 'templates:read', 'sites:read', 'account:read'];
const INSTRUCTIONS = 'Blog Automation plans, writes and publishes blog articles to WordPress. Typical flow: list_sites → list_ideas / create_idea → write_article (uses tokens – check token_balance and confirm) → article_status → publish_article (public – confirm). Article ids, idea ids and site ids are integers.';

/** one MCP server bound to one API key */
export function buildServer({ apiKey, base, fetch } = {}) {
  const server = new McpServer({ name: 'blog-automation', title: 'Blog Automation', version: VERSION }, { instructions: INSTRUCTIONS });
  registerTools(server, createClient({ apiKey, base, fetch }));
  return server;
}

const send = (res, code, obj, headers = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(obj)); };
const rpcError = (res, code, message, headers) => send(res, code, { jsonrpc: '2.0', error: { code: -32000, message }, id: null }, headers);

/**
 * Streamable HTTP on /mcp. Stateless: every POST builds a fresh server with the key from "Authorization: Bearer ba_live_…".
 * The key is only used for that request's API calls – not stored, not logged. Browsers: Origin must be in `origins` (DNS rebinding).
 * OAuth (ChatGPT apps, Claude, other MCP clients): /.well-known/oauth-protected-resource names Blog Automation as authorization server
 * (RFC 9728); its access tokens are API keys, so the same Bearer check applies. Without a token the 401 points to that metadata.
 */
export function createHttpServer({ base, fetch, origins = [], maxBody = 1024 * 1024, log = () => {}, resource = process.env.BA_MCP_RESOURCE || DEFAULT_RESOURCE,
  issuer = process.env.BA_OAUTH_ISSUER || DEFAULT_ISSUER } = {}) {
  const allowed = new Set(origins.map((o) => o.replace(/\/+$/, '').toLowerCase()));
  const metaUrl = new URL('/.well-known/oauth-protected-resource', resource).toString();
  const prm = { resource, authorization_servers: [issuer], bearer_methods_supported: ['header'], scopes_supported: SCOPES,
    resource_name: 'Blog Automation', resource_documentation: 'https://blog-automation.com/entwickler/' };
  return http.createServer(async (req, res) => {
    const path = (req.url || '/').split('?')[0];
    if (path === '/healthz') return send(res, 200, { ok: true, name: 'blog-automation-mcp', version: VERSION });
    if (path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp') return send(res, 200, prm, { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=3600' });
    if (path === '/.well-known/oauth-authorization-server') return send(res, 302, { location: `${issuer}/.well-known/oauth-authorization-server` }, { Location: `${issuer}/.well-known/oauth-authorization-server` });
    if (path !== '/mcp') return send(res, 404, { error: 'not_found' });
    const origin = req.headers.origin;
    if (origin && !allowed.has(String(origin).toLowerCase())) return rpcError(res, 403, 'Origin not allowed.');
    const cors = origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {};
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...cors, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, Mcp-Protocol-Version, Accept', 'Access-Control-Max-Age': '600' });
      return res.end();
    }
    if (req.method !== 'POST') return rpcError(res, 405, 'Method not allowed (stateless server: POST only).', { Allow: 'POST, OPTIONS', ...cors });
    const m = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization || ''));
    if (!m || !KEY_RE.test(m[1])) return rpcError(res, 401, 'Sign in with Blog Automation (OAuth) or send your API key: Authorization: Bearer ba_live_…', { 'WWW-Authenticate': `Bearer realm="blog-automation", resource_metadata="${metaUrl}"`, ...cors });
    let body;
    try {
      const chunks = []; let size = 0;
      for await (const c of req) { size += c.length; if (size > maxBody) return rpcError(res, 413, 'Request too large.', cors); chunks.push(c); }
      body = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null');
    } catch { return rpcError(res, 400, 'Invalid JSON.', cors); }
    for (const [k, v] of Object.entries(cors)) res.setHeader(k, v);
    const server = buildServer({ apiKey: m[1], base, fetch });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      log(`mcp request failed: ${e?.message || e}`);   // never the key
      if (!res.headersSent) rpcError(res, 500, 'Internal error.');
    }
  });
}
