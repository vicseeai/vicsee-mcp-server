/**
 * Thin client for VicSee's public API (https://vicsee.com/api/v1).
 *
 * All responses use the envelope { success, data, error: { code, message } }.
 * This client unwraps `data` on success and throws VicSeeError on failure.
 */

const DEFAULT_BASE_URL = 'https://vicsee.com/api/v1';

export interface VicSeeConfig {
  apiKey?: string;
  baseUrl?: string;
}

export class VicSeeError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'VicSeeError';
    this.code = code;
    this.status = status;
  }
}

interface RequestOpts {
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  auth?: boolean; // default true
}

export class VicSeeClient {
  private apiKey?: string;
  private baseUrl: string;

  constructor(cfg: VicSeeConfig = {}) {
    this.apiKey = cfg.apiKey;
    this.baseUrl = (cfg.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  }

  private async request<T = any>(
    method: 'GET' | 'POST',
    path: string,
    opts: RequestOpts = {},
  ): Promise<T> {
    const auth = opts.auth !== false;
    if (auth && !this.apiKey) {
      throw new VicSeeError(
        'MISSING_API_KEY',
        'VICSEE_API_KEY is not set. Get a key at https://vicsee.com (Settings → API) and set it in the MCP server config.',
        401,
      );
    }

    const url = new URL(this.baseUrl + path);
    if (opts.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      }
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (auth && this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
    } catch (err) {
      throw new VicSeeError(
        'NETWORK_ERROR',
        `Could not reach VicSee API: ${(err as Error).message}`,
        0,
      );
    }

    let json: any = null;
    try {
      json = await res.json();
    } catch {
      // non-JSON response
    }

    if (!res.ok || (json && json.success === false)) {
      const code = json?.error?.code || `HTTP_${res.status}`;
      const message = json?.error?.message || res.statusText || 'Request failed';
      throw new VicSeeError(code, message, res.status);
    }

    return (json?.data ?? json) as T;
  }

  /** POST /generate — create a generation task. Returns { id, model, status, creditsUsed, creditsRemaining, createdAt }. */
  generate(payload: { model: string; input: Record<string, unknown> }) {
    return this.request('POST', '/generate', { body: payload });
  }

  /** GET /tasks/{id} — poll status. Returns { id, status, mediaType, result, error, ... }. result.url present when completed. */
  getTask(id: string) {
    return this.request('GET', `/tasks/${encodeURIComponent(id)}`);
  }

  /** GET /models — public, no auth. Optional type filter (image|video|music). */
  listModels(type?: string) {
    return this.request('GET', '/models', { auth: false, query: type ? { type } : undefined });
  }

  /** GET /credits — current balance. Returns { credits }. */
  getCredits() {
    return this.request('GET', '/credits');
  }

  /** POST /tools/upscale-video — { video_url, upscale_factor? }. Returns a task. */
  upscaleVideo(body: { video_url: string; upscale_factor?: string }) {
    return this.request('POST', '/tools/upscale-video', { body });
  }

  /** POST /tools/upscale-image — { image_url, upscale_factor? }. Returns a task. */
  upscaleImage(body: { image_url: string; upscale_factor?: string }) {
    return this.request('POST', '/tools/upscale-image', { body });
  }
}
