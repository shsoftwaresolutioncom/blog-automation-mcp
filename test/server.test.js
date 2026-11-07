// node --test: tools over an in-memory MCP connection against a fake fetch, plus the streamable HTTP transport (auth, Origin, tools/list).
import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildServer, createHttpServer } from '../src/server.js';
import { WAIT } from '../src/tools.js';

const KEY = 'ba_live_' + 'k'.repeat(43);
const BASE = 'https://api.test/api/v1/ext';

/** fake fetch: routes = { 'GET /ideas': (req) => [status, body, headers?] }; records every request */
function fakeFetch(routes) {
  const calls = [];
  const f = async (url, init) => {
    const u = new URL(url), key = `${init.method} ${u.pathname.replace('/api/v1/ext', '')}`;
    const req = { method: init.method, path: u.pathname.replace('/api/v1/ext', ''), query: Object.fromEntries(u.searchParams), headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(req);
    const h = routes[key];
    const [status, body, headers] = h ? h(req) : [404, { error: 'not_found', message: 'no route' }];
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...(headers || {}) } });
  };
  f.calls = calls;
  return f;
}
async function connect(routes, apiKey = KEY) {
  const fetch = fakeFetch(routes);
  const server = buildServer({ apiKey, base: BASE, fetch });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1' });
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, fetch, close: () => client.close() };
}
const text = (r) => r.content[0].text;

test('tools/list: all tools with annotations and schemas', async () => {
  const { client, close } = await connect({});
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['article_status', 'create_idea', 'get_article', 'job_status', 'list_articles', 'list_ideas', 'list_sites', 'list_templates', 'publish_article', 'token_balance', 'write_article']);
  const by = Object.fromEntries(tools.map((t) => [t.name, t]));
  assert.equal(by.token_balance.annotations.readOnlyHint, true);
  assert.equal(by.write_article.annotations.readOnlyHint, false);
  assert.match(by.write_article.description, /TOKENS/);
  assert.deepEqual(by.create_idea.inputSchema.required, ['title']);
  await close();
});

test('read tools: request shape, bearer key, query params', async () => {
  const { client, fetch, close } = await connect({
    'GET /ideas': () => [200, { data: [{ id: 1, title: 'Idea' }], hasMore: false, nextCursor: null }],
    'GET /articles': () => [200, { data: [], hasMore: false, nextCursor: null }],
    'GET /articles/7': () => [200, { id: 7, title: 'A', content: '<p>x</p>' }],
    'GET /articles/7/status': () => [200, { id: 7, status: 'scheduled' }],
    'GET /tokens': () => [200, { balance: 420 }],
    'GET /sites': () => [200, { data: [{ id: 3 }] }],
    'GET /templates': () => [200, { data: [{ id: 'b:howto' }] }],
  });
  const r = await client.callTool({ name: 'list_ideas', arguments: { status: 'new', limit: 5 } });
  assert.equal(r.isError, undefined); assert.equal(r.structuredContent.data[0].title, 'Idea');
  assert.deepEqual(fetch.calls[0].query, { status: 'new', limit: '5' });
  assert.equal(fetch.calls[0].headers.Authorization, `Bearer ${KEY}`);
  await client.callTool({ name: 'list_articles', arguments: { status: ['draft', 'review'], q: 'garden' } });
  assert.deepEqual(fetch.calls[1].query, { status: 'draft,review', q: 'garden' });
  assert.equal((await client.callTool({ name: 'get_article', arguments: { id: 7 } })).structuredContent.content, '<p>x</p>');
  assert.equal((await client.callTool({ name: 'article_status', arguments: { id: 7 } })).structuredContent.status, 'scheduled');
  assert.equal((await client.callTool({ name: 'token_balance', arguments: {} })).structuredContent.balance, 420);
  await client.callTool({ name: 'list_sites', arguments: {} });
  await client.callTool({ name: 'list_templates', arguments: { lang: 'de' } });
  assert.deepEqual(fetch.calls.at(-1).query, { lang: 'de' });
  await close();
});

test('create_idea: POST body + Idempotency-Key', async () => {
  const { client, fetch, close } = await connect({ 'POST /ideas': (req) => [201, { id: 9, ...req.body }] });
  const r = await client.callTool({ name: 'create_idea', arguments: { title: 'Ten mistakes', keyword: 'start a blog', priority: 1 } });
  assert.equal(r.structuredContent.id, 9);
  assert.deepEqual(fetch.calls[0].body, { title: 'Ten mistakes', keyword: 'start a blog', priority: 1 });
  assert.match(fetch.calls[0].headers['Idempotency-Key'], /^mcp-[0-9a-f-]{36}$/);
  await close();
});

test('write_article: async job, polls GET /jobs/{id} until done; returns jobId when still running; failed job → isError', async () => {
  Object.assign(WAIT, { totalMs: 200, everyMs: 10 });
  let polls = 0;
  const { client, fetch, close } = await connect({
    'POST /articles/generate': (req) => [202, { job: { id: req.body.topic === 'slow' ? 2 : req.body.topic === 'bad' ? 3 : 1, status: 'running' } }],
    'GET /jobs/1': () => (++polls < 3 ? [200, { id: 1, status: 'running' }] : [200, { id: 1, status: 'done', articleId: 5, article: { id: 5, title: 'Spring', content: '<p>long</p>' }, tokens: { used: 12, balance: 88 } }]),
    'GET /jobs/2': () => [200, { id: 2, status: 'running', article: null }],
    'GET /jobs/3': () => [200, { id: 3, status: 'failed', error: { error: 'ai', message: 'provider down' } }],
  });
  const r = await client.callTool({ name: 'write_article', arguments: { topic: 'Spring', withImage: true, length: 'medium' } });
  assert.equal(r.structuredContent.done, true); assert.equal(r.structuredContent.article.id, 5);
  assert.ok(!('content' in r.structuredContent.article), 'HTML not in the answer');
  assert.deepEqual(fetch.calls[0].body, { topic: 'Spring', withImage: true, length: 'medium', async: true });
  assert.ok(fetch.calls[0].headers['Idempotency-Key']);
  assert.equal(polls, 3);
  const slow = await client.callTool({ name: 'write_article', arguments: { topic: 'slow' } });
  assert.equal(slow.structuredContent.done, false); assert.equal(slow.structuredContent.jobId, 2); assert.match(slow.structuredContent.hint, /job_status/);
  const bad = await client.callTool({ name: 'write_article', arguments: { topic: 'bad' } });
  assert.equal(bad.isError, true); assert.match(text(bad), /provider down/);
  const none = await client.callTool({ name: 'write_article', arguments: {} });
  assert.equal(none.isError, true); assert.match(text(none), /topic, a keyword or an ideaId/);
  const js = await client.callTool({ name: 'job_status', arguments: { id: 1 } });
  assert.equal(js.structuredContent.status, 'done');
  await close();
});

test('publish_article: now → /publish, with at → /schedule (also "next")', async () => {
  const { client, fetch, close } = await connect({
    'POST /articles/4/publish': () => [200, { article: { id: 4, status: 'published' } }],
    'POST /articles/4/schedule': (req) => [200, { article: { id: 4, status: 'scheduled', scheduledAt: req.body.at } }],
  });
  assert.equal((await client.callTool({ name: 'publish_article', arguments: { id: 4 } })).structuredContent.article.status, 'published');
  assert.deepEqual(fetch.calls[0].body, {});
  await client.callTool({ name: 'publish_article', arguments: { id: 4, at: 'next', siteId: 2 } });
  assert.equal(fetch.calls[1].path, '/articles/4/schedule'); assert.deepEqual(fetch.calls[1].body, { at: 'next', siteId: 2 });
  await close();
});

test('errors become readable isError results: 402, 403 scope, 403 plan, 401, 429, 404', async () => {
  const { client, close } = await connect({
    'POST /articles/generate': () => [402, { error: 'tokens', needed: 30, balance: 4 }],
    'GET /tokens': () => [403, { error: 'insufficient_scope', missing: ['account:read'] }],
    'GET /sites': () => [403, { error: 'plan_required', plans: ['starter', 'pro'] }],
    'GET /ideas': () => [401, { error: 'unauthorized' }],
    'GET /templates': () => [429, { error: 'rate_limited' }, { 'retry-after': '17' }],
    'GET /articles/99/status': () => [404, { error: 'not_found', message: 'Article not found.' }],
  });
  const t = async (name, args = {}) => { const r = await client.callTool({ name, arguments: args }); assert.equal(r.isError, true, name); return text(r); };
  assert.match(await t('write_article', { topic: 'x' }), /needed 30, balance 4/);
  assert.match(await t('token_balance'), /scope account:read/);
  assert.match(await t('list_sites'), /starter, pro/);
  assert.match(await t('list_ideas'), /invalid, expired or revoked/);
  assert.match(await t('list_templates'), /17 seconds/);
  assert.match(await t('article_status', { id: 99 }), /Article not found/);
  await close();
});

test('HTTP transport: /healthz, 401 without key, 403 for foreign Origin, 405 on GET, tools/list + call with the key of the request', async () => {
  const fetch = fakeFetch({ 'GET /tokens': (req) => [200, { balance: 7, auth: req.headers.Authorization }] });
  const srv = createHttpServer({ base: BASE, fetch, origins: ['https://claude.ai'] });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}`;
  try {
    assert.equal((await (await globalThis.fetch(`${url}/healthz`)).json()).ok, true);
    const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } };
    const post = (headers) => globalThis.fetch(`${url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify(init) });
    const no = await post({});
    assert.equal(no.status, 401); assert.match(no.headers.get('www-authenticate'), /Bearer/);
    assert.match(no.headers.get('www-authenticate'), /resource_metadata="https:\/\/mcp\.blog-automation\.com\/\.well-known\/oauth-protected-resource"/);
    const prm = await (await globalThis.fetch(`${url}/.well-known/oauth-protected-resource`)).json();
    assert.equal(prm.resource, 'https://mcp.blog-automation.com/mcp'); assert.deepEqual(prm.authorization_servers, ['https://app.blog-automation.com']);
    assert.ok(prm.scopes_supported.includes('ai:generate'));
    const as = await globalThis.fetch(`${url}/.well-known/oauth-authorization-server`, { redirect: 'manual' });
    assert.equal(as.status, 302); assert.equal(as.headers.get('location'), 'https://app.blog-automation.com/.well-known/oauth-authorization-server');
    assert.equal((await post({ authorization: 'Bearer nope' })).status, 401);
    assert.equal((await post({ authorization: `Bearer ${KEY}`, origin: 'https://evil.example' })).status, 403);
    assert.equal((await post({ authorization: `Bearer ${KEY}`, origin: 'https://claude.ai' })).status, 200);
    assert.equal((await globalThis.fetch(`${url}/mcp`, { headers: { authorization: `Bearer ${KEY}` } })).status, 405);
    const client = new Client({ name: 'http-test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${KEY}` } } }));
    assert.equal((await client.listTools()).tools.length, 11);
    const r = await client.callTool({ name: 'token_balance', arguments: {} });
    assert.equal(r.structuredContent.balance, 7); assert.equal(r.structuredContent.auth, `Bearer ${KEY}`);
    await client.close();
  } finally { await new Promise((r) => srv.close(r)); }
});
