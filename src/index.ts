#!/usr/bin/env node
/**
 * VicSee MCP Server — generate, edit, and upscale AI video & images from any agent.
 *
 * Wraps VicSee's public API (https://vicsee.com/api/v1) as MCP tools over stdio.
 * Auth: set VICSEE_API_KEY (get one at https://vicsee.com → Settings → API).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { VicSeeClient, VicSeeError } from './vicsee-client.js';

const client = new VicSeeClient({
  apiKey: process.env.VICSEE_API_KEY,
  baseUrl: process.env.VICSEE_BASE_URL,
});

const server = new McpServer({ name: 'vicsee', version: '0.1.0' });

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
      'Create an AI image or video with VicSee. Generation is ASYNCHRONOUS: this returns a task `id` immediately, then poll `vicsee_get_task` with that id until status is "completed" (the result URL appears in result.url) or "failed". Use vicsee_list_models to pick a `model` and see its valid options. For image-to-video / image-to-image, pass source URLs in `image_urls`.',
    inputSchema: {
      model: z.string().describe('Model id from vicsee_list_models, e.g. "nano-banana-pro-text-to-image" or "seedance-2-0-text-to-video"'),
      prompt: z.string().optional().describe('Text prompt (required for most models)'),
      image_urls: z.array(z.string()).optional().describe('Source image URL(s) for image-to-video / image-to-image'),
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
  ({ model, extra, ...rest }) => {
    const input: Record<string, unknown> = { ...(extra ?? {}) };
    for (const [k, v] of Object.entries(rest)) {
      if (v !== undefined) input[k] = v;
    }
    return tool(() => client.generate({ model, input }));
  },
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
