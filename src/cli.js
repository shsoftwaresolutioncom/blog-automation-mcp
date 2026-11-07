#!/usr/bin/env node
// blog-automation-mcp            → stdio, key from BA_API_KEY
// blog-automation-mcp --http [--port 8787] [--host 127.0.0.1] [--origin https://claude.ai,...]  → streamable HTTP on /mcp, key per request
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildServer, createHttpServer, VERSION } from './server.js';
import { KEY_RE } from './api.js';

const argv = process.argv.slice(2);
const opt = (name, d) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const err = (m) => process.stderr.write(`${m}\n`);   // stdout belongs to the MCP protocol

if (argv.includes('--version')) { process.stdout.write(`${VERSION}\n`); process.exit(0); }
if (argv.includes('--http')) {
  const port = Number(opt('port', process.env.PORT || 8787)), host = opt('host', process.env.HOST || '127.0.0.1');
  const origins = String(opt('origin', process.env.BA_MCP_ORIGINS || '')).split(',').map((s) => s.trim()).filter(Boolean);
  createHttpServer({ origins, log: err }).listen(port, host, () => err(`Blog Automation MCP ${VERSION}: http://${host}:${port}/mcp (allowed browser origins: ${origins.join(', ') || 'none'})`));
} else {
  const apiKey = String(process.env.BA_API_KEY || '').trim();
  if (!KEY_RE.test(apiKey)) { err('Set BA_API_KEY to your Blog Automation API key (ba_live_…, Blog Automation → Entwickler / API).'); process.exit(1); }
  await buildServer({ apiKey }).connect(new StdioServerTransport());
  err(`Blog Automation MCP ${VERSION} on stdio`);
}
