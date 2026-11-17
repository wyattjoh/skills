// coordinate-panel: one coordinate domain's backlog, read-only, following the focused terminal.
import { View } from "gpui-kit";
import type { AsyncContext, Context, Element } from "gpui-kit";
import { checking, focused, home, readTextFile, terminals, theme, watchFolder } from "herdr";
import type { FolderWatch } from "herdr";
import {
  FOLDED_BY_DEFAULT,
  backlogsDir,
  configPath,
  documentPath,
  groupItems,
  openFindings,
  readDocument,
  stateDirOf,
  targetDomain,
} from "./model.ts";
import type { DocumentState, ItemGroup } from "./model.ts";
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

  // The domain the panel should show now.
  target(): string | undefined {
    return targetDomain(focused(), terminals(), this.domain);
  }

  // Load again only when focus moved to another domain.
  follow(cx: AsyncContext) {
    if (this.target() !== this.domain) this.load(cx);
  }

  load(cx: AsyncContext) {
    const generation = ++this.generation;
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
      if (domain === undefined) return;
      let doc: DocumentState;
      try {
        doc = readDocument(await readTextFile(documentPath(stateDir, domain)));
      } catch (error) {
        doc = { kind: "invalid", reason: String(error) };
      }
      if (generation !== this.generation) return;
      this.doc = doc;
      task.notify();
    });
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

  back(cx: Context) {
    this.selected = undefined;
    cx.notify();
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
      groups: doc.kind === "loaded" ? groupItems(doc.backlog) : [],
      findings: doc.kind === "loaded" ? openFindings(doc.backlog) : [],
      isOpen: (group) => this.isOpen(group),
      toggle: (group, cx) => this.toggleFold(group, cx),
      detail: this.detail(domain, doc),
      open: (item, cx) => this.open(item, cx),
      back: (cx) => this.back(cx),
    });
  }
}
