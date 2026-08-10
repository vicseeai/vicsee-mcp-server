# VicSee MCP Server

Generate, edit, and upscale AI **video & images** from any agent — [VicSee](https://vicsee.com)
as a set of [MCP](https://modelcontextprotocol.io) tools.

Works with **Hermes Agent, Claude (Desktop / Code), Cursor, OpenClaw**, and any MCP-compatible client.

## What your agent can do

| Tool | What it does |
|------|--------------|
| `vicsee_list_models` | List available models (Seedance, Veo, Kling, FLUX, Nano Banana, …) + their credit costs |
| `vicsee_generate` | Text/image → **video or image** with a chosen model |
| `vicsee_get_task` | Poll a task and get the finished media URL |
| `vicsee_upscale_image` | Upscale an image |
| `vicsee_upscale_video` | Upscale a video |
| `vicsee_get_credits` | Check your credit balance |

Generation is **asynchronous**: `vicsee_generate` (or `vicsee_upscale_*`) returns a task `id`
immediately — your agent then polls `vicsee_get_task` until `status` is `completed` and reads the
URL from `result.url`.

## Setup

1. Get an API key at **[vicsee.com](https://vicsee.com) → Settings → API** (starts with `sk-`).
   API access requires a paid plan or credit pack.
2. Add the server to your MCP client config with that key:

```json
{
  "mcpServers": {
    "vicsee": {
      "command": "npx",
      "args": ["-y", "@vicsee/mcp-server"],
      "env": { "VICSEE_API_KEY": "sk-your-key-here" }
    }
  }
}
```

That's the whole setup — drop in your key, and your agent can generate.

### Client config locations

- **Claude Desktop:** `claude_desktop_config.json` → `mcpServers`
- **Cursor:** Settings → MCP → add server (same `command`/`args`/`env`)
- **Hermes Agent / OpenClaw:** add to the MCP servers section of your agent config
- **Claude Code:** `claude mcp add vicsee -e VICSEE_API_KEY=sk-... -- npx -y @vicsee/mcp-server`

### Optional env

- `VICSEE_BASE_URL` — override the API base URL (defaults to `https://vicsee.com/api/v1`).

## Local development

```bash
pnpm install
pnpm build
VICSEE_API_KEY=sk-... node dist/index.js   # stdio server
# or run from source: VICSEE_API_KEY=sk-... pnpm dev
```

Point your MCP client at the local build by using `"command": "node", "args": ["/abs/path/to/dist/index.js"]`.

## Example agent flow

> "Make me a 5-second video of a kitten chasing a laser."

1. `vicsee_list_models` (type: video) → pick e.g. `seedance-2-5-text-to-video` (up to 30s) or `seedance-2-0-text-to-video` (adds 1080p/4K)
2. `vicsee_generate` (model, prompt, duration: 5) → `{ id, status: "pending" }`
3. `vicsee_get_task` (id) … poll … → `{ status: "completed", result: { url: "https://cdn.vicsee.com/…" } }`

## Notes

- Result URLs are served from `cdn.vicsee.com` — stable VicSee CDN links.
- Each generation costs credits; see `vicsee_list_models` for per-model costs and
  `vicsee_get_credits` for your balance.

## License

MIT
