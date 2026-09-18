import { describe, expect, it } from "bun:test";
import { redactString, redactValue } from "./redact.ts";

describe("redactString", () => {
  it("redacts an Anthropic API key", () => {
    expect(redactString("key: sk-ant-api03-abcdefghijklmnopqrstuvwx")).toBe(
      "key: [redacted:anthropic-key]",
    );
  });

  it("redacts an OpenAI-shaped secret key", () => {
    expect(redactString("key: sk-abcdefghijklmnopqrstuvwxyz123456")).toBe(
      "key: [redacted:openai-key]",
    );
  });

  it("redacts a GitHub personal access token", () => {
    expect(redactString("token: ghp_abcdefghijklmnopqrstuvwxyz1234567890")).toBe(
      "token: [redacted:github-token]",
    );
  });

  it("redacts a github_pat_ token", () => {
    expect(redactString("token: github_pat_abcdefghijklmnopqrstuvwxyz1234567890")).toBe(
      "token: [redacted:github-token]",
    );
  });

  it("redacts an AWS access key id", () => {
    expect(redactString("id: AKIAIOSFODNN7EXAMPLE")).toBe("id: [redacted:aws-key]");
  });

  it("redacts a 40-char mixed-case AWS-shaped secret", () => {
    expect(redactString("secret: wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY")).toBe(
      "secret: [redacted:aws-secret]",
    );
  });

  it("leaves a base64url PKCE code challenge untouched", () => {
    const input = "S256 of the verifier is E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
    expect(redactString(input)).toBe(input);
  });

  it("leaves a sha256 integrity hash untouched", () => {
    const input = "integrity=sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=";
    expect(redactString(input)).toBe(input);
  });

  it("leaves an AKIA id with trailing characters untouched", () => {
    const input = "id: AKIAIOSFODNN7EXAMPLEXYZ";
    expect(redactString(input)).toBe(input);
  });

  it("redacts a Stripe live secret key", () => {
    expect(redactString("key: sk_live_abcdefghijklmnop")).toBe("key: [redacted:stripe-key]");
  });

  it("redacts a Stripe test secret key", () => {
    expect(redactString("key: sk_test_abcdefghijklmnop")).toBe("key: [redacted:stripe-key]");
  });

  it("redacts a Bearer token, keeping the Bearer prefix", () => {
    expect(redactString("Authorization: Bearer abc123.def456-ghi789")).toBe(
      "Authorization: Bearer [redacted:bearer-token]",
    );
  });

  it("redacts a short Bearer token that mixes a digit and punctuation", () => {
    expect(redactString("Authorization: Bearer a1-b2")).toBe(
      "Authorization: Bearer [redacted:bearer-token]",
    );
  });

  it("leaves 'Bearer token' in an API docs table untouched", () => {
    const input = "| Bearer token | DNS record management |";
    expect(redactString(input)).toBe(input);
  });

  it("leaves prose about a Bearer header untouched", () => {
    const input = "Send a Bearer header with the session JWT";
    expect(redactString(input)).toBe(input);
  });

  it("redacts an enc:v1: payload", () => {
    expect(redactString("blob: enc:v1:QUJDREVGR0hJSktMTU5PUA==")).toBe(
      "blob: [redacted:enc-payload]",
    );
  });

  it("redacts a KEY= assignment, keeping the identifier", () => {
    expect(redactString("export KEY=abcd1234efgh")).toBe("export KEY=[redacted:env-secret]");
  });

  it("redacts a prefixed API_KEY= assignment", () => {
    expect(redactString("API_KEY=abcd1234efgh")).toBe("API_KEY=[redacted:env-secret]");
  });

  it("leaves a plain development API_KEY assignment untouched", () => {
    const input = "API_KEY=development";
    expect(redactString(input)).toBe(input);
  });

  it("redacts a TOKEN= assignment", () => {
    expect(redactString("SLACK_TOKEN=abcd1234efgh")).toBe("SLACK_TOKEN=[redacted:env-secret]");
  });

  it("redacts a SECRET= assignment", () => {
    expect(redactString("DB_SECRET=abcd1234efgh")).toBe("DB_SECRET=[redacted:env-secret]");
  });

  it("redacts a private key block", () => {
    const block = "-----BEGIN RSA PRIVATE KEY-----\nMIIBogIBAAJ\n-----END RSA PRIVATE KEY-----";
    expect(redactString(`key:\n${block}\n`)).toBe("key:\n[redacted:private-key]\n");
  });

  it("redacts multiple distinct secrets in the same string", () => {
    const input = "sk-ant-api03-abcdefghijklmnopqrstuvwx and AKIAIOSFODNN7EXAMPLE";
    expect(redactString(input)).toBe("[redacted:anthropic-key] and [redacted:aws-key]");
  });

  it("leaves ordinary text, a git sha, and a short assignment untouched", () => {
    const input = "Fixed the bug in commit 1a79a4d60de6718e8e5b326e338ae533f1e4a3ca (KEY=short)";
    expect(redactString(input)).toBe(input);
  });
});

describe("redactValue", () => {
  it("redacts strings nested in objects and arrays", () => {
    expect(
      redactValue({
        summary: "leaked AKIAIOSFODNN7EXAMPLE",
        tags: ["ok", "token: ghp_abcdefghijklmnopqrstuvwxyz1234567890"],
        count: 2,
      }),
    ).toEqual({
      summary: "leaked [redacted:aws-key]",
      tags: ["ok", "token: [redacted:github-token]"],
      count: 2,
    });
  });

  it("passes through numbers, booleans, and null unchanged", () => {
    expect(redactValue({ count: 3, ok: true, missing: null })).toEqual({
      count: 3,
      ok: true,
      missing: null,
    });
  });

  it("leaves a value with no secrets unchanged", () => {
    const value = { title: "Refactor the parser", count: 5 };
    expect(redactValue(value)).toEqual(value);
  });
});
