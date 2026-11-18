import { expect, test } from "bun:test";
import { emptyBacklog } from "../../lib/store.ts";
import { cachedDocument } from "./model.ts";
import type { DocumentState } from "./model.ts";

const loaded: DocumentState = { kind: "loaded", backlog: emptyBacklog("alpha", null) };
const invalid: DocumentState = { kind: "invalid", reason: "items must be a list" };
const shown = new Map<string, DocumentState>([
  ["alpha", loaded],
  ["beta", invalid],
]);

test("cachedDocument draws a domain's last read state, whatever its kind", () => {
  expect(cachedDocument(shown, "alpha")).toEqual(loaded);
  expect(cachedDocument(shown, "beta")).toEqual(invalid);
});

test("cachedDocument draws loading for a domain not read yet and for the listing", () => {
  expect(cachedDocument(shown, "gamma")).toEqual({ kind: "loading" });
  expect(cachedDocument(shown, undefined)).toEqual({ kind: "loading" });
});
