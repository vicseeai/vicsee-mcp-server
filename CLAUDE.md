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

## Roadmap (not built yet)

- Hosted transport + OAuth (`mcp.vicsee.com`) — remove the API-key step
- Character tools (consistent characters)
- Optional local-save on `vicsee_get_task`
