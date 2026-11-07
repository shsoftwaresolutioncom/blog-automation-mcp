# Blog Automation MCP server

[Model Context Protocol](https://modelcontextprotocol.io) server for **Blog Automation** (https://blog-automation.com): plan ideas, write
articles with AI, publish or schedule them on WordPress and check the token balance – from Claude, ChatGPT, Cursor or any MCP client.
It is a thin wrapper around the Customer API `https://app.blog-automation.com/api/v1/ext` (app repo `blogposter-app`, `server/routes/ext.js`,
`docs/API.md`). Node 22, `@modelcontextprotocol/sdk` 1.32, zod 4. Package `@blogautomation/mcp-server`, command `blog-automation-mcp`.

## Tools

| Tool | API call | Notes |
|---|---|---|
| `list_ideas` | `GET /ideas` | status, siteId, limit, cursor – read only |
| `create_idea` | `POST /ideas` | title (+ keyword, notes, audience, priority 1–3, language, siteId); `Idempotency-Key` |
| `write_article` | `POST /articles/generate` `{ …, async: true }` → 202 `{ job }`, then `GET /jobs/{id}` every 3 s | **uses tokens**; waits ≈ 50 s, then returns `jobId` (→ `job_status`); answer without HTML; `Idempotency-Key` |
| `job_status` | `GET /jobs/{id}` | running / done (article) / failed (error) |
| `list_articles` | `GET /articles` | status list, siteId, q, limit, cursor (no HTML) |
| `get_article` | `GET /articles/{id}` | with HTML and SEO fields |
| `article_status` | `GET /articles/{id}/status` | status, schedule, WordPress link, last error, job |
| `publish_article` | `POST /articles/{id}/publish` or, with `at`, `POST /articles/{id}/schedule` | `at` = ISO time or `"next"` (next free slot = "add to calendar") |
| `token_balance` | `GET /tokens` | balance, lots, prices |
| `list_sites` | `GET /sites` | WordPress sites (ids for `siteId`) |
| `list_templates` | `GET /templates` | built-in `b:…` and own templates |

Errors come back as readable tool results with `isError: true`: 401 (key invalid/revoked), 402 (not enough tokens: needed / balance),
403 `insufficient_scope` (which scope is missing) / `plan_required` (which plans have the API), 404, 429 (seconds from `Retry-After`).

## API key

Blog Automation → **Entwickler / API** → "API-Key erstellen" (plans Starter and Pro). Scopes:
`articles:read`, `articles:write`, `ai:generate` (write_article), `articles:publish` (publish_article), `ideas:read`, `ideas:write`,
`templates:read`, `sites:read`, `account:read` (token_balance). Leave out what the assistant should not do – e.g. without
`articles:publish` it can write drafts but never publish.

## Use it

**stdio** (local; the key comes from `BA_API_KEY`):

```bash
npx -y @blogautomation/mcp-server          # once published; from this repo: node mcp/src/cli.js
```

Claude Desktop (`claude_desktop_config.json`) / Cursor (`~/.cursor/mcp.json`) – same block:

```json
{ "mcpServers": { "blog-automation": { "command": "npx", "args": ["-y", "@blogautomation/mcp-server"], "env": { "BA_API_KEY": "ba_live_…" } } } }
```

Claude Code: `claude mcp add blog-automation --env BA_API_KEY=ba_live_… -- npx -y @blogautomation/mcp-server`

**Streamable HTTP** (remote clients – ChatGPT connectors / developer mode, Claude "custom connector", Cursor via URL):

```bash
blog-automation-mcp --http --port 8787 --host 127.0.0.1 --origin https://chatgpt.com,https://claude.ai
```

- Endpoint `POST /mcp` (stateless, JSON responses), health check `GET /healthz`. GET/DELETE on `/mcp` → 405 (no sessions).
- Every request must send `Authorization: Bearer ba_live_…`; the key is used only for that request's API calls – not stored, not logged.
  Missing or malformed → 401 with `WWW-Authenticate: Bearer`.
- Requests with an `Origin` header are only accepted from `--origin` / `BA_MCP_ORIGINS` (DNS-rebinding protection); without the option
  browser requests are refused, server-to-server calls (no Origin) work.
- Binds 127.0.0.1 by default; put it behind the reverse proxy (TLS) for public use, e.g. `https://mcp.blog-automation.com/mcp`.
- **OAuth (since 1.1.0):** clients that only do OAuth – ChatGPT apps / developer mode, Claude custom connectors, MCP Inspector – just get the
  URL `https://mcp.blog-automation.com/mcp`. The 401 points to `/.well-known/oauth-protected-resource` (RFC 9728), which names
  `https://app.blog-automation.com` as authorization server (dynamic client registration, PKCE S256). The person signs in to Blog Automation,
  sees the requested permissions and clicks "Erlauben"; the access token is a 1-hour API key, refreshed automatically, revocable under
  Entwickler / API. Env: `BA_MCP_RESOURCE` (public /mcp URL), `BA_OAUTH_ISSUER` (app base URL).

### ChatGPT app

ChatGPT → Settings → Apps & Connectors → Advanced → Developer mode → "Create" → name "Blog Automation", MCP server URL
`https://mcp.blog-automation.com/mcp`, authentication **OAuth** → sign in → allow. All tools carry `readOnlyHint` / `destructiveHint`
annotations, so ChatGPT asks before writing (tokens) or publishing. Listing in the ChatGPT app directory: SUBMISSION.md.

`BA_API_BASE` overrides the API (e.g. `https://pre.blog-automation.com/api/v1/ext`).

## Develop

```bash
cd mcp && npm install && npm test     # node:test – 7 tests, fake API (no network, no key)
```

Tests: tools/list (names, annotations, schemas), request shape of every tool, Idempotency-Key, async job polling (done / still running /
failed), publish vs. schedule, error mapping (401/402/403/404/429), HTTP transport (healthz, 401, Origin 403, 405, tools/list + call with
the request's key).
