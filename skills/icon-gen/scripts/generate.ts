#!/usr/bin/env bun

import { mkdir } from "node:fs/promises";
import { parseArgs } from "node:util";
import { join } from "node:path";

const OPENROUTER_IMAGES_URL = "https://openrouter.ai/api/v1/images";

/**
 * Parsed command-line options for icon generation.
 */
export type CliOptions = {
  prompt: string | undefined;
  outputDirectory: string | undefined;
  count: number;
  help: boolean;
};

/**
 * Dependencies and settings needed to generate icons.
 */
export type GenerateOptions = {
  apiKey: string;
  model: string;
  prompt: string;
  outputDirectory: string;
  count: number;
  fetchImplementation: (
    input: string | URL | Request,
    init: RequestInit | undefined,
  ) => Promise<Response>;
};

/**
 * Parses icon generator command-line arguments.
 *
 * @param args - Arguments excluding the Bun executable and script path.
 * @returns Validated command-line options.
 */
export function parseCli(args: string[]): CliOptions {
  const { values } = parseArgs({
    args,
    options: {
      prompt: { type: "string" },
      "output-dir": { type: "string" },
      count: { type: "string", default: "1" },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });

  const count = Number.parseInt(values.count, 10);
  if (!Number.isInteger(count) || count < 1 || count > 10) {
    throw new Error("--count must be an integer from 1 through 10");
  }

  return {
    prompt: values.prompt,
    outputDirectory: values["output-dir"],
    count,
    help: values.help,
  };
}

/**
 * Extracts image bytes and a safe file extension from an OpenRouter response.
 *
 * @param value - Decoded JSON returned by the OpenRouter Images API.
 * @returns The generated image bytes and matching extension.
 */
export function parseImageResponse(value: unknown): { bytes: Uint8Array; extension: string } {
  if (!isRecord(value) || !Array.isArray(value.data)) {
    throw new Error("OpenRouter returned an invalid image response");
  }

  const image = value.data[0];
  if (!isRecord(image) || typeof image.b64_json !== "string") {
    throw new Error("OpenRouter returned no generated image data");
  }

  const mediaType = typeof image.media_type === "string" ? image.media_type : "image/png";
  const extension = extensionForMediaType(mediaType);
  const bytes = new Uint8Array(Buffer.from(image.b64_json, "base64"));

  if (bytes.length === 0) {
    throw new Error("OpenRouter returned an empty generated image");
  }

  return { bytes, extension };
}

/**
 * Generates one or more square app icons with OpenRouter and writes them to disk.
 *
 * @param options - API credentials, prompt, output settings, and fetch dependency.
 * @returns Absolute or relative paths to the generated image files.
 */
export async function generateIcons(options: GenerateOptions): Promise<string[]> {
  await mkdir(options.outputDirectory, { recursive: true });

  const paths: string[] = [];
  for (let index = 0; index < options.count; index += 1) {
    const response = await options.fetchImplementation(OPENROUTER_IMAGES_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/wyattjoh/skills",
        "X-OpenRouter-Title": "icon-gen skill",
      },
      body: JSON.stringify({
        model: options.model,
        prompt: options.prompt,
        n: 1,
        resolution: "1K",
        aspect_ratio: "1:1",
      }),
    });

    if (!response.ok) {
      const detail = await readErrorDetail(response);
      throw new Error(`OpenRouter image generation failed (${response.status}): ${detail}`);
    }

    const generated = parseImageResponse(await response.json());
    const suffix = options.count === 1 ? "" : `-${index + 1}`;
    const path = join(options.outputDirectory, `icon${suffix}.${generated.extension}`);
    await Bun.write(path, generated.bytes);
    paths.push(path);
  }

  return paths;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function extensionForMediaType(mediaType: string): string {
  switch (mediaType.toLowerCase()) {
    case "image/png":
      return "png";
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    case "image/webp":
      return "webp";
    default:
      throw new Error(`OpenRouter returned unsupported media type: ${mediaType}`);
  }
}

async function readErrorDetail(response: Response): Promise<string> {
  const body = await response.text();
  if (body.length === 0) {
    return response.statusText || "unknown error";
  }

  try {
    const value: unknown = JSON.parse(body);
    if (isRecord(value) && isRecord(value.error) && typeof value.error.message === "string") {
      return value.error.message;
    }
  } catch {
    // Fall back to the response body below.
  }

  return body;
}

const HELP_TEXT = `
Generate app icons with OpenRouter

Usage:
  bun generate.ts --prompt <description> --output-dir <directory> [--count <1-10>]

Environment (validated and injected by varlock):
  OPENROUTER_API_KEY  Required OpenRouter API key
  OPENROUTER_MODEL    Required OpenRouter image model
`;

async function main(): Promise<void> {
  const options = parseCli(Bun.argv.slice(2));
  if (options.help) {
    console.log(HELP_TEXT.trim());
    return;
  }

  if (!options.prompt) {
    throw new Error("--prompt is required");
  }
  if (!options.outputDirectory) {
    throw new Error("--output-dir is required");
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is required; run this script through varlock");
  }

  const model = process.env.OPENROUTER_MODEL;
  if (!model) {
    throw new Error("OPENROUTER_MODEL is required; run this script through varlock");
  }

  const paths = await generateIcons({
    apiKey,
    model,
    prompt: options.prompt,
    outputDirectory: options.outputDirectory,
    count: options.count,
    fetchImplementation: fetch,
  });

  for (const path of paths) {
    console.log(path);
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    process.exitCode = 1;
  });
}
