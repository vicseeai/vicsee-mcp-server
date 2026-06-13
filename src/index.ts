#!/usr/bin/env node
/**
 * VicSee MCP Server — generate, edit, and upscale AI video & images from any agent.
 *
 * Wraps VicSee's public API (https://vicsee.com/api/v1) as MCP tools over stdio.
 * Auth: set VICSEE_API_KEY (get one at https://vicsee.com → Settings → API).
 */

import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { VicSeeClient, VicSeeError } from './vicsee-client.js';

/**
 * The VicSee API needs every image input as a PUBLIC https URL or an inline
 * base64 data: URI — never a local filesystem path. Since this MCP server runs
 * locally (stdio), it can read a local file the agent passes and inline it as a
 * data: URI. http(s) URLs and existing data: URIs pass through untouched.
 */
const IMAGE_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
};

async function resolveImageInput(value: string): Promise<string> {
  if (/^(https?:\/\/|data:)/i.test(value)) return value;
  // Anything else is treated as a local file path → read + base64-encode.
  const ext = extname(value).toLowerCase();
  const mime = IMAGE_MIME[ext];
  if (!mime) {
    throw new VicSeeError(
      'UNSUPPORTED_LOCAL_FILE',
      `Cannot inline local file "${value}". Supported local image types: ${Object.keys(IMAGE_MIME).join(', ')}. For video/audio inputs, pass a public https URL.`,
      400,
    );
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(value);
  } catch {
    throw new VicSeeError('FILE_NOT_FOUND', `Could not read local file "${value}".`, 400);
  }
  return `data:${mime};base64,${bytes.toString('base64')}`;
}

async function resolveImageInputs(arr?: string[]): Promise<string[] | undefined> {
  if (!Array.isArray(arr) || arr.length === 0) return arr;
  return Promise.all(arr.map(resolveImageInput));
}

const client = new VicSeeClient({
  apiKey: process.env.VICSEE_API_KEY,
  baseUrl: process.env.VICSEE_BASE_URL,
});

const server = new McpServer({ name: 'vicsee', version: '0.2.0' });

/** Wrap a handler: return pretty JSON on success, a clear error message on failure. */
function tool(run: () => Promise<unknown>) {
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

// ---------------------------------------------------------------------------
// vicsee_list_models — discover what's available (public, no key needed)
// ---------------------------------------------------------------------------
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
  },
  ({ type }) => tool(() => client.listModels(type)),
);

// ---------------------------------------------------------------------------
// vicsee_generate — create a generation task (async: then poll vicsee_get_task)
// ---------------------------------------------------------------------------
server.registerTool(
  'vicsee_generate',
  {
    title: 'Generate image or video',
    description:
      'Create an AI image or video with VicSee. Generation is ASYNCHRONOUS: this returns a task `id` immediately, then poll `vicsee_get_task` with that id until status is "completed" (the result URL appears in result.url) or "failed". Use vicsee_list_models to pick a `model` and see its valid options. For image-to-video / image-to-image, pass source images in `image_urls`. For reference-to-video models (e.g. "seedance-2-0-reference-to-video"), pass references in reference_image_urls / reference_video_urls / reference_audio_urls and refer to them positionally in the prompt as @Image1, @Image2, … IMAGE inputs (image_urls, reference_image_urls) may be a public https URL, a LOCAL FILE PATH (this server reads and base64-encodes it for you), or a base64 data URI. VIDEO/AUDIO inputs (reference_video_urls, reference_audio_urls) must be public https URLs.',
    inputSchema: {
      model: z.string().describe('Model id from vicsee_list_models, e.g. "nano-banana-pro-text-to-image" or "seedance-2-0-text-to-video"'),
      prompt: z.string().optional().describe('Text prompt (required for most models)'),
      image_urls: z.array(z.string()).optional().describe('Source image(s) for image-to-video / image-to-image. Each may be a public https URL, a local file path (auto base64-encoded by this server), or a base64 data URI.'),
      reference_image_urls: z.array(z.string()).optional().describe('Reference-to-video only: up to 7 reference images. Each may be a public https URL, a local file path (auto base64-encoded), or a base64 data URI. Refer to them in the prompt as @Image1, @Image2, …'),
      reference_video_urls: z.array(z.string()).optional().describe('Reference-to-video only: up to 3 public https video URLs (2-15s each, ≤15s total).'),
      reference_audio_urls: z.array(z.string()).optional().describe('Reference-to-video only: up to 3 public https audio URLs.'),
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
  },
  ({ model, extra, ...rest }) =>
    tool(async () => {
      // Inline any local image file paths the agent passed (image_urls /
      // reference_image_urls) as base64 data: URIs before sending to the API.
      rest.image_urls = await resolveImageInputs(rest.image_urls);
      rest.reference_image_urls = await resolveImageInputs(rest.reference_image_urls);
      const input: Record<string, unknown> = { ...(extra ?? {}) };
      for (const [k, v] of Object.entries(rest)) {
        if (v !== undefined) input[k] = v;
      }
      return client.generate({ model, input });
    }),
);

// ---------------------------------------------------------------------------
// vicsee_get_task — poll a task until it's done
// ---------------------------------------------------------------------------
server.registerTool(
  'vicsee_get_task',
  {
    title: 'Get task status / result',
    description:
      'Poll a generation or upscale task by its id. status is one of "pending" | "processing" | "queued" | "completed" | "failed". When "completed", the media URL is in result.url (videos/images) or result.songs (music). When "failed", details are in error. Poll every few seconds until completed or failed.',
    inputSchema: {
      task_id: z.string().describe('The task id returned by vicsee_generate / vicsee_upscale_*'),
    },
  },
  ({ task_id }) => tool(() => client.getTask(task_id)),
);

// ---------------------------------------------------------------------------
// vicsee_upscale_image
// ---------------------------------------------------------------------------
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
  },
  ({ image_url, upscale_factor }) => tool(() => client.upscaleImage({ image_url, upscale_factor })),
);

// ---------------------------------------------------------------------------
// vicsee_upscale_video
// ---------------------------------------------------------------------------
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
  },
  ({ video_url, upscale_factor }) => tool(() => client.upscaleVideo({ video_url, upscale_factor })),
);

// ---------------------------------------------------------------------------
// vicsee_get_credits
// ---------------------------------------------------------------------------
server.registerTool(
  'vicsee_get_credits',
  {
    title: 'Get credit balance',
    description: 'Get the current VicSee credit balance for the configured API key.',
    inputSchema: {},
  },
  () => tool(() => client.getCredits()),
);

// ---------------------------------------------------------------------------
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdio servers must not write to stdout (it's the protocol channel); log to stderr.
  console.error('VicSee MCP server running on stdio.');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
