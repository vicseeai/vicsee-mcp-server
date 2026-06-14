/**
 * Hosted VicSee MCP connector — Cloudflare Worker entry (#231).
 *
 * Streamable HTTP transport on mcp.vicsee.com/<token>, added in claude.ai's
 * "Add custom connector" dialog. Stateless (no Durable Objects): a new McpServer
 * is built per request, bound to the API key the <token> resolves to.
 *
 * Flow:  claude.ai → mcp.vicsee.com/<token>
 *          → resolve <token> → api_key (KV cache, ~60s; miss → vicsee-v2 endpoint)
 *          → VicSeeClient({ apiKey }) → registerCoreTools (6 URL-in tools)
 *          → createMcpHandler(server)(request)
 *
 * vicsee_upload is NOT here (stdio-only — it reads the local filesystem).
 */

import { createMcpHandler } from 'agents/mcp';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { registerCoreTools } from './tools-core.js';
import { VicSeeClient } from './vicsee-client.js';

interface Env {
  TOKEN_CACHE: KVNamespace;
  /** vicsee-v2 resolver, e.g. https://vicsee.com/api/v1/internal/mcp/resolve-token */
  VICSEE_RESOLVE_URL: string;
  /** shared secret with vicsee-v2 (matches MCP_RESOLVE_SECRET there) */
  MCP_RESOLVE_SECRET: string;
}

interface ResolveResponse {
  success?: boolean;
  data?: { api_key?: string; userId?: string };
  error?: string;
}

/** Resolve <token> → api_key. KV cache (short TTL) in front of the vicsee-v2 endpoint. */
async function resolveApiKey(token: string, env: Env): Promise<string | null> {
  const cacheKey = `t:${token}`;
  const cached = await env.TOKEN_CACHE.get(cacheKey);
  if (cached) return cached;

  const res = await fetch(env.VICSEE_RESOLVE_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${env.MCP_RESOLVE_SECRET}`,
    },
    body: JSON.stringify({ token }),
  });
  if (!res.ok) return null;

  const body = (await res.json()) as ResolveResponse;
  if (!body.success || !body.data?.api_key) return null;

  await env.TOKEN_CACHE.put(cacheKey, body.data.api_key, { expirationTtl: 60 });
  return body.data.api_key;
}

/** DNS-rebinding defense (MCP spec): only allow claude.ai origins (or no Origin, for non-browser callers). */
function originAllowed(origin: string | null): boolean {
  if (!origin) return true; // server-to-server callers may omit Origin
  return /^https:\/\/([a-z0-9-]+\.)*claude\.ai$/.test(origin);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (!originAllowed(request.headers.get('origin'))) {
      return new Response('Forbidden origin', { status: 403 });
    }

    // First path segment is the opaque connector token: mcp.vicsee.com/<token>[/...]
    const url = new URL(request.url);
    const token = url.pathname.split('/').filter(Boolean)[0];
    if (!token) return new Response('Missing connector token', { status: 404 });

    const apiKey = await resolveApiKey(token, env);
    if (!apiKey) return new Response('Invalid or revoked connector token', { status: 401 });

    // Stateless: fresh server per request, bound to this token's API key.
    const server = new McpServer({ name: 'vicsee', version: '0.4.0' });
    registerCoreTools(server, new VicSeeClient({ apiKey }), {}); // URL-in only (no local-file resolver)

    // The token lives in the path, so the MCP endpoint route IS this request's
    // pathname (createMcpHandler defaults to "/mcp" and 404s otherwise). Setting
    // route to url.pathname matches whatever path claude.ai posts to.
    return createMcpHandler(server, { route: url.pathname })(request, env, ctx);
  },
};
