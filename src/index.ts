#!/usr/bin/env node
/**
 * VicSee MCP Server — generate, edit, and upscale AI video & images from any agent.
 *
 * Wraps VicSee's public API (https://vicsee.com/api/v1) as MCP tools over stdio.
 * Auth: set VICSEE_API_KEY (get one at https://vicsee.com → Settings → API).
 *
 * The 6 generation/query tools are shared with the hosted Worker transport via
 * src/tools-core.ts. This file adds the stdio-only bits: local-file inlining and
 * the vicsee_upload tool (both read the local filesystem).
 */

import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { registerCoreTools, tool } from './tools-core.js';
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

/**
 * vicsee_upload: local file extension → MIME + kind. Used to host a local file
 * at a public cdn.vicsee.com URL (the robust path for reference-to-video, where
 * inline base64 truncates in tool-call output). MIME values must match the
 * server's /api/v1/upload allowlist.
 */
const UPLOAD_MIME: Record<string, { contentType: string; kind: 'image' | 'video' | 'audio' }> = {
  '.jpg': { contentType: 'image/jpeg', kind: 'image' },
  '.jpeg': { contentType: 'image/jpeg', kind: 'image' },
  '.png': { contentType: 'image/png', kind: 'image' },
  '.webp': { contentType: 'image/webp', kind: 'image' },
  '.gif': { contentType: 'image/gif', kind: 'image' },
  '.avif': { contentType: 'image/avif', kind: 'image' },
  '.heic': { contentType: 'image/heic', kind: 'image' },
  '.heif': { contentType: 'image/heif', kind: 'image' },
  '.mp4': { contentType: 'video/mp4', kind: 'video' },
  '.mov': { contentType: 'video/quicktime', kind: 'video' },
  '.webm': { contentType: 'video/webm', kind: 'video' },
  '.mp3': { contentType: 'audio/mpeg', kind: 'audio' },
  '.wav': { contentType: 'audio/wav', kind: 'audio' },
};
const UPLOAD_SIZE_CAP: Record<'image' | 'video' | 'audio', number> = {
  image: 20 * 1024 * 1024,
  video: 100 * 1024 * 1024,
  audio: 20 * 1024 * 1024,
};

const client = new VicSeeClient({
  apiKey: process.env.VICSEE_API_KEY,
  baseUrl: process.env.VICSEE_BASE_URL,
});

const server = new McpServer({ name: 'vicsee', version: '0.4.0' });

// The 6 shared URL-in tools (also used by the hosted Worker). stdio passes
// resolveImageInputs so local file paths the agent gives are inlined as base64.
registerCoreTools(server, client, { resolveImages: resolveImageInputs });

// ---------------------------------------------------------------------------
// vicsee_upload — host a LOCAL file at a public URL (for use as a generate input)
// stdio-only: it reads the local filesystem, so it is NOT on the hosted Worker.
// ---------------------------------------------------------------------------
server.registerTool(
  'vicsee_upload',
  {
    title: 'Upload a local file',
    description:
      'Upload a LOCAL file (image, video, or audio) from this machine and get back a public https URL. Use the returned url as an input for vicsee_generate — e.g. drop it into reference_image_urls for a reference-to-video storyboard, or image_urls for image-to-video. PREFER this over inline base64 for references: large base64 strings get truncated in tool-call output and the model rejects them. The file uploads directly to storage; only its public URL comes back.',
    inputSchema: {
      file_path: z
        .string()
        .describe('Absolute path to a local file (image/video/audio) on this machine.'),
    },
  },
  ({ file_path }) =>
    tool(async () => {
      const ext = extname(file_path).toLowerCase();
      const meta = UPLOAD_MIME[ext];
      if (!meta) {
        throw new VicSeeError(
          'UNSUPPORTED_FILE',
          `Cannot upload "${file_path}". Supported types: ${Object.keys(UPLOAD_MIME).join(', ')}.`,
          400,
        );
      }
      let bytes: Buffer;
      try {
        bytes = await readFile(file_path);
      } catch {
        throw new VicSeeError('FILE_NOT_FOUND', `Could not read local file "${file_path}".`, 400);
      }
      const sizeBytes = bytes.byteLength;
      const cap = UPLOAD_SIZE_CAP[meta.kind];
      if (sizeBytes > cap) {
        throw new VicSeeError(
          'FILE_TOO_LARGE',
          `File is ${(sizeBytes / 1024 / 1024).toFixed(1)} MB; max for ${meta.kind} is ${cap / 1024 / 1024} MB.`,
          400,
        );
      }
      // 1. Ask VicSee to sign a presigned upload.
      const sign = await client.uploadSign({ contentType: meta.contentType, sizeBytes });
      // 2. PUT the bytes DIRECT to storage (presigned URL — no baseUrl, no auth header).
      let put: Response;
      try {
        put = await fetch(sign.uploadUrl, {
          method: 'PUT',
          headers: { 'Content-Type': meta.contentType },
          body: new Uint8Array(bytes),
        });
      } catch (err) {
        throw new VicSeeError('UPLOAD_FAILED', `Upload PUT failed: ${(err as Error).message}`, 0);
      }
      if (!put.ok) {
        throw new VicSeeError('UPLOAD_FAILED', `Upload PUT rejected: HTTP ${put.status}`, put.status);
      }
      // 3. Hand back the public URL for the agent to use as a generate input.
      return { url: sign.publicUrl, expires_at: sign.expiresAt };
    }),
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
