// The MCP tools. Each maps to one Customer API endpoint (app repo: server/routes/ext.js). Results are JSON text + structuredContent.
import { z } from 'zod';
import { explain } from './api.js';

const ok = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], structuredContent: data });
const fail = (e) => ({ isError: true, content: [{ type: 'text', text: e?.user ? e.message : explain(e) }] });
const run = (fn) => async (args, extra) => { try { return ok(await fn(args || {}, extra || {})); } catch (e) { return fail(e); } };
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(Object.assign(new Error('Cancelled.'), { user: true }));
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(Object.assign(new Error('Cancelled.'), { user: true })); }, { once: true });
});
const small = (a) => { if (a) delete a.content; return a; };   // keep answers small – get_article returns the HTML
/** tuning for tests */
export const WAIT = { totalMs: 50000, everyMs: 3000 };
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ''));

const id = z.number().int().positive();
const limit = z.number().int().min(1).max(100).optional().describe('1–100, default 25');
const cursor = z.string().optional().describe('nextCursor of the previous page');
const READ = { readOnlyHint: true, openWorldHint: true };
const ARTICLE_STATES = ['idea', 'draft', 'review', 'approved', 'scheduled', 'publishing', 'published', 'failed', 'archived'];

/** register all tools on an McpServer, using the API client `api` */
export function registerTools(server, api) {
  server.registerTool('list_ideas', {
    title: 'List ideas',
    description: 'List the topic ideas on the Blog Automation idea board, newest first. Paginate with nextCursor.',
    inputSchema: { status: z.enum(['new', 'planned', 'used', 'discarded']).optional(), siteId: id.optional(), limit, cursor },
    annotations: READ,
  }, run((a) => api.get('/ideas', clean(a))));

  server.registerTool('create_idea', {
    title: 'Create an idea',
    description: 'Add a topic idea to the idea board (no tokens used). Automations and "write_article" with ideaId can turn it into an article later.',
    inputSchema: {
      title: z.string().min(1).max(300), keyword: z.string().max(300).optional().describe('focus keyword'), notes: z.string().max(2000).optional(),
      audience: z.string().max(300).optional(), priority: z.number().int().min(1).max(3).optional().describe('1 = high … 3 = low'),
      language: z.string().regex(/^[a-z]{2}$/).optional().describe('e.g. de, en'), siteId: id.optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, run((a) => api.post('/ideas', clean(a), { idempotent: true })));

  server.registerTool('write_article', {
    title: 'Write an article with AI',
    description: 'Write a complete blog article with AI (title, HTML, SEO fields, optional featured image). USES TOKENS of the Blog Automation account – check token_balance first and confirm with the user. Give a topic or keyword, or ideaId of an idea (needs scope ideas:write). The article is saved as a draft; publishing is a separate step (publish_article). Waits up to about 50 seconds; if the AI is still writing it returns a jobId – then call job_status later.',
    inputSchema: {
      topic: z.string().max(300).optional(), keyword: z.string().max(300).optional(), ideaId: id.optional(), templateId: z.string().optional().describe('e.g. b:howto – see list_templates'),
      language: z.string().regex(/^[a-z]{2}$/).optional(), length: z.enum(['short', 'medium', 'long']).optional(), tone: z.string().max(100).optional(),
      audience: z.string().max(300).optional(), siteId: id.optional().describe('target WordPress site – see list_sites'), withImage: z.boolean().optional().describe('also create a featured image (more tokens)'),
      notes: z.string().max(2000).optional().describe('extra instructions for the AI'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, run(async (a, extra) => {
    if (!a.topic && !a.keyword && !a.ideaId) throw Object.assign(new Error('Give a topic, a keyword or an ideaId.'), { user: true });
    // async mode: 202 { job } – writing can take minutes; wait ~50 s, then hand back the job id (job_status)
    const r = await api.post('/articles/generate', { ...clean(a), async: true }, { idempotent: true });
    if (!r.job) { small(r.article); return r; }   // app answered synchronously
    let job = r.job;
    const until = Date.now() + WAIT.totalMs;
    while (job.status === 'running' && Date.now() < until) {
      await sleep(WAIT.everyMs, extra.signal);
      job = await api.get(`/jobs/${job.id}`);
    }
    if (job.status === 'done') return { done: true, jobId: job.id, article: small(job.article), tokens: job.tokens };
    if (job.status === 'failed') throw Object.assign(new Error(`Writing the article failed: ${job.error?.message || job.error?.error || 'unknown error'} (job ${job.id}).`), { user: true });
    return { done: false, jobId: job.id, status: job.status, hint: `The AI is still writing. Call job_status with id ${job.id} in a minute.` };
  }));

  server.registerTool('job_status', {
    title: 'AI writing job status',
    description: 'State of an AI writing job started by write_article: running, done (with the article) or failed (with the error).',
    inputSchema: { id }, annotations: READ,
  }, run(async (a) => { const j = await api.get(`/jobs/${a.id}`); small(j.article); return j; }));

  server.registerTool('list_articles', {
    title: 'List articles',
    description: 'List articles, newest first, without the HTML. Filter by status (one or more of: idea, draft, review, approved, scheduled, publishing, published, failed, archived), site or title text.',
    inputSchema: { status: z.array(z.enum(ARTICLE_STATES)).optional(), siteId: id.optional(), q: z.string().max(80).optional().describe('search in titles'), limit, cursor },
    annotations: READ,
  }, run((a) => api.get('/articles', clean({ ...a, status: a.status?.length ? a.status.join(',') : undefined }))));

  server.registerTool('get_article', {
    title: 'Get an article',
    description: 'Read one article with its HTML content, SEO fields and publishing state.',
    inputSchema: { id }, annotations: READ,
  }, run((a) => api.get(`/articles/${a.id}`)));

  server.registerTool('article_status', {
    title: 'Article status',
    description: 'Publishing status of an article: status, scheduled time, WordPress link, last error and the publishing job.',
    inputSchema: { id }, annotations: READ,
  }, run((a) => api.get(`/articles/${a.id}/status`)));

  server.registerTool('publish_article', {
    title: 'Publish or schedule an article',
    description: 'Publish an article to its WordPress site now, or – with "at" – add it to the editorial calendar: an ISO 8601 time or "next" for the next free slot of the site. Approves a draft in the same step (needs scope articles:publish). This makes content public – confirm with the user first.',
    inputSchema: { id, at: z.string().optional().describe('ISO 8601 date-time or "next"; empty = publish now'), siteId: id.optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, run((a) => (a.at ? api.post(`/articles/${a.id}/schedule`, clean({ at: a.at, siteId: a.siteId })) : api.post(`/articles/${a.id}/publish`, clean({ siteId: a.siteId })))));

  server.registerTool('token_balance', {
    title: 'Token balance',
    description: 'Token balance of the Blog Automation account, open lots with expiry and the price of each AI action.',
    inputSchema: {}, annotations: READ,
  }, run(() => api.get('/tokens')));

  server.registerTool('list_sites', {
    title: 'List WordPress sites',
    description: 'The connected WordPress sites with connection status, language and time zone (use the id as siteId).',
    inputSchema: { limit, cursor }, annotations: READ,
  }, run((a) => api.get('/sites', clean(a))));

  server.registerTool('list_templates', {
    title: 'List article templates',
    description: 'Built-in (id b:…) and own article templates (use the id as templateId in write_article).',
    inputSchema: { lang: z.enum(['en', 'de']).optional() }, annotations: READ,
  }, run((a) => api.get('/templates', clean(a))));
}
