#!/usr/bin/env bun
import { runCoordinatorRequest } from "./coordinate-program.ts";
import { failureResponse } from "./lib/contract.ts";

let raw: string;
try {
  raw = await Bun.stdin.text();
} catch (error) {
  console.log(
    JSON.stringify(
      failureResponse(
        null,
        [
          {
            code: "request.read_failed",
            message: `Could not read request stdin: ${(error as Error).message}`,
            remediation: "Retry with one JSON request on stdin.",
          },
        ],
        null,
      ),
      null,
      2,
    ),
  );
  process.exit(2);
}

const { exitCode, stdout } = await runCoordinatorRequest(raw);
process.stdout.write(stdout);
process.exitCode = exitCode;
