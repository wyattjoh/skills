import { describe, expect, it } from "bun:test";
import { buildWhereFragments, parseFilters, resolveTimestamp, whereClause } from "./filters.ts";

const NOW = new Date("2026-09-18T12:00:00.000Z");

describe("resolveTimestamp", () => {
  it("resolves hours relative to now", () => {
    expect(resolveTimestamp("3h", NOW)).toBe("2026-09-18T09:00:00.000Z");
  });

  it("resolves days relative to now", () => {
    expect(resolveTimestamp("6d", NOW)).toBe("2026-09-12T12:00:00.000Z");
  });

  it("resolves weeks relative to now", () => {
    expect(resolveTimestamp("2w", NOW)).toBe("2026-09-04T12:00:00.000Z");
  });

  it("resolves minutes relative to now", () => {
    expect(resolveTimestamp("30m", NOW)).toBe("2026-09-18T11:30:00.000Z");
  });

  it("resolves seconds relative to now", () => {
    expect(resolveTimestamp("45s", NOW)).toBe("2026-09-18T11:59:15.000Z");
  });

  it("passes through an ISO 8601 absolute timestamp normalized to UTC", () => {
    expect(resolveTimestamp("2026-01-01T00:00:00.000Z", NOW)).toBe("2026-01-01T00:00:00.000Z");
  });

  it("throws on an unparseable timestamp", () => {
    expect(() => resolveTimestamp("not-a-date", NOW)).toThrow("Invalid timestamp: not-a-date");
  });

  it("throws on a bare number instead of silently widening the window", () => {
    expect(() => resolveTimestamp("3", NOW)).toThrow("Invalid timestamp: 3");
  });

  it("resolves an ISO date without a time component", () => {
    expect(resolveTimestamp("2026-01-01", NOW)).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("parseFilters", () => {
  it("defaults to no projects, no sessions, and a limit of 100", () => {
    expect(parseFilters({}, NOW)).toEqual({
      projects: [],
      sessions: [],
      since: undefined,
      until: undefined,
      model: undefined,
      includeSubagents: false,
      limit: 100,
    });
  });

  it("collects repeated --project and --session values", () => {
    const parsed = parseFilters({ project: ["foo", "bar"], session: "abc" }, NOW);
    expect(parsed.projects).toEqual(["foo", "bar"]);
    expect(parsed.sessions).toEqual(["abc"]);
  });

  it("resolves relative --since and --until against the injected now", () => {
    const parsed = parseFilters({ since: "3h", until: "1h" }, NOW);
    expect(parsed.since).toBe("2026-09-18T09:00:00.000Z");
    expect(parsed.until).toBe("2026-09-18T11:00:00.000Z");
  });

  it("parses --model and --include-subagents", () => {
    const parsed = parseFilters({ model: "opus", "include-subagents": true }, NOW);
    expect(parsed.model).toBe("opus");
    expect(parsed.includeSubagents).toBe(true);
  });

  it("parses a custom --limit", () => {
    expect(parseFilters({ limit: "25" }, NOW).limit).toBe(25);
  });

  it("throws on a zero --limit instead of silently falling back", () => {
    expect(() => parseFilters({ limit: "0" }, NOW)).toThrow("Invalid --limit: 0");
  });

  it("throws on a negative --limit instead of silently falling back", () => {
    expect(() => parseFilters({ limit: "-3" }, NOW)).toThrow("Invalid --limit: -3");
  });

  it("throws on a non-numeric --limit instead of silently falling back", () => {
    expect(() => parseFilters({ limit: "many" }, NOW)).toThrow("Invalid --limit: many");
  });

  it("throws on a decimal --limit instead of truncating", () => {
    expect(() => parseFilters({ limit: "5.9" }, NOW)).toThrow("Invalid --limit: 5.9");
  });

  it("throws on a scientific-notation --limit instead of misparsing it", () => {
    expect(() => parseFilters({ limit: "1e9" }, NOW)).toThrow("Invalid --limit: 1e9");
  });
});

describe("buildWhereFragments", () => {
  it("returns no clauses when no filters and no subagent column are set", () => {
    const fragment = buildWhereFragments(parseFilters({}, NOW), {});
    expect(fragment).toEqual({ clauses: [], params: [] });
  });

  it("excludes subagent rows by default when a subagentParent column is given", () => {
    const fragment = buildWhereFragments(parseFilters({}, NOW), {
      subagentParent: "sessions.parent_session_id",
    });
    expect(fragment).toEqual({
      clauses: ["sessions.parent_session_id IS NULL"],
      params: [],
    });
  });

  it("omits the subagent clause when --include-subagents is set", () => {
    const fragment = buildWhereFragments(parseFilters({ "include-subagents": true }, NOW), {
      subagentParent: "sessions.parent_session_id",
    });
    expect(fragment).toEqual({ clauses: [], params: [] });
  });

  it("matches --project against every configured column with OR", () => {
    const fragment = buildWhereFragments(parseFilters({ project: ["myapp"] }, NOW), {
      project: ["sessions.project_dir", "sessions.cwd"],
    });
    expect(fragment).toEqual({
      clauses: ["(sessions.project_dir LIKE ? OR sessions.cwd LIKE ?)"],
      params: ["%myapp%", "%myapp%"],
    });
  });

  it("combines multiple --project values and columns in declaration order", () => {
    const fragment = buildWhereFragments(parseFilters({ project: ["a", "b"] }, NOW), {
      project: ["sessions.project_dir"],
    });
    expect(fragment).toEqual({
      clauses: ["(sessions.project_dir LIKE ? OR sessions.project_dir LIKE ?)"],
      params: ["%a%", "%b%"],
    });
  });

  it("builds an IN clause for --session", () => {
    const fragment = buildWhereFragments(parseFilters({ session: ["s1", "s2"] }, NOW), {
      session: "sessions.session_id",
    });
    expect(fragment).toEqual({
      clauses: ["sessions.session_id IN (?, ?)"],
      params: ["s1", "s2"],
    });
  });

  it("builds range clauses for --since and --until", () => {
    const fragment = buildWhereFragments(parseFilters({ since: "3h", until: "1h" }, NOW), {
      timestamp: "messages.ts",
    });
    expect(fragment).toEqual({
      clauses: ["messages.ts >= ?", "messages.ts <= ?"],
      params: ["2026-09-18T09:00:00.000Z", "2026-09-18T11:00:00.000Z"],
    });
  });

  it("builds an equality clause for --model", () => {
    const fragment = buildWhereFragments(parseFilters({ model: "opus" }, NOW), {
      model: "messages.model",
    });
    expect(fragment).toEqual({
      clauses: ["messages.model = ?"],
      params: ["opus"],
    });
  });

  it("skips a filter whose column was not configured for this query", () => {
    const fragment = buildWhereFragments(parseFilters({ model: "opus" }, NOW), {});
    expect(fragment).toEqual({ clauses: [], params: [] });
  });

  it("combines every active clause with AND", () => {
    const fragment = buildWhereFragments(
      parseFilters({ project: ["myapp"], session: ["s1"], model: "opus" }, NOW),
      {
        project: ["sessions.project_dir"],
        session: "sessions.session_id",
        model: "sessions.model",
        subagentParent: "sessions.parent_session_id",
      },
    );
    expect(fragment.clauses).toEqual([
      "(sessions.project_dir LIKE ?)",
      "sessions.session_id IN (?)",
      "sessions.model = ?",
      "sessions.parent_session_id IS NULL",
    ]);
    expect(fragment.params).toEqual(["%myapp%", "s1", "opus"]);
  });
});

describe("whereClause", () => {
  it("returns an empty string for no clauses", () => {
    expect(whereClause({ clauses: [], params: [] })).toBe("");
  });

  it("joins clauses with AND under a single WHERE", () => {
    expect(
      whereClause({
        clauses: ["a = ?", "b = ?"],
        params: [1, 2],
      }),
    ).toBe("WHERE a = ? AND b = ?");
  });
});
