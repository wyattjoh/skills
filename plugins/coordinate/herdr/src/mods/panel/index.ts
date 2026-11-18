// coordinate-panel: one coordinate domain's backlog, following the focused terminal. Its one
// write is answering an item's ask, through the coordinate CLI.
import { View } from "gpui-kit";
import { InputState } from "gpui-base";
import type { AsyncContext, Context, Element } from "gpui-kit";
import { checking, exec, focused, home, readTextFile, terminals, theme, watchFolder } from "herdr";
import type { FolderWatch } from "herdr";
import {
  FOLDED_BY_DEFAULT,
  LIST_SCRIPT,
  answerCommand,
  answerFailure,
  chosenAnswer,
  configPath,
  draftFor,
  draftKey,
  endedDate,
  endedPath,
  groupItems,
  joinDelegates,
  missingSessions,
  openFindings,
  parseListing,
  readDocument,
  stateDirOf,
  summarize,
  targetDomain,
} from "./model.ts";
import type {
  AnswerDraft,
  DelegateJoin,
  DocumentState,
  DomainSummary,
  EndedRecords,
  ItemGroup,
  ListingState,
} from "./model.ts";
import { backlogsDir, documentPath } from "../../lib/store.ts";
import type { Item } from "../../lib/store.ts";
import { panel } from "./view.ts";
import type { AnswerModel, Theme } from "./view.ts";

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
  // The state folder the last load found, the ended records read for the delegate refs that had
  // no live terminal then, and which sessions those were, so a delegate that loses its terminal
  // between document changes is looked up again.
  stateDir: string | undefined;
  ended: EndedRecords = new Map();
  endedFor: string | undefined;
  endedGeneration = 0;
  // The answer field's retained text state, whether it has the keyboard, and the draft being
  // written on the open item's ask.
  input: InputState | undefined;
  typing = false;
  draft: AnswerDraft | undefined;

  init(_props: unknown, cx: AsyncContext) {
    const input = InputState.new({ placeholder: "Or type an answer" });
    input.on("change", (_event, changed) => this.type(input.value(), changed));
    input.on("submit", (_event, submitted) => this.answer(submitted));
    input.on("focus", (_event, gained) => this.setTyping(true, gained));
    input.on("blur", (_event, lost) => this.setTyping(false, lost));
    this.input = input;
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
    if (this.target() !== this.domain) {
      this.load(cx);
      return;
    }
    if (this.doc.kind !== "loaded" || this.stateDir === undefined) return;
    const missing = missingSessions(this.doc.backlog, terminals());
    if (missing.join("\0") !== this.endedFor) this.lookUpEnded(this.stateDir, missing, cx);
  }

  // Read the ended record of each session that has no live terminal. Only reads: the panel
  // never writes an ended record or anything else.
  lookUpEnded(stateDir: string, sessions: string[], cx: Context) {
    const generation = ++this.endedGeneration;
    this.endedFor = sessions.join("\0");
    cx.spawn(async (task) => {
      const found = await Promise.all(
        sessions.map(async (session) => {
          const text = await this.read(endedPath(stateDir, session));
          return [session, text === null ? undefined : endedDate(text)] as const;
        }),
      );
      if (generation !== this.endedGeneration) return;
      const ended = new Map<string, string | null>();
      for (const [session, at] of found) if (at !== undefined) ended.set(session, at);
      this.ended = ended;
      task.notify();
    });
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
      this.stateDir = stateDir;
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
      if (doc.kind === "loaded")
        this.lookUpEnded(stateDir, missingSessions(doc.backlog, terminals()), task);
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
    this.clearDraft();
    cx.notify();
  }

  // Forget the draft and empty the field, so another item or ask starts clean.
  clearDraft() {
    this.draft = undefined;
    this.input?.set_value("");
  }

  setTyping(typing: boolean, cx: Context) {
    this.typing = typing;
    cx.notify();
  }

  // The open item's ask and the draft for it now, or undefined when it has no ask.
  answering(): { item: Item; draft: AnswerDraft } | undefined {
    const domain = this.target();
    const doc: DocumentState = domain === this.domain ? this.doc : { kind: "loading" };
    const item = this.detail(domain, doc);
    if (domain === undefined || item === undefined || item.ask === null) return undefined;
    return { item, draft: draftFor(draftKey(domain, item, item.ask), item.ask, this.draft) };
  }

  choose(option: string, cx: Context) {
    const open = this.answering();
    if (open === undefined || open.draft.busy) return;
    this.draft = { ...open.draft, choice: option, text: "", error: undefined };
    this.input?.set_value("");
    cx.notify();
  }

  type(value: string, cx: Context) {
    const open = this.answering();
    if (open === undefined || open.draft.text === value) return;
    this.draft = { ...open.draft, text: value, error: undefined };
    cx.notify();
  }

  // Record the draft's answer with the coordinate CLI. Success is exit 0 and nothing less: the
  // draft clears and the document is read again; any other end shows the CLI's message.
  answer(cx: Context) {
    const open = this.answering();
    if (open === undefined || open.draft.busy || this.domain === undefined) return;
    const answer = chosenAnswer(open.draft);
    if (answer === undefined) return;
    const { key } = open.draft;
    const { command, args } = answerCommand(home(), this.domain, open.item.id, answer);
    this.draft = { ...open.draft, busy: true, error: undefined };
    cx.notify();
    cx.spawn(async (task) => {
      let error: string | undefined;
      try {
        const ran = await exec(command, args);
        if (ran.code !== 0) error = answerFailure(ran);
      } catch (failure) {
        error = `could not run coordinate: ${String(failure)}`;
      }
      if (this.draft?.key !== key) return;
      if (error === undefined) {
        this.clearDraft();
        this.load(task);
      } else this.draft = { ...this.draft, busy: false, error };
      task.notify();
    });
  }

  // The answer row's model for the view, when the open item has an ask.
  answerModel(): AnswerModel | undefined {
    const open = this.answering();
    if (open === undefined) return undefined;
    return {
      draft: open.draft,
      input: this.input,
      typing: this.typing,
      choose: (option, cx) => this.choose(option, cx),
      submit: (cx) => this.answer(cx),
    };
  }

  // Back closes an item's detail first, then leaves a domain opened from the listing.
  back(cx: Context) {
    if (this.selected !== undefined) {
      this.selected = undefined;
      this.clearDraft();
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

  // The document's delegates joined to the terminals live now.
  delegates(domain: string | undefined, doc: DocumentState): DelegateJoin {
    if (domain === undefined || doc.kind !== "loaded") return { byItem: new Map(), unfiled: [] };
    return joinDelegates(doc.backlog, terminals(), this.ended, domain);
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
      delegates: this.delegates(domain, doc),
      openDomain: (name, cx) => this.openDomain(name, cx),
      isOpen: (group) => this.isOpen(group),
      toggle: (group, cx) => this.toggleFold(group, cx),
      detail: this.detail(domain, doc),
      open: (item, cx) => this.open(item, cx),
      answer: this.answerModel(),
      back: (cx) => this.back(cx),
    });
  }
}
