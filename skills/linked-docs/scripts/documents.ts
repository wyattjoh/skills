import { marked, type Token } from "marked";

/**
 * A routing node built from index headings and linked-page metadata.
 */
export type DocNode = {
  id: string;
  title: string;
  description: string;
  url: string | undefined;
  children: DocNode[];
};

/**
 * An exact source excerpt, with UTF-16 offsets and one-based inclusive line numbers.
 */
export type Passage = {
  id: string;
  url: string;
  heading: string;
  start: number;
  end: number;
  startLine: number;
  endLine: number;
  text: string;
};

/**
 * Resolve public HTTPS documentation links, keeping fetches on the index's origin.
 * Returns undefined for unsupported protocols, credentials, or external origins.
 */
export function docUrl(href: string, base: string): string | undefined {
  try {
    const url = new URL(href, base);
    if (url.protocol !== "https:" || url.username || url.password) return undefined;
    if (url.origin !== new URL(base).origin) return undefined;
    url.hash = "";
    return url.href;
  } catch {
    return undefined;
  }
}

/**
 * Limit routing metadata by UTF-8 bytes, without splitting a Unicode code point.
 */
export function preview(text: string, bytes: number): string {
  let size = 0;
  let result = "";
  for (const character of text) {
    const cost = Buffer.byteLength(character);
    if (size + cost > bytes) break;
    size += cost;
    result += character;
  }
  return result;
}

const description = (node: DocNode): string => preview(`${node.title}: ${node.description}`, 600);

// Share the summary budget across siblings so an early page's verbose blurb
// cannot hide every later title from the parent-level routing decision.
const summarize = (nodes: DocNode[]): string => {
  if (!nodes.length) return "";
  const each = Math.max(1, Math.floor((400 - 2 * (nodes.length - 1)) / nodes.length));
  return preview(nodes.map((node) => preview(node.title, each)).join("; "), 400);
};

// Routing menus spend at most 32 options and about 20KB of metadata. These
// application limits are below Jev's 255-option and 32k-token per-question limits.
const MENU_SIZE = 32;

function balance(node: DocNode, nextId: () => string): DocNode {
  node.children = node.children.map((child) => balance(child, nextId));
  while (node.children.length > MENU_SIZE) {
    const groups: DocNode[] = [];
    for (let i = 0; i < node.children.length; i += MENU_SIZE) {
      const children = node.children.slice(i, i + MENU_SIZE);
      groups.push({
        id: nextId(),
        title: preview(
          `${node.title}, ${children[0].title} through ${children.at(-1)!.title}`,
          150,
        ),
        description: summarize(children),
        url: undefined,
        children,
      });
    }
    node.children = groups;
  }
  return node;
}

/**
 * Parse Markdown headings, inline links, and reference links into a bounded tree.
 * Code fences and images are not links; duplicate page URLs are fetched once.
 * Reports links excluded by the same-origin policy and preserves heading-owned links.
 */
export function parseIndex(
  markdown: string,
  base: string,
): {
  root: DocNode;
  pages: number;
  excluded: number;
} {
  let sequence = 0;
  const nextId = () => `n${sequence++}`;
  const root: DocNode = {
    id: nextId(),
    title: "Documentation",
    description: "",
    url: undefined,
    children: [],
  };
  const stack = [{ depth: 0, node: root }];
  const seen = new Set<string>([base]);
  let excluded = 0;
  const tokens = marked.lexer(markdown);
  for (const token of tokens) {
    if (token.type === "heading") {
      while (stack.at(-1)!.depth >= token.depth) stack.pop();
      const node: DocNode = {
        id: nextId(),
        title: preview(token.text, 150),
        description: "",
        url: undefined,
        children: [],
      };
      stack.at(-1)!.node.children.push(node);
      stack.push({ depth: token.depth, node });
      continue;
    }
    const addLinks = (container: Token) => {
      marked.walkTokens([container], (part) => {
        if (part.type !== "link" || part.href.startsWith("#")) return;
        const url = docUrl(part.href, base);
        if (!url) {
          excluded++;
          return;
        }
        if (seen.has(url)) return;
        seen.add(url);
        stack.at(-1)!.node.children.push({
          id: nextId(),
          title: preview(part.text, 150),
          description: preview(container.raw.replace(part.raw, "").trim(), 600),
          url,
          children: [],
        });
      });
    };
    if (token.type === "list") token.items.forEach(addLinks);
    else if (token.type === "paragraph") addLinks(token);
  }
  const prune = (node: DocNode): boolean => {
    node.children = node.children.filter(prune);
    if (!node.url) node.description = summarize(node.children);
    return Boolean(node.url || node.children.length);
  };
  prune(root);
  return { root: balance(root, nextId), pages: seen.size - 1, excluded };
}

/**
 * Return compact menu descriptions, never full linked-page bodies.
 */
export function menu(nodes: DocNode[]): Record<string, string> {
  return Object.fromEntries(nodes.map((node) => [node.id, description(node)]));
}

/**
 * Split Markdown by real headings and bounded byte windows, preserving opening
 * prose and oversized lines. Every byte of source text belongs to one passage.
 * Heading paths are routing hints; passage text remains an unchanged source slice.
 */
export function passages(markdown: string, url: string, maxBytes = 3500): Passage[] {
  if (maxBytes < 4) throw new Error("Passage budget must be at least 4 bytes");
  const boundaries: { offset: number; heading: string }[] = [{ offset: 0, heading: "Opening" }];
  const headings: { depth: number; text: string }[] = [];
  let offset = 0;
  let normalizedOffset = 0;
  const normalized = markdown.replace(/\r\n|\r/g, "\n");
  for (const token of marked.lexer(markdown)) {
    // Link definitions live in Marked's link table rather than its token stream.
    // Locate each raw token to account for those gaps before assigning headings.
    const position = normalized.indexOf(token.raw, normalizedOffset);
    const start = Math.max(normalizedOffset, position);
    const finish = start + token.raw.length;
    while (normalizedOffset < start) {
      offset += markdown[offset] === "\r" && markdown[offset + 1] === "\n" ? 2 : 1;
      normalizedOffset++;
    }
    if (token.type === "heading") {
      while (headings.length && headings.at(-1)!.depth >= token.depth) headings.pop();
      headings.push({ depth: token.depth, text: token.text });
      const heading = preview(headings.map((item) => item.text).join(" > "), 300);
      if (offset === 0) boundaries[0].heading = heading;
      else boundaries.push({ offset, heading });
    }
    // Marked normalizes CRLF and CR to LF. Advance over the original source
    // so returned ranges still address the fetched text, including Windows docs.
    while (normalizedOffset < finish) {
      offset += markdown[offset] === "\r" && markdown[offset + 1] === "\n" ? 2 : 1;
      normalizedOffset++;
    }
  }
  const out: Passage[] = [];
  for (let i = 0; i < boundaries.length; i++) {
    const boundary = boundaries[i];
    const end = boundaries[i + 1]?.offset ?? markdown.length;
    let start = boundary.offset;
    while (start < end) {
      const text = preview(markdown.slice(start, end), maxBytes);
      const finish = start + text.length;
      out.push({
        id: `p${out.length}`,
        url,
        heading: boundary.heading,
        start,
        end: finish,
        startLine: markdown.slice(0, start).split(/\r\n|\r|\n/).length,
        endLine: markdown.slice(0, Math.max(start, finish - 1)).split(/\r\n|\r|\n/).length,
        text,
      });
      start = finish;
    }
  }
  return out;
}
