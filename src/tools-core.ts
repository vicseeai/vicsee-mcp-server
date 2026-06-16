/**
 * Shared, runtime-agnostic tool core for the VicSee MCP server (#231).
 *
 * Registers the 6 URL-in generation/query tools that work on BOTH transports:
 *   - stdio (src/index.ts)     — local npx package
 *   - Streamable HTTP (worker) — hosted mcp.vicsee.com connector
 *
 * The ONLY per-transport divergence is local-file handling in vicsee_generate:
 * stdio passes `opts.resolveImages` (reads local paths → base64 data URIs); the
 * Worker omits it (URL-in only — it can't read the user's filesystem). Everything
 * here is pure fetch/zod, no node:* — so it compiles for the Workers runtime.
 *
 * vicsee_upload stays stdio-only (it reads the local filesystem) and lives in
 * src/index.ts, not here.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { VicSeeClient, VicSeeError } from './vicsee-client.js';

export interface CoreToolOpts {
  /**
   * stdio-only: inline local image file paths (image_urls / reference_image_urls)
   * as base64 data: URIs before sending to the API. Omitted on the Worker, where
   * inputs must already be public https URLs.
   */
  resolveImages?: (arr?: string[]) => Promise<string[] | undefined>;
}

/** Wrap a handler: return pretty JSON on success, a clear error message on failure. */
export function tool(run: () => Promise<unknown>) {
  return (async () => {
    try {
      const data = await run();
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      const e = err as VicSeeError;
      const text =
        e instanceof VicSeeError
          ? `VicSee API error [${e.code}]: ${e.message}`
          : `Unexpected error: ${(err as Error).message}`;
      return { content: [{ type: 'text' as const, text }], isError: true };
    }
  })();
}

/** Inputs the upstream API can fetch on its own: a public http(s) URL or an inline data: URI. */
const isFetchableInput = (v: string): boolean => /^(https?:\/\/|data:)/i.test(v);

/**
 * Worker-only guard. The hosted connector can't read the user's filesystem, so every
 * image input must already be a public URL or a data: URI. Reject local-looking paths
 * up front with an actionable error — otherwise they're forwarded as unfetchable
 * "URLs" and fail before a task is even created, which (after a few in a row) trips
 * the MCP client's "server unreachable" circuit breaker and looks like an outage.
 */
function assertHostedImageInputs(rest: {
  image_urls?: string[];
  reference_image_urls?: string[];
}) {
  for (const field of ['image_urls', 'reference_image_urls'] as const) {
    const arr = rest[field];
    if (!Array.isArray(arr)) continue;
    const bad = arr.filter((v) => !isFetchableInput(v));
    if (bad.length) {
      throw new VicSeeError(
        'LOCAL_FILE_UNSUPPORTED',
        `${field} must be public https URLs or base64 data: URIs — this hosted connector can't read local files. Got: ${bad.join(', ')}. Host the image at a public URL (one that opens with no login), or use the @vicsee/mcp-server npm package, which uploads local files for you.`,
        400,
      );
    }
  }
}

/**
 * Register the 6 shared URL-in tools on a server bound to a given client.
 * Call once per server instance (stdio: once at startup; Worker: once per request).
 */
export function registerCoreTools(
  server: McpServer,
  client: VicSeeClient,
  opts: CoreToolOpts = {},
) {
  // Local-file inlining only exists on stdio (opts.resolveImages). On the hosted
  // Worker, image inputs must already be public URLs / data: URIs — reflect that in
  // the tool descriptions so agents don't try (and silently fail with) local paths.
  const localFiles = !!opts.resolveImages;
  const imageSourceHelp = localFiles
    ? 'a public https URL, a local file path (this server reads and base64-encodes it for you), or a base64 data URI'
    : "a public https URL or a base64 data URI (this hosted connector can't read local files — host the image at a public URL, or use the @vicsee/mcp-server npm package, which uploads local files for you)";
  // -------------------------------------------------------------------------
  // vicsee_list_models — discover what's available (public, no key needed)
  // -------------------------------------------------------------------------
  server.registerTool(
    'vicsee_list_models',
    {
      title: 'List VicSee models',
      description:
        'List available VicSee models with their capabilities and credit costs. Call this first to find a model id to pass to vicsee_generate. Optionally filter by media type.',
      inputSchema: {
        type: z
          .enum(['image', 'video', 'music'])
          .optional()
          .describe('Filter by media type'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ type }) => tool(() => client.listModels(type)),
  );

  // -------------------------------------------------------------------------
  // vicsee_generate — create a generation task (async: then poll vicsee_get_task)
  // -------------------------------------------------------------------------
  server.registerTool(
    'vicsee_generate',
    {
      title: 'Generate image or video',
      description:
        'Create an AI image or video with VicSee. Generation is ASYNCHRONOUS: this returns a task `id` immediately, then poll `vicsee_get_task` with that id until status is "completed" (the result URL appears in result.url) or "failed". Use vicsee_list_models to pick a `model` and see its valid options. For image-to-video / image-to-image, pass source images in `image_urls`. For reference-to-video models (e.g. "seedance-2-0-reference-to-video"), pass references in reference_image_urls / reference_video_urls / reference_audio_urls and refer to them positionally in the prompt as @Image1, @Image2, … IMAGE inputs (image_urls, reference_image_urls) may be ' +
        imageSourceHelp +
        '. VIDEO/AUDIO inputs (reference_video_urls, reference_audio_urls) must be public https URLs. For video-edit models (e.g. "happyhorse-video-edit"), pass the source clip in video_url and optionally set audio_setting ("auto" or "origin").',
      inputSchema: {
        model: z.string().describe('Model id from vicsee_list_models, e.g. "nano-banana-pro-text-to-image" or "seedance-2-0-text-to-video"'),
        prompt: z.string().optional().describe('Text prompt (required for most models)'),
        image_urls: z.array(z.string()).optional().describe(`Source image(s) for image-to-video / image-to-image. Each may be ${imageSourceHelp}.`),
        reference_image_urls: z.array(z.string()).optional().describe(`Reference-to-video only: up to 7 reference images. Each may be ${imageSourceHelp}. Refer to them in the prompt as @Image1, @Image2, …`),
        reference_video_urls: z.array(z.string()).optional().describe('Reference-to-video only: up to 3 public https video URLs (2-15s each, ≤15s total).'),
        reference_audio_urls: z.array(z.string()).optional().describe('Reference-to-video only: up to 3 public https audio URLs.'),
        video_url: z.string().optional().describe('Video-edit models (e.g. "happyhorse-video-edit") only: one public https video URL, 3-15s, to edit.'),
        audio_setting: z.string().optional().describe('Video-edit models only: "auto" (regenerate audio) or "origin" (keep the source audio).'),
        duration: z.number().optional().describe('Video length in seconds (e.g. 5, 6, 10, 15) — video models only'),
        aspect_ratio: z.string().optional().describe('e.g. "16:9", "9:16", "1:1", "landscape", "portrait"'),
        resolution: z.string().optional().describe('e.g. "1K", "2K", "4K", "720P", "1080P"'),
        output_format: z.string().optional().describe('Image output format, e.g. "png" or "jpeg"'),
        audio: z.boolean().optional().describe('Enable native audio (supported video models)'),
        extra: z
          .record(z.unknown())
          .optional()
          .describe('Any additional model-specific params (see the model\'s options from vicsee_list_models)'),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    ({ model, extra, ...rest }) =>
      tool(async () => {
        // stdio: inline any local image file paths as base64 data: URIs.
        // Worker: opts.resolveImages is undefined → reject local paths early with a
        // clear error (URL-in only), instead of forwarding an unfetchable path.
        if (opts.resolveImages) {
          rest.image_urls = await opts.resolveImages(rest.image_urls);
          rest.reference_image_urls = await opts.resolveImages(rest.reference_image_urls);
        } else {
          assertHostedImageInputs(rest);
        }
        const input: Record<string, unknown> = { ...(extra ?? {}) };
        for (const [k, v] of Object.entries(rest)) {
          if (v !== undefined) input[k] = v;
        }
        return client.generate({ model, input });
      }),
  );

  // -------------------------------------------------------------------------
  // vicsee_get_task — poll a task until it's done
  // -------------------------------------------------------------------------
  server.registerTool(
    'vicsee_get_task',
    {
      title: 'Get task status / result',
      description:
        'Poll a generation or upscale task by its id. status is one of "pending" | "processing" | "queued" | "completed" | "failed". When "completed", the media URL is in result.url (videos/images) or result.songs (music). When "failed", details are in error. Poll every few seconds until completed or failed.',
      inputSchema: {
        task_id: z.string().describe('The task id returned by vicsee_generate / vicsee_upscale_*'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ task_id }) => tool(() => client.getTask(task_id)),
  );

  // -------------------------------------------------------------------------
  // vicsee_upscale_image
  // -------------------------------------------------------------------------
  server.registerTool(
    'vicsee_upscale_image',
    {
      title: 'Upscale an image',
      description:
        'Upscale a publicly accessible image (JPEG/PNG/WebP). Asynchronous: returns a task id — poll vicsee_get_task until completed. upscale_factor defaults to "2".',
      inputSchema: {
        image_url: z.string().describe('Publicly accessible image URL'),
        upscale_factor: z.enum(['1', '2', '4', '8']).optional().describe('Upscale factor (default "2")'),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    ({ image_url, upscale_factor }) => tool(() => client.upscaleImage({ image_url, upscale_factor })),
  );

  // -------------------------------------------------------------------------
  // vicsee_upscale_video
  // -------------------------------------------------------------------------
  server.registerTool(
    'vicsee_upscale_video',
    {
      title: 'Upscale a video',
      description:
        'Upscale a publicly accessible video (MP4/MOV/MKV, up to 60s). Asynchronous: returns a task id — poll vicsee_get_task until completed. upscale_factor defaults to "2".',
      inputSchema: {
        video_url: z.string().describe('Publicly accessible video URL'),
        upscale_factor: z.enum(['1', '2', '4']).optional().describe('Upscale factor (default "2")'),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    ({ video_url, upscale_factor }) => tool(() => client.upscaleVideo({ video_url, upscale_factor })),
  );

  // -------------------------------------------------------------------------
  // vicsee_get_credits
  // -------------------------------------------------------------------------
  server.registerTool(
    'vicsee_get_credits',
    {
      title: 'Get credit balance',
      description: 'Get the current VicSee credit balance for the configured API key.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    () => tool(() => client.getCredits()),
  );
}
