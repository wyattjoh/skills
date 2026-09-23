import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Global run files must never land in the developer's real state directory.
// Every spawned helper inherits this sandbox unless a test replaces HOME.
process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "coordinate-state-"));
