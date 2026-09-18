/**
 * Streaming JSONL line reader.
 *
 * Reads a file line by line without loading the whole file into memory,
 * tolerating malformed lines (counted and skipped rather than throwing).
 * Supports resuming from a known number of already-ingested leading lines
 * so callers can tail a growing file instead of re-reading it from the top.
 */

const NEWLINE = 0x0a;

export interface JsonlLine {
  /** 1-indexed line number within the file. */
  lineNumber: number;
  /** Byte offset (from the start of the file) where this line begins. */
  byteOffset: number;
  /** Parsed JSON value. */
  value: unknown;
}

export interface ReadJsonlOptions {
  /**
   * Number of leading complete lines to skip without parsing. Use this to
   * resume reading a file that has already been ingested up to this line.
   */
  fromLine?: number;
}

export interface JsonlReadResult {
  /** Successfully parsed lines, in file order, after `fromLine`. */
  lines: JsonlLine[];
  /** Count of complete lines that failed JSON.parse. */
  malformedCount: number;
  /** Absolute line number of the last complete line seen (0 if none). */
  lastLineNumber: number;
  /** Absolute byte offset immediately after the last complete line seen. */
  lastLineEndOffset: number;
}

/**
 * Stream-read a JSONL file, optionally skipping a known number of leading
 * complete lines. A trailing line with no terminating newline is treated as
 * incomplete and is not parsed or counted; it is left for a future read once
 * the writer finishes it.
 */
export async function readJsonl(
  path: string,
  options: ReadJsonlOptions = {},
): Promise<JsonlReadResult> {
  const fromLine = options.fromLine ?? 0;

  const lines: JsonlLine[] = [];
  let malformedCount = 0;
  let lineNumber = 0;
  let lastLineEndOffset = 0;
  let byteOffset = 0;

  const file = Bun.file(path);
  const stream = file.stream();
  const reader = stream.getReader();
  const decoder = new TextDecoder();

  let pending: Uint8Array = new Uint8Array(0);

  const consumeLine = (bytes: Uint8Array, startOffset: number): void => {
    lineNumber += 1;
    const endOffset = startOffset + bytes.length + 1; // +1 for the newline byte
    lastLineEndOffset = endOffset;

    if (lineNumber <= fromLine) {
      return;
    }

    const text = decoder.decode(bytes).trim();
    if (text.length === 0) {
      return;
    }

    try {
      const value = JSON.parse(text) as unknown;
      lines.push({ lineNumber, byteOffset: startOffset, value });
    } catch {
      malformedCount += 1;
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.length === 0) continue;

      const combined = new Uint8Array(pending.length + value.length);
      combined.set(pending, 0);
      combined.set(value, pending.length);

      let searchStart = 0;
      let newlineIndex = combined.indexOf(NEWLINE, searchStart);
      while (newlineIndex !== -1) {
        const lineBytes = combined.subarray(searchStart, newlineIndex);
        consumeLine(lineBytes, byteOffset + searchStart);
        searchStart = newlineIndex + 1;
        newlineIndex = combined.indexOf(NEWLINE, searchStart);
      }

      byteOffset += searchStart;
      pending = combined.subarray(searchStart);
    }
  } finally {
    reader.releaseLock();
  }

  return {
    lines,
    malformedCount,
    lastLineNumber: lineNumber,
    lastLineEndOffset,
  };
}
