import { expect, test } from "bun:test";
import { hcDefine } from "./build.ts";

test("bakes the hc the build finds, and nothing when it finds none", () => {
  expect(hcDefine(() => "/Users/test/.local/bin/hc")).toEqual([
    "--define",
    'COORDINATE_HC="/Users/test/.local/bin/hc"',
  ]);
  expect(hcDefine(() => null)).toEqual([]);
});
