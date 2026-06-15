/**
 * Worker-side verify for the vicsee.com -> Worker OAuth consent handoff (#231 Phase 2).
 *
 * Mirrors vicsee-v2's src/shared/lib/connector-handoff.ts (which SIGNS with Node
 * crypto) using Web Crypto, so the Worker can VERIFY the `{ userId, apiKey, wreq, exp }`
 * blob vicsee.com hands back after the user approves consent. HMAC-SHA256 over the
 * same base64url `data` string with the same shared secret (MCP_CONNECT_SIGNING_SECRET).
 */

export interface HandoffPayload {
  userId: string;
  apiKey: string;
  /** Opaque Worker auth-request blob, round-tripped untouched. */
  wreq: string;
  /** Epoch ms expiry. */
  exp: number;
}

function base64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '';
  const bin = atob(b64 + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64url(buf: ArrayBuffer): string {
  const b = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Constant-time-ish string compare (equal length already checked by caller). */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Verify a `data.sig` handoff token: HMAC match + not expired. Returns payload or null. */
export async function verifyHandoff(
  token: string,
  secret: string
): Promise<HandoffPayload | null> {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const data = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  if (!safeEqual(bytesToBase64url(mac), sig)) return null;

  try {
    const body = JSON.parse(
      new TextDecoder().decode(base64urlToBytes(data))
    ) as HandoffPayload;
    if (!body.exp || Date.now() > body.exp) return null;
    if (!body.userId || !body.apiKey) return null;
    return body;
  } catch {
    return null;
  }
}
