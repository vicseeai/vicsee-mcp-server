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
        `${field} must be public https URLs — this hosted connector can't read local files or conversation attachments. Got: ${bad.join(', ')}. Host the image at a public URL (one that opens with no login), or use the @vicsee/mcp-server npm package, which uploads local files for you.`,
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
  // VicSee #303: this used to offer "a base64 data URI" as a co-equal option on both branches.
  // On the hosted connector that reads as permission to convert an image the user attached to
  // the chat — Claude starts emitting megabytes of base64 as tool arguments and never finishes,
  // and nothing reaches this Worker, so no error can fire (live repro 2026-09-06). Say plainly
  // that an attachment cannot be used. On stdio, inline base64 gets truncated in tool-call
  // output and rejected past a few tens of KB; vicsee_upload is the path that works.
  const imageSourceHelp = localFiles
    ? 'a public https URL, or a local file path (prefer vicsee_upload for anything larger than a thumbnail — inline base64 gets truncated in tool-call output and rejected)'
    : "a public https URL only. An image attached to this conversation cannot be used — this connector has no access to its bytes, and trying to base64-encode it will hang the request. Ask the user for a public URL that opens with no login, or point them to the @vicsee/mcp-server npm package, which uploads local files";
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
  // vicsee_estimate — exact credit cost of a vicsee_generate call, without running it (#313)
  // -------------------------------------------------------------------------
  server.registerTool(
    'vicsee_estimate',
    {
      title: 'Estimate credit cost (no charge)',
      description:
        'Return the EXACT credits a vicsee_generate call will charge, without generating anything. Takes the same arguments as vicsee_generate. The server runs the identical validation, model/resolution resolution and per-second billing (probing any reference video for its length) and stops before the charge, so `credits` is what vicsee_generate will deduct. Also returns `resolvedParams` (the settings that will actually apply, including defaults you did not send), `creditsRemaining` and `sufficient`. Call this before vicsee_generate whenever the user cares about cost, is comparing models, or is attaching a video reference (per-second billing across input + output). Invalid requests return the same error vicsee_generate would, so it also works as a free dry run.',
      inputSchema: {
        model: z.string().describe('Model id from vicsee_list_models — exactly what you will pass to vicsee_generate'),
        prompt: z.string().optional().describe('The prompt you will send (required for most models)'),
        image_urls: z.array(z.string()).optional().describe('As for vicsee_generate. Public https URLs (nothing is inlined for an estimate).'),
        reference_image_urls: z.array(z.string()).optional().describe('As for vicsee_generate. Public https URLs.'),
        reference_video_urls: z.array(z.string()).optional().describe('As for vicsee_generate. Include it: a video reference switches billing to per-second and the estimate probes the clip length.'),
        reference_audio_urls: z.array(z.string()).optional().describe('As for vicsee_generate.'),
        video_url: z.string().optional().describe('Video-edit models only, as for vicsee_generate.'),
        audio_setting: z.string().optional().describe('Video-edit models only, as for vicsee_generate.'),
        duration: z.number().optional().describe('Video length in seconds. Send it explicitly; the default is often not the cheapest tier.'),
        aspect_ratio: z.string().optional().describe('As for vicsee_generate'),
        resolution: z.string().optional().describe('As for vicsee_generate. Send it explicitly; the default on most video models is NOT the cheapest tier.'),
        output_format: z.string().optional().describe('As for vicsee_generate'),
        audio: z.boolean().optional().describe('As for vicsee_generate'),
        nsfw_checker: z.boolean().optional().describe('As for vicsee_generate'),
        extra: z.record(z.unknown()).optional().describe('Any additional model-specific params, as for vicsee_generate'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ model, extra, ...rest }) =>
      tool(async () => {
        const input: Record<string, unknown> = { ...(extra ?? {}) };
        for (const [k, v] of Object.entries(rest)) {
          if (v !== undefined) input[k] = v;
        }
        return client.estimate({ model, input });
      }),
  );

  // -------------------------------------------------------------------------
  // vicsee_generate — create a generation task (async: then poll vicsee_get_task)
  // -------------------------------------------------------------------------
  server.registerTool(
    'vicsee_generate',
    {
      title: 'Generate image or video',
      description:
        'Create an AI image or video with VicSee. Generation is ASYNCHRONOUS: this returns a task `id` immediately, then poll `vicsee_get_task` with that id until status is "completed" (the result URL appears in result.url) or "failed". Use vicsee_list_models to pick a `model` and see its valid options. For image-to-video / image-to-image, pass source images in `image_urls`. For reference-to-video models (e.g. "seedance-2-5-reference-to-video"), pass references in reference_image_urls / reference_video_urls / reference_audio_urls and refer to them positionally in the prompt as @Image1, @Image2, … For native 2K output at the best value per second use the "minimax-h3-*" models (MiniMax H3, also called Hailuo 03): 4-15s, 768P/2K, always-on stereo audio, billed per second (25 credits/s at 768P, 40 at 2K). Note "minimax-h3-image-to-video" takes the first frame in image_urls[0] and an optional last frame in image_urls[1], and has NO aspect_ratio parameter — the ratio follows the frames; "minimax-h3-reference-to-video" requires at least one image OR video reference (audio alone is rejected) and accepts at most 5 reference images. For clips longer than 15 seconds use the "seedance-2-5-*" models, which generate up to 30 seconds (480p/720p only, no 1080p or 4K); the "seedance-2-0-*" models cap at 15 seconds but add 1080p and 4K. Note that supplying a video reference switches billing to per-second across input + output, so a long reference clip costs considerably more than the duration table suggests. When cost matters, call vicsee_estimate with the same arguments FIRST — it returns the exact credits this call will charge and creates nothing. IMAGE inputs (image_urls, reference_image_urls) must be ' +
        imageSourceHelp +
        '. VIDEO/AUDIO inputs (reference_video_urls, reference_audio_urls) must be public https URLs. For video-edit models (e.g. "happyhorse-video-edit"), pass the source clip in video_url and optionally set audio_setting ("auto" or "origin"). Input images must have an aspect ratio between 0.4 and 2.5 (width÷height) and at most 36MP — wide-strip composites (e.g. 3:1) are rejected; use a 2×2 grid layout instead. On "failed" tasks, read error.key and error.message from vicsee_get_task — they state the actual reason (do not guess).',
      inputSchema: {
        model: z.string().describe('Model id from vicsee_list_models, e.g. "nano-banana-pro-text-to-image" or "seedance-2-5-text-to-video"'),
        prompt: z.string().optional().describe('Text prompt (required for most models). Pass it here as a plain string — this server builds the correct request envelope for you, so you never need to decide between a top-level prompt and input.prompt.'),
        image_urls: z.array(z.string()).optional().describe(`Source image(s) for image-to-video / image-to-image. Each may be ${imageSourceHelp}.`),
        reference_image_urls: z.array(z.string()).optional().describe(`Reference-to-video only. Per-model caps: Seedance 2.5 up to 10, the 2.0 family (2.0 / Fast / Mini) up to 7, MiniMax H3 up to 5. ALWAYS confirm against maxImages in vicsee_list_models — that is the authoritative value and these numbers can lag. Each may be ${imageSourceHelp}. Refer to them in the prompt as @Image1, @Image2, …`),
        reference_video_urls: z.array(z.string()).optional().describe('Reference-to-video only: up to 3 public https video URLs, each 2s or longer. TOTAL across all clips must not exceed 30s on Seedance 2.5, or 15s on the 2.0 family (2.0 / Fast / Mini) and MiniMax H3. The total is the binding limit, not the per-clip length. NOTE: supplying a video reference switches billing to per-second across input + output on every model that supports it, so a long clip costs far more than the output duration suggests.'),
        reference_audio_urls: z.array(z.string()).optional().describe('Reference-to-video only: up to 3 public https audio URLs. TOTAL across all clips must not exceed 30s on Seedance 2.5, or 15s on the 2.0 family. MiniMax H3 accepts up to 3 audio clips but requires at least one IMAGE or VIDEO reference as well — audio alone is rejected. Accepted: mp3, wav, aac, m4a, ogg.'),
        video_url: z.string().optional().describe('Video-edit models (e.g. "happyhorse-video-edit") only: one public https video URL, 3-15s, to edit.'),
        audio_setting: z.string().optional().describe('Video-edit models only: "auto" (regenerate audio) or "origin" (keep the source audio).'),
        duration: z.number().optional().describe('Video length in seconds (e.g. 5, 6, 10, 15) — video models only'),
        aspect_ratio: z.string().optional().describe('e.g. "16:9", "9:16", "1:1", "landscape", "portrait"'),
        // VicSee #296: this used to read `e.g. "1K", "2K", "4K", "720P", "768P", "1080P"`.
        // The families share no enum, and "720P" sat one slot from "768P" — an agent picking
        // the cheap MiniMax H3 tier from that menu could reasonably choose the one H3 rejects
        // outright. One partner's agent did, three times, and the retries cost them 675 credits.
        // Never list an example value that is fatal on some model.
        resolution: z.string().optional().describe('Model-specific — call vicsee_list_models and use a value from that model\'s options.resolution. The families do NOT share an enum: minimax-h3-* accept ONLY "768P" or "2K" (no 720p, 1080p or 4K); seedance-* use lowercase "480p"/"720p"/"1080p"; image models use "1K"/"2K"/"4K". Omitting it takes that model\'s default, which on most video models is NOT the cheapest tier — send it explicitly.'),
        output_format: z.string().optional().describe('Image output format, e.g. "png" or "jpeg"'),
        audio: z.boolean().optional().describe('Enable native audio (supported video models). Not applicable to MiniMax H3, which always generates audio and has no toggle — the field is ignored there.'),
        nsfw_checker: z
          .boolean()
          .optional()
          .describe(
            'Seedance 2 only. Set false to relax the provider content/audio sensitivity filter (helps when benign dialogue/SFX is wrongly flagged). Honored ONLY for approved partner accounts; ignored otherwise. Model-level safety always applies.'
          ),
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
        'Poll a generation or upscale task by its id. IMPORTANT: finished media URLs are kept for 7 days only — result.expires_at is the exact time the URL stops working; download or re-host anything the user wants to keep. status is one of "pending" | "processing" | "queued" | "completed" | "failed". When "completed", the media URL is in result.url (videos/images) or result.songs (music). When "failed", details are in error. Poll every few seconds until completed or failed.',
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
        'Upscale a publicly accessible image (JPEG/PNG/WebP). Asynchronous: returns a task id — poll vicsee_get_task until completed. upscale_factor defaults to "2" (max "4"). Credits are tiered by OUTPUT size (input megapixels × factor²): ≤24MP = 20, ≤48MP = 40, ≤96MP = 80; outputs above 96MP are rejected.',
      inputSchema: {
        image_url: z.string().describe('Publicly accessible image URL'),
        upscale_factor: z.enum(['1', '2', '4']).optional().describe('Upscale factor (default "2"; 8x is not supported)'),
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
