import { describe, expect, test } from "bun:test";
import {
  docUrl,
  menu,
  parseIndex,
  passages,
  passageTree,
  preview,
  type DocNode,
} from "./documents.ts";

const base = "https://docs.example.com/docs/llms.txt";
const leaves = (node: DocNode): DocNode[] => (node.url ? [node] : node.children.flatMap(leaves));
const sizes = (node: DocNode): number[] => [node.children.length, ...node.children.flatMap(sizes)];
const ids = (node: DocNode): string[] =>
  node.children.length ? node.children.flatMap(ids) : [node.id];

describe("section metadata", () => {
  test("preserves every passage ID in bounded menus", () => {
    const chunks = passages(
      Array.from({ length: 301 }, (_, i) => `# Setting ${i}\nDetail`).join("\n\n"),
      base,
    );
    const root = passageTree(chunks, "A question");
    expect(ids(root)).toEqual(chunks.map((chunk) => chunk.id));
    expect(Math.max(...sizes(root))).toBe(32);
    expect(
      Math.max(...Object.values(menu(root.children)).map((text) => Buffer.byteLength(text))),
    ).toBeLessThanOrEqual(600);
  });
  test("late facts appear in metadata while evidence keeps its exact source", () => {
    const text = `# Options\n${"Introductory prose. ".repeat(100)}\nbinary path arguments`;
    const chunks = passages(text, base);
    const root = passageTree(chunks, "Binary path and arguments?");
    expect(root.children[0].description.includes("binary path arguments")).toBe(true);
    expect(chunks[0].text).toBe(text);
  });
});

describe("index parsing", () => {
  test("preserves headings, opening links, relative URLs, and reference links", () => {
    const { root, pages, excluded } = parseIndex(
      `# Docs
[Overview](./overview.md): Starting here
## Agents
- [Tools](./ai/tools.md): Configure tools
### Permissions
- [Rules][rules]: Tool approvals
- [Duplicate](./ai/tools.md#setup)
- [External](https://other.example.com/doc.md)
- ![Image](./image.png)
\`\`\`md
[Fake](./fake.md)
## Fake heading
\`\`\`
[rules]: ./ai/rules.md
`,
      base,
    );
    expect(pages).toBe(3);
    expect(excluded).toBe(1);
    expect(leaves(root).map((node) => node.url)).toEqual([
      "https://docs.example.com/docs/overview.md",
      "https://docs.example.com/docs/ai/tools.md",
      "https://docs.example.com/docs/ai/rules.md",
    ]);
    const docs = root.children[0];
    expect(docs.children.map((node) => node.title)).toEqual(["Overview", "Agents"]);
    expect(docs.children[1].children.map((node) => node.title)).toEqual(["Tools", "Permissions"]);
    expect(menu([leaves(root)[1]])[leaves(root)[1].id]).toContain("Configure tools");
  });

  test("bounds wide menus without dropping any pages", () => {
    const { root, pages } = parseIndex(
      Array.from({ length: 1100 }, (_, i) => `- [Page ${i}](./${i}.md): Topic ${i}`).join("\n"),
      base,
    );
    expect(Math.max(...sizes(root))).toBe(32);
    expect(pages).toBe(1100);
    expect(leaves(root)).toHaveLength(1100);
    expect(new Set(leaves(root).map((node) => node.id)).size).toBe(1100);
  });

  test("parent summaries retain later titles instead of only the first verbose blurb", () => {
    const { root } = parseIndex(
      `# Docs\n## Topics\n${Array.from({ length: 32 }, (_, i) => `- [Page ${i}](./${i}.md): ${"verbose description ".repeat(100)}`).join("\n")}`,
      base,
    );
    const topics = root.children[0].children[0];
    expect(menu([topics])[topics.id]).toContain("Page 31");
    expect(Buffer.byteLength(menu([topics])[topics.id])).toBeLessThanOrEqual(600);
  });

  test("empty, cyclic, credential, and non-HTTPS links cannot become fetch targets", () => {
    expect(parseIndex("[Self](llms.txt) [Anchor](#local)", base).pages).toBe(0);
    expect(docUrl("http://docs.example.com/docs/x.md", base)).toBeUndefined();
    expect(docUrl("https://user:password@docs.example.com/x.md", base)).toBeUndefined();
    expect(docUrl("file:///private/doc.md", base)).toBeUndefined();
    expect(docUrl("https://outside.example.com/x.md", base)).toBeUndefined();
    expect(docUrl("./x.md#setup", base)).toBe("https://docs.example.com/docs/x.md");
  });
});

describe("exact passage extraction", () => {
  test("preserves opening prose and ignores code-fence headings", () => {
    const text =
      "Opening evidence\n\n# Setup\n\nInstructions\n\n```ts\n# not a heading\n```\n\n## Details\nAnswer here\n";
    const chunks = passages(text, base);
    expect(chunks.map((chunk) => chunk.heading)).toEqual(["Opening", "Setup", "Setup > Details"]);
    expect(chunks.map((chunk) => chunk.text).join("")).toBe(text);
    expect(chunks.map((chunk) => text.slice(chunk.start, chunk.end))).toEqual(
      chunks.map((chunk) => chunk.text),
    );
    expect(chunks[0].startLine).toBe(1);
    expect(chunks.at(-1)!.endLine).toBe(12);
  });

  test("handles Unicode and oversized lines without silently truncating evidence", () => {
    const text = `# Title\n${"界🙂".repeat(2500)}\nTail answer`;
    const chunks = passages(text, base);
    expect(chunks.map((chunk) => chunk.text).join("")).toBe(text);
    expect(Math.max(...chunks.map((chunk) => Buffer.byteLength(chunk.text)))).toBeLessThanOrEqual(
      3500,
    );
    expect(chunks.at(-1)!.text.endsWith("Tail answer")).toBe(true);
    expect(preview("界🙂a", 6)).toBe("界");
  });

  test("CRLF and setext headings keep original source offsets", () => {
    const text = "Opening\r\n\r\nTitle\r\n=====\r\nBody\r\n\r\n## Next\r\nAnswer\r\n";
    const chunks = passages(text, base);
    expect(chunks.map((chunk) => chunk.heading)).toEqual(["Opening", "Title", "Title > Next"]);
    expect(chunks.map((chunk) => chunk.text).join("")).toBe(text);
    expect(chunks[1].text.startsWith("Title\r\n")).toBe(true);
    expect(chunks[2].text.startsWith("## Next\r\n")).toBe(true);
    expect(chunks[2].startLine).toBe(7);
  });

  test("link-definition gaps do not shift headings or match headings inside fences", () => {
    const text =
      "[ref]: ./doc.md\n\n```md\n# Real\n```\n\n# Real\n[See docs][ref]\n\n[second]: ./other.md\n\n## Next\nAnswer\n";
    const chunks = passages(text, base);
    expect(chunks.map((chunk) => chunk.heading)).toEqual(["Opening", "Real", "Real > Next"]);
    expect(chunks.map((chunk) => chunk.text).join("")).toBe(text);
    expect(chunks[1].start).toBe(text.indexOf("# Real", text.indexOf("```\n") + 4));
    expect(chunks[2].start).toBe(text.indexOf("## Next"));
  });

  test("long headings stay bounded as metadata while evidence remains exact", () => {
    const text = `# ${"long heading ".repeat(1000)}\nAnswer`;
    const chunks = passages(text, base);
    expect(chunks.map((chunk) => chunk.text).join("")).toBe(text);
    expect(chunks.every((chunk) => Buffer.byteLength(chunk.heading) <= 300)).toBe(true);
  });

  test("empty documents have no evidence", () => {
    expect(passages("", base)).toEqual([]);
  });
});
