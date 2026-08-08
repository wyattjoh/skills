#!/usr/bin/env bun

/**
 * Search Claude Code plans directory for content matching a pattern
 *
 * Usage:
 *   bun $SKILL_DIR/scripts/search-plans.ts --pattern="search term" [options]
 *
 * Options:
 *   --pattern=TERM         Search pattern (required, case-insensitive)
 *   --format=json|table    Output format (default: table)
 *   --limit=N              Maximum matches to return (default: 10)
 *   --context=N            Characters of context around match (default: 150)
 *   --claude-dir=PATH      Override ~/.claude directory location
 */

import { parseArgs } from "node:util";
import { promises as fs } from "node:fs";

export interface PlanMatch {
  filename: string;
  filepath: string;
  created: string;
  snippet: string;
  matchCount: number;
}

interface Options {
  pattern: string;
  format: "json" | "table";
  limit: number;
  context: number;
  claudeDir: string;
}

function parseOptions(args: string[]): Options {
  const { values: parsed, positionals } = parseArgs({
    args,
    options: {
      pattern: { type: "string" },
      format: { type: "string", default: "table" },
      "claude-dir": { type: "string" },
      limit: { type: "string", default: "10" },
      context: { type: "string", default: "150" },
    },
    allowPositionals: true,
  });

  void positionals;
  const homeDir = process.env.HOME || "~";

  if (!parsed.pattern) {
    console.error('Usage: search-plans.ts --pattern="search term" [options]');
    console.error("");
    console.error("Options:");
    console.error("  --pattern=TERM         Search pattern (required, case-insensitive)");
    console.error("  --format=json|table    Output format (default: table)");
    console.error("  --limit=N              Maximum matches to return (default: 10)");
    console.error("  --context=N            Characters of context around match (default: 150)");
    console.error("  --claude-dir=PATH      Override ~/.claude directory location");
    process.exit(1);
  }

  return {
    pattern: parsed.pattern,
    format: parsed.format as "json" | "table",
    limit: Number(parsed.limit),
    context: Number(parsed.context),
    claudeDir: (parsed["claude-dir"] as string | undefined) || `${homeDir}/.claude`,
  };
}

export function extractSnippet(
  text: string,
  pattern: string,
  contextLen: number,
): { snippet: string; matchCount: number } {
  const lowerText = text.toLowerCase();
  const lowerPattern = pattern.toLowerCase();

  // Count all matches
  let matchCount = 0;
  let searchPos = 0;
  while ((searchPos = lowerText.indexOf(lowerPattern, searchPos)) !== -1) {
    matchCount++;
    searchPos += lowerPattern.length;
  }

  // Get snippet around first match
  const index = lowerText.indexOf(lowerPattern);
  if (index === -1) return { snippet: "", matchCount: 0 };

  const start = Math.max(0, index - contextLen);
  const end = Math.min(text.length, index + pattern.length + contextLen);

  let snippet = text.slice(start, end);

  if (start > 0) snippet = "..." + snippet;
  if (end < text.length) snippet = snippet + "...";

  // Clean up for display
  snippet = snippet.replace(/\n+/g, " ").replace(/\s+/g, " ").trim();

  return { snippet, matchCount };
}

export async function getFileCreatedTime(filepath: string): Promise<string> {
  try {
    const stat = await fs.stat(filepath);
    return stat.birthtime?.toISOString() || stat.mtime?.toISOString() || "";
  } catch {
    return "";
  }
}

export async function searchPlans(options: Options): Promise<PlanMatch[]> {
  const plansDir = `${options.claudeDir}/plans`;
  const matches: PlanMatch[] = [];
  const patternLower = options.pattern.toLowerCase();

  try {
    const dirEntries = await fs.readdir(plansDir, { withFileTypes: true });
    for (const entry of dirEntries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;

      const filepath = `${plansDir}/${entry.name}`;

      try {
        const content = await Bun.file(filepath).text();
        const contentLower = content.toLowerCase();

        if (!contentLower.includes(patternLower)) continue;

        const { snippet, matchCount } = extractSnippet(content, options.pattern, options.context);
        if (matchCount === 0) continue;

        const created = await getFileCreatedTime(filepath);

        matches.push({
          filename: entry.name,
          filepath,
          created,
          snippet,
          matchCount,
        });

        if (matches.length >= options.limit) break;
      } catch {
        // Skip files that can't be read
      }
    }
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === "ENOENT") {
      throw Object.assign(new Error(`Plans directory not found: ${plansDir}`), {
        code: "ENOENT",
      });
    }
    throw err;
  }

  // Sort by match count (most relevant first)
  matches.sort((a, b) => b.matchCount - a.matchCount);

  return matches;
}

function formatDate(isoString: string): string {
  if (!isoString) return "unknown";
  const date = new Date(isoString);
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function outputTable(matches: PlanMatch[], pattern: string): void {
  if (matches.length === 0) {
    console.log(`No plans found matching "${pattern}"`);
    return;
  }

  console.log(`Found ${matches.length} plans matching "${pattern}":\n`);

  for (const match of matches) {
    const date = formatDate(match.created);
    const countLabel = match.matchCount === 1 ? "match" : "matches";

    console.log(`📋 ${match.filename} (${match.matchCount} ${countLabel})`);
    console.log(`   Created: ${date}`);
    console.log(`   ${match.snippet}`);
    console.log("");
  }

  console.log("─".repeat(80));
  console.log(`To read a plan file, use:`);
  console.log(`  cat ~/.claude/plans/<filename>`);
}

function outputJson(matches: PlanMatch[]): void {
  console.log(JSON.stringify(matches, null, 2));
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const matches = await searchPlans(options);

  if (options.format === "json") {
    outputJson(matches);
  } else {
    outputTable(matches, options.pattern);
  }
}

if (import.meta.main) {
  main().catch((err) => {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === "ENOENT" && err.message.includes("Plans directory")) {
      console.error(err.message);
      console.error("This is normal if you haven't used plan mode yet.");
      process.exit(0);
    }
    console.error("Error:", err.message);
    process.exit(1);
  });
}
