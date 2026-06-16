/**
 * Hosted VicSee MCP connector — Cloudflare Worker entry (#231 Phase 2: OAuth).
 *
 * Streamable HTTP transport on mcp.vicsee.com/mcp, added in claude.ai's "Add custom
 * connector" dialog with OAuth (no token in the URL). Stateless (no Durable Objects):
 * `@cloudflare/workers-oauth-provider` wraps the Worker, validates the bearer token on
 * /mcp, and passes the grant's props (set at consent) to the API handler via ctx.props.
 *
 * OAuth flow:
 *   claude.ai → /authorize (DCR + PKCE handled by the provider)
 *     → defaultHandler redirects to vicsee.com/connect/authorize (Better Auth login + consent)
 *     → vicsee.com mints/fetches the user's api_key, HMAC-signs { userId, apiKey, wreq }
 *     → /callback verifies the handoff → completeAuthorization({ props: { userId, apiKey } })
 *     → provider issues code/token to claude.ai
 *   then every tool call → /mcp (bearer token) → ctx.props.apiKey → VicSeeClient.
 *
 * Replaces the v1 secret-URL transport (no partner was on it — #231 P5). vicsee_upload
 * stays stdio-only (it reads the local filesystem).
 */

import { createMcpHandler } from 'agents/mcp';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  OAuthProvider,
  type AuthRequest,
  type OAuthHelpers,
} from '@cloudflare/workers-oauth-provider';

import { verifyHandoff } from './handoff.js';
import { registerCoreTools } from './tools-core.js';
import { VicSeeClient } from './vicsee-client.js';

interface Env {
  /** Required by OAuthProvider — stores tokens, grants, and DCR clients. */
  OAUTH_KV: KVNamespace;
  /** Injected by the library into the default/api handlers. */
  OAUTH_PROVIDER: OAuthHelpers;
  /** Shared HMAC secret signing the vicsee.com consent handoff (matches vicsee-v2). */
  MCP_CONNECT_SIGNING_SECRET: string;
  /** Where /authorize delegates login: https://vicsee.com/connect/authorize */
  VICSEE_CONSENT_URL: string;
  /** vicsee-v2 endpoint resolving userId -> api_key, e.g. https://vicsee.com/api/v1/internal/mcp/resolve-user-key */
  VICSEE_RESOLVE_USER_KEY_URL: string;
  /** Shared secret for the resolve endpoint (matches vicsee-v2 MCP_RESOLVE_SECRET). */
  MCP_RESOLVE_SECRET: string;
}

interface GrantProps {
  userId: string;
  apiKey: string;
}

/** Round-trip the parsed AuthRequest through vicsee.com as an opaque (unicode-safe) blob. */
const encodeWreq = (r: AuthRequest): string =>
  btoa(unescape(encodeURIComponent(JSON.stringify(r))));
const decodeWreq = (s: string): AuthRequest =>
  JSON.parse(decodeURIComponent(escape(atob(s)))) as AuthRequest;

/**
 * Resolve userId -> the user's connector api_key over a secret-gated server-to-server
 * call (the key is never carried in the browser redirect). Returns null on failure.
 */
async function resolveUserKey(userId: string, env: Env): Promise<string | null> {
  const res = await fetch(env.VICSEE_RESOLVE_USER_KEY_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${env.MCP_RESOLVE_SECRET}`,
    },
    body: JSON.stringify({ userId }),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { data?: { api_key?: string } };
  return body?.data?.api_key ?? null;
}

/**
 * Build the MCP server for a resolved api_key and serve it over Streamable HTTP.
 * MCP is served at BOTH the bare root and /mcp (see apiRoute below); use the actual
 * request path so the handler matches whichever the client connected to — claude.ai
 * (and Codex, etc.) post to the exact URL the user pasted (bare domain or /mcp).
 */
function serveMcp(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  apiKey: string
): Response | Promise<Response> {
  const server = new McpServer({ name: 'vicsee', version: '0.6.0' });
  registerCoreTools(server, new VicSeeClient({ apiKey }), {}); // URL-in only
  return createMcpHandler(server, { route: new URL(request.url).pathname })(
    request,
    env,
    ctx
  );
}

/**
 * MCP API handler — runs AFTER OAuth validates the bearer token. The grant's props
 * (set at completeAuthorization) arrive on ctx.props; build the client per request.
 */
const apiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const props = (ctx as ExecutionContext & { props?: GrantProps }).props;
    const apiKey = props?.apiKey;
    if (!apiKey) return new Response('Unauthorized', { status: 401 });
    return serveMcp(request, env, ctx, apiKey);
  },
};

/**
 * defaultHandler — owns the OAuth UI flow: /authorize delegates login to vicsee.com,
 * /callback verifies the signed handoff and completes the grant.
 */
const defaultHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const provider = env.OAUTH_PROVIDER;
    const url = new URL(request.url);

    if (url.pathname === '/authorize') {
      let oauthReq: AuthRequest;
      try {
        oauthReq = await provider.parseAuthRequest(request);
      } catch {
        return new Response('Invalid authorization request', { status: 400 });
      }
      const to = new URL(env.VICSEE_CONSENT_URL);
      to.searchParams.set('wreq', encodeWreq(oauthReq));
      return Response.redirect(to.toString(), 302);
    }

    if (url.pathname === '/callback') {
      const wreqRaw = url.searchParams.get('wreq');

      // User denied consent on vicsee.com → relay the OAuth error to claude.ai.
      const denied = url.searchParams.get('error');
      if (denied) {
        if (!wreqRaw) return new Response(denied, { status: 400 });
        const r = decodeWreq(wreqRaw);
        // `wreq` is unsigned + attacker-forgeable, so NEVER redirect to its
        // redirectUri blindly (open-redirect). Validate against the registered
        // DCR client first — same guarantee the success path gets from the lib.
        const client = await provider.lookupClient(r.clientId);
        if (!client || !client.redirectUris?.includes(r.redirectUri)) {
          return new Response('Invalid redirect_uri', { status: 400 });
        }
        const back = new URL(r.redirectUri);
        back.searchParams.set('error', denied);
        if (r.state) back.searchParams.set('state', r.state);
        return Response.redirect(back.toString(), 302);
      }

      const h = url.searchParams.get('h');
      if (!h) return new Response('Missing handoff', { status: 400 });

      const payload = await verifyHandoff(h, env.MCP_CONNECT_SIGNING_SECRET);
      if (!payload) return new Response('Invalid or expired handoff', { status: 401 });

      // Resolve the api_key server-to-server — it is never carried in the browser URL.
      const apiKey = await resolveUserKey(payload.userId, env);
      if (!apiKey) return new Response('Could not resolve account', { status: 502 });

      const oauthReq = decodeWreq(payload.wreq);
      const props: GrantProps = { userId: payload.userId, apiKey };
      const { redirectTo } = await provider.completeAuthorization({
        request: oauthReq,
        userId: payload.userId,
        metadata: {},
        scope: oauthReq.scope ?? [],
        props,
      });
      return Response.redirect(redirectTo, 302);
    }

    return new Response('Not found', { status: 404 });
  },
};

const oauth = new OAuthProvider({
  // Serve MCP at BOTH the bare root and /mcp so users can paste either
  // `https://mcp.vicsee.com` or `https://mcp.vicsee.com/mcp`. The library
  // special-cases `'/'` to match the EXACT root only (not a prefix), so
  // /authorize and /callback still fall through to defaultHandler — no collision.
  apiRoute: ['/mcp', '/'],
  apiHandler,
  defaultHandler,
  authorizeEndpoint: '/authorize',
  tokenEndpoint: '/token',
  clientRegistrationEndpoint: '/register',
});

/**
 * Dual-auth front door. Claude runs the OAuth dance, but non-Claude clients (Codex,
 * Cursor, raw HTTP) can only send a static `Authorization: Bearer <token>` — the
 * industry-standard remote-MCP + bearer pattern. We let those connect to the SAME URL
 * with a VicSee `sk-...` API key: intercept it on the MCP routes and serve directly,
 * authenticating tool calls against /api/v1 exactly like the stdio package does.
 *
 * Everything else falls through to OAuthProvider unchanged — OAuth access tokens (which
 * are never `sk-`-prefixed, so they can't collide), plus /authorize, /callback, /token,
 * and /register. The Claude flow is byte-for-byte untouched.
 */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === '/mcp' || pathname === '/') {
      const m = (request.headers.get('authorization') ?? '').match(
        /^Bearer\s+(sk-\S+?)\s*$/i
      );
      if (m) return serveMcp(request, env, ctx, m[1]);
    }
    return oauth.fetch(request, env, ctx);
  },
};
