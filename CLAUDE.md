# CLAUDE.md — VicSee MCP Server

> Context file for Claude Code sessions.

## What Is This?

A standalone **MCP (Model Context Protocol) server** that exposes the public
[VicSee API](https://vicsee.com/docs/api) (`https://vicsee.com/api/v1`) as agent tools, so AI
agent runtimes (Hermes, OpenClaw, Claude, Cursor) can generate, edit, and upscale AI video &
images via VicSee.

It is a **thin proxy** — no backend logic of its own. It wraps `/api/v1` and authenticates with
the caller's `VICSEE_API_KEY`.

## Layout

```
src/
├── index.ts          # MCP server — registers the 6 tools, stdio transport
└── vicsee-client.ts  # thin fetch client for /api/v1 (unwraps {success,data,error})
```

## The 6 tools

`vicsee_list_models`, `vicsee_generate`, `vicsee_get_task`, `vicsee_upscale_image`,
`vicsee_upscale_video`, `vicsee_get_credits`.

Generation is async: `vicsee_generate` returns a task id; poll `vicsee_get_task` until
`status === "completed"` and read `result.url`.

## API contract

See the published API docs at **https://vicsee.com/docs/api** for the authoritative reference.

- Base URL: `https://vicsee.com/api/v1` (override via `VICSEE_BASE_URL`)
- Auth: `Authorization: Bearer sk-<key>` (all tools except `vicsee_list_models`, which is public)
- Envelope: `{ success, data, error: { code, message } }` — the client unwraps `data`, throws on error
- `generate` body: `{ model, input: { prompt, image_urls, duration, aspect_ratio, resolution, ... } }`
- `tasks/{id}` status: `pending|processing|queued|completed|failed`; result URL at `result.url`
- Result URLs are stable `cdn.vicsee.com` links

## Commands

```bash
pnpm build       # tsc → dist/
pnpm dev         # run from source (tsx)
pnpm typecheck   # tsc --noEmit
VICSEE_API_KEY=sk-... node dist/index.js   # run the stdio server
```

## Releasing

Three independent channels. A change is not shipped until all three are current.

| Channel | Command | Notes |
|---|---|---|
| Hosted connector (`mcp.vicsee.com`) | `npx wrangler deploy` | Use the **stored wrangler OAuth session** — `env -u CLOUDFLARE_API_TOKEN -u CF_API_TOKEN` if a token env var is set, it breaks the deploy. Most customers are on this one. |
| npm (`@vicsee/mcp-server`) | see below | Self-hosted agent builders. |
| GitHub (`vicseeai/vicsee-mcp-server`) | `git push` + tag `v<version>` | |

### npm publish

```bash
export NPM_TOKEN=$(grep -o '^NPM_TOKEN=.*' ../vicsee-v2/.env | sed 's/NPM_TOKEN=//' | tr -d '"\r')
pnpm build            # MANDATORY — the tarball ships dist/, not src/
npm publish --access public
```

⚠️ **The token is NOT in this repo.** `.npmrc` here holds the literal placeholder `${NPM_TOKEN}`,
which npm does **not** expand unless the variable is exported. The value lives in
**`repos/vicsee-v2/.env` as `NPM_TOKEN`** (npm token `vicsee-mcp-publish-env`). Deliberately one
copy, in one place — do not duplicate the secret into this repo.

⚠️ **Three ways to misdiagnose auth here** (all have cost real time):

1. `~/.npmrc` holds a *different*, expired token. Run npm from **this directory** or it wins → 401.
2. `npm publish --dry-run` never contacts auth — it packs locally and exits 0 with a dead token.
   Useless as a credential check.
3. `npm whoami` / `npm access list packages` fail (401/403) **even with a valid token** — granular
   package-scoped tokens cannot reach those user/org endpoints.

**Safe way to test write auth without publishing a version:**
`npm dist-tag add @vicsee/mcp-server@<current> latest` — idempotent when `latest` already points
there, but still requires write permission.

⚠️ **Bypass-2FA tokens are being deprecated** — restricted for account changes Aug 2026 and for
direct publishing **Jan 2027**. At the next token renewal, move to **npm Trusted Publishing**
(OIDC from GitHub Actions) instead of minting another token.

## Roadmap (not built yet)

- Hosted transport + OAuth (`mcp.vicsee.com`) — remove the API-key step
- Character tools (consistent characters)
- Optional local-save on `vicsee_get_task`
