import { describe, expect, it } from "bun:test";
import { runWith } from "./fixture.ts";
import { fakeProc, ok } from "./proc.ts";
import { coordinatorTabTitle, renameCoordinatorTab, shortFocus } from "./tab-title.ts";

describe("coordinatorTabTitle", () => {
  it("names the domain and its short focus, or no active focus", () => {
    expect(coordinatorTabTitle("skills", "i187 on hold, i259 landed")).toBe(
      "Skills · i187 on hold, i259 landed",
    );
    expect(coordinatorTabTitle("skills", null)).toBe("Skills · No active focus");
    expect(coordinatorTabTitle("skills", "  ")).toBe("Skills · No active focus");
    expect(coordinatorTabTitle("web", "Ship **`login`** per [i4](https://x/i4)")).toBe(
      "Web · Ship login per i4",
    );
  });

  it("cuts a long focus at a word", () => {
    expect(shortFocus("Landing the manager wakes change, then the strix preflight and i21")).toBe(
      "Landing the manager wakes change, then…",
    );
  });
});

const coordinator = (address: string, domain: string, tab: string) =>
  JSON.stringify({
    address,
    state: "live",
    labels: { "fleet.role": "coordinator", "fleet.domain": domain, "herdr.tab": tab },
  });

describe("renameCoordinatorTab", () => {
  it("renames this terminal's tab when it is the domain's coordinator", async () => {
    const fake = fakeProc((argv) =>
      argv[1] === "get" ? ok(coordinator("t1", "app", "tb1")) : ok(""),
    );
    expect(await runWith(renameCoordinatorTab("app", "Fix login", "t1"), fake.layer)).toEqual({
      tab: "tb1",
      title: "App · Fix login",
    });
    expect(fake.calls.map((call) => call.argv)).toEqual([
      ["hc", "get", "t1", "--json"],
      ["herdr-app", "do", "tab.rename", JSON.stringify({ id: "tb1", name: "App · Fix login" })],
    ]);
  });

  it("finds the domain's local coordinator from outside its terminal", async () => {
    const fake = fakeProc((argv) => {
      if (argv[1] === "ls")
        return ok(
          JSON.stringify({
            terminals: [
              { address: "strix/t4", state: "live" },
              { address: "t7", state: "live" },
            ],
          }),
        );
      if (argv[1] === "get" && argv[2] === "t7") return ok(coordinator("t7", "app", "tb7"));
      return ok("");
    });
    expect(await runWith(renameCoordinatorTab("app", null, null), fake.layer)).toEqual({
      tab: "tb7",
      title: "App · No active focus",
    });
    expect(fake.calls.map((call) => call.argv[1])).toEqual(["ls", "get", "do"]);
  });

  it("renames nothing when no coordinator of the domain runs here", async () => {
    const fake = fakeProc((argv) => (argv[1] === "ls" ? ok('{"terminals":[]}') : ok("")));
    expect(await runWith(renameCoordinatorTab("app", "x", null), fake.layer)).toBe(undefined);
    expect(fake.calls.map((call) => call.argv[1])).toEqual(["ls"]);
  });
});
