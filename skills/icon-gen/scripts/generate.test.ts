import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateIcons, parseCli, parseImageResponse } from "./generate.ts";

const temporaryDirectories: string[] = [];

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "icon-gen-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function failedFetchImplementation(): Promise<Response> {
  return Response.json({ error: { message: "Insufficient credits" } }, { status: 402 });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("parseCli", () => {
  it("parses required options and the default count", () => {
    expect(parseCli(["--prompt", "A compass", "--output-dir", "icons"])).toEqual({
      prompt: "A compass",
      outputDirectory: "icons",
      count: 1,
      help: false,
    });
  });

  it("accepts a variant count", () => {
    expect(parseCli(["--prompt", "A compass", "--output-dir", "icons", "--count", "3"])).toEqual({
      prompt: "A compass",
      outputDirectory: "icons",
      count: 3,
      help: false,
    });
  });

  it("rejects an unsupported variant count", () => {
    expect(() => parseCli(["--count", "0"])).toThrow(
      "--count must be an integer from 1 through 10",
    );
  });
});

describe("parseImageResponse", () => {
  it("decodes OpenRouter base64 image data", () => {
    const bytes = new Uint8Array([137, 80, 78, 71]);

    expect(
      parseImageResponse({
        data: [{ b64_json: Buffer.from(bytes).toString("base64"), media_type: "image/png" }],
      }),
    ).toEqual({ bytes, extension: "png" });
  });

  it("rejects responses without image data", () => {
    expect(() => parseImageResponse({ data: [] })).toThrow(
      "OpenRouter returned no generated image data",
    );
  });
});

describe("generateIcons", () => {
  it("requests one image per variant and writes each response", async () => {
    const outputDirectory = await createTemporaryDirectory();
    const requestBodies: unknown[] = [];
    let requestNumber = 0;
    const fetchImplementation = async (
      _input: string | URL | Request,
      init: RequestInit | undefined,
    ): Promise<Response> => {
      requestBodies.push(JSON.parse(String(init?.body)));
      requestNumber += 1;
      return Response.json({
        data: [
          {
            b64_json: Buffer.from([requestNumber]).toString("base64"),
            media_type: "image/png",
          },
        ],
      });
    };

    const paths = await generateIcons({
      apiKey: "test-key",
      model: "test/image-model",
      prompt: "A compass",
      outputDirectory,
      count: 3,
      fetchImplementation,
    });

    expect(paths).toEqual([
      join(outputDirectory, "icon-1.png"),
      join(outputDirectory, "icon-2.png"),
      join(outputDirectory, "icon-3.png"),
    ]);
    expect(requestBodies).toEqual([
      {
        model: "test/image-model",
        prompt: "A compass",
        n: 1,
        resolution: "1K",
        aspect_ratio: "1:1",
      },
      {
        model: "test/image-model",
        prompt: "A compass",
        n: 1,
        resolution: "1K",
        aspect_ratio: "1:1",
      },
      {
        model: "test/image-model",
        prompt: "A compass",
        n: 1,
        resolution: "1K",
        aspect_ratio: "1:1",
      },
    ]);
    expect(Array.from(await Bun.file(paths[0]).bytes())).toEqual([1]);
    expect(Array.from(await Bun.file(paths[1]).bytes())).toEqual([2]);
    expect(Array.from(await Bun.file(paths[2]).bytes())).toEqual([3]);
  });

  it("surfaces OpenRouter API errors", async () => {
    const outputDirectory = await createTemporaryDirectory();
    await expect(
      generateIcons({
        apiKey: "test-key",
        model: "test/image-model",
        prompt: "A compass",
        outputDirectory,
        count: 1,
        fetchImplementation: failedFetchImplementation,
      }),
    ).rejects.toThrow("OpenRouter image generation failed (402): Insufficient credits");
  });
});
