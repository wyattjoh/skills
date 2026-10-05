import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

import { Schema } from "effect";

const Package = Schema.Struct({ name: Schema.NonEmptyString, version: Schema.NonEmptyString });

/**
 * Async flags require the running Pi CLI's final-settlement boundary, not merely the
 * extension's installed dev dependency. Unknown/embedded hosts fail closed; legacy
 * tools remain available. Tests may supply a fixture entry instead of the real CLI.
 */
export const assertFleetHost = (entry: string | undefined = process.argv[1]): void => {
  if (entry === undefined) throw new Error("Async fleet requires the Pi CLI 1.0.2 or newer");
  let directory = dirname(realpathSync(entry));
  for (let depth = 0; depth < 12; depth++) {
    let json: unknown;
    try {
      json = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
    } catch {
      json = undefined;
    }
    const parsed = Schema.decodeUnknownOption(Package)(json);
    if (parsed._tag === "Some" && parsed.value.name === "@earendil-works/pi-coding-agent") {
      const match = parsed.value.version.match(/^(\d+)\.(\d+)\.(\d+)$/);
      if (
        match !== null &&
        (Number(match[1]) > 1 ||
          (Number(match[1]) === 1 && (Number(match[2]) > 0 || Number(match[3]) >= 2)))
      )
        return;
      throw new Error(
        `Async fleet needs Pi >=1.0.2 with agent_before_settle, not ${parsed.value.version}`,
      );
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error(
    "Cannot verify the running Pi CLI's settlement API. Use the @earendil-works Pi CLI >=1.0.2; do not launch unguarded async workers.",
  );
};
