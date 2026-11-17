// coordinate-panel: one coordinate domain's backlog, read-only, following the focused terminal.
import { View } from "gpui-kit";
import type { AsyncContext, Context, Element } from "gpui-kit";
import { checking, exec, focused, home, readTextFile, terminals, theme, watchFolder } from "herdr";
import type { FolderWatch } from "herdr";
import {
  FOLDED_BY_DEFAULT,
  LIST_SCRIPT,
  backlogsDir,
  configPath,
  documentPath,
  groupItems,
  openFindings,
  parseListing,
  readDocument,
  stateDirOf,
  summarize,
  targetDomain,
} from "./model.ts";
import type { DocumentState, DomainSummary, ItemGroup, ListingState } from "./model.ts";
import type { Item } from "../../lib/store.ts";
import { panel } from "./view.ts";
import type { Theme } from "./view.ts";

// How often the panel checks whether focus moved to another domain, and how often it rereads
// the document in case a folder watch was reclaimed.
const FOLLOW_MS = 1_000;
const REFRESH_MS = 30_000;

/**
 * The Backlog panel.
 */
export default class Panel extends View {
  // The domain the document belongs to, and what is known about it.
  domain: string | undefined;
  doc: DocumentState = { kind: "loading" };
  // The domain focus last named, kept while a pane with no terminal (the panel) has focus.
  followed: string | undefined;
  // The domain opened from the listing, shown while focus names none. A focused domain
  // terminal clears it, and Back does.
  picked: string | undefined;
  // The all-domains listing, kept across opening a domain so Back shows it at once.
  listing: ListingState = { kind: "loading" };
  // Bumped by every load, so a slower, older read never overwrites a newer one.
  generation = 0;
  // Fold state per domain and status, for groups the user has folded or opened.
  folds = new Map<string, boolean>();
  // The backlogs folder being watched, and the pending watch on it.
  watched: string | undefined;
  watch: FolderWatch | undefined;
  // The item whose detail is open, by domain and id, so a reload shows its latest copy and a
  // vanished item falls back to the list.
  selected: { domain: string; id: string } | undefined;

  init(_props: unknown, cx: AsyncContext) {
    if (checking()) return;
    this.load(cx);
    cx.timer.every(FOLLOW_MS, (tick) => this.follow(tick));
    cx.timer.every(REFRESH_MS, (tick) => this.load(tick));
  }

  // The domain focus names now.
  focusDomain(): string | undefined {
    return targetDomain(focused(), terminals(), this.followed);
  }

  // The domain the panel should show now, or undefined for the listing.
  target(): string | undefined {
    return this.focusDomain() ?? this.picked;
  }

  // Record where focus went: a focused domain terminal replaces a domain opened by hand.
  track() {
    const followed = this.focusDomain();
    if (followed === this.followed) return;
    this.followed = followed;
    if (followed !== undefined) this.picked = undefined;
  }

  // Load again only when focus moved to another domain.
  follow(cx: AsyncContext) {
    this.track();
    if (this.target() !== this.domain) this.load(cx);
  }

  openDomain(domain: string, cx: Context) {
    this.picked = domain;
    this.load(cx);
  }

  load(cx: Context) {
    const generation = ++this.generation;
    this.track();
    const domain = this.target();
    cx.spawn(async (task) => {
      const stateDir = stateDirOf(await this.read(configPath(home())), home());
      if (generation !== this.generation) return;
      this.watchBacklogs(backlogsDir(stateDir), task);
      if (domain !== this.domain) {
        this.domain = domain;
        this.selected = undefined;
        this.doc = { kind: "loading" };
        task.notify();
      }
      if (domain === undefined) {
        const listing = await this.list(stateDir);
        if (generation !== this.generation) return;
        this.listing = listing;
        task.notify();
        return;
      }
      const doc = await this.readDomain(stateDir, domain);
      if (generation !== this.generation) return;
      this.doc = doc;
      task.notify();
    });
  }

  // One domain's document. A read that rejects (permissions, too large) is unreadable.
  async readDomain(stateDir: string, domain: string): Promise<DocumentState> {
    try {
      return readDocument(await readTextFile(documentPath(stateDir, domain)));
    } catch (error) {
      return { kind: "unreadable", reason: String(error) };
    }
  }

  // Every domain document, listed through the shell, each read and summarized on its own so
  // one bad document only marks its own row.
  async list(stateDir: string): Promise<ListingState> {
    let names: string[];
    try {
      const listed = await exec("sh", [
        "-c",
        LIST_SCRIPT,
        "coordinate-panel",
        backlogsDir(stateDir),
      ]);
      if (listed.code !== 0)
        return { kind: "unreadable", reason: listed.stderr.trim() || `sh exited ${listed.code}` };
      names = parseListing(listed.stdout);
    } catch (error) {
      return { kind: "unreadable", reason: String(error) };
    }
    const rows = await Promise.all(
      names.map(async (name) => summarize(name, await this.readDomain(stateDir, name))),
    );
    return {
      kind: "loaded",
      domains: rows.filter((row): row is DomainSummary => row !== undefined),
    };
  }

  // Reload on every change under the backlogs folder. A watch that is released or reclaimed
  // (an empty batch) or fails (no folder yet) ends the loop; the slow timer arms it again.
  watchBacklogs(dir: string, cx: AsyncContext) {
    if (this.watched === dir) return;
    this.watch?.cancel();
    this.watched = dir;
    let current = watchFolder(dir);
    this.watch = current;
    cx.spawn(async (task) => {
      try {
        for (;;) {
          const changed = await current;
          if (this.watch !== current || changed.length === 0) break;
          current = watchFolder(dir);
          this.watch = current;
          this.load(task);
        }
      } catch {
        // Fall through: the watch is gone either way.
      }
      if (this.watch !== current) return;
      this.watch = undefined;
      this.watched = undefined;
    });
  }

  close() {
    this.watch?.cancel();
  }

  // A config that can't be read counts as absent.
  async read(path: string): Promise<string | null> {
    try {
      return await readTextFile(path);
    } catch {
      return null;
    }
  }

  foldKey(group: ItemGroup): string {
    return `${this.domain}:${group.status}`;
  }

  isOpen(group: ItemGroup): boolean {
    return this.folds.get(this.foldKey(group)) ?? !FOLDED_BY_DEFAULT.has(group.status);
  }

  toggleFold(group: ItemGroup, cx: Context) {
    this.folds.set(this.foldKey(group), !this.isOpen(group));
    cx.notify();
  }

  open(item: Item, cx: Context) {
    if (this.domain === undefined) return;
    this.selected = { domain: this.domain, id: item.id };
    cx.notify();
  }

  // Back closes an item's detail first, then leaves a domain opened from the listing.
  back(cx: Context) {
    if (this.selected !== undefined) {
      this.selected = undefined;
      cx.notify();
      return;
    }
    this.picked = undefined;
    this.load(cx);
  }

  // The open item as the document now has it, if it is still there.
  detail(domain: string | undefined, doc: DocumentState): Item | undefined {
    const selected = this.selected;
    if (selected === undefined || selected.domain !== domain || doc.kind !== "loaded")
      return undefined;
    return doc.backlog.items.find((item) => item.id === selected.id);
  }

  render(): Element {
    const domain = this.target();
    const doc: DocumentState = domain === this.domain ? this.doc : { kind: "loading" };
    return panel(theme() as Theme, {
      domain,
      doc,
      listing: this.listing,
      picked: domain !== undefined && domain === this.picked,
      groups: doc.kind === "loaded" ? groupItems(doc.backlog) : [],
      findings: doc.kind === "loaded" ? openFindings(doc.backlog) : [],
      openDomain: (name, cx) => this.openDomain(name, cx),
      isOpen: (group) => this.isOpen(group),
      toggle: (group, cx) => this.toggleFold(group, cx),
      detail: this.detail(domain, doc),
      open: (item, cx) => this.open(item, cx),
      back: (cx) => this.back(cx),
    });
  }
}
