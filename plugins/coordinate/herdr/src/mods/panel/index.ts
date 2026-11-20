// coordinate-panel: one coordinate domain's backlog, following the focused terminal. Its one
// write is answering an item's ask, through the coordinate CLI.
import { View } from "gpui-kit";
import { InputState } from "gpui-base";
import { createAnswerInput } from "./textarea.ts";
import type { AsyncContext, Context, Element } from "gpui-kit";
import { checking, exec, focused, home, readTextFile, terminals, theme, watchFolder } from "herdr";
import type { FolderWatch } from "herdr";
import {
  FOLDED_BY_DEFAULT,
  LIST_SCRIPT,
  answerCommand,
  answerFailure,
  boundaryCommand,
  boundaryOutput,
  cachedDocument,
  chosenAnswer,
  configPath,
  countLiveDelegates,
  draftFor,
  draftKey,
  endedDate,
  endedPath,
  groupItems,
  joinDelegates,
  mergeEnded,
  missingSessions,
  openFindings,
  parseListing,
  readDocument,
  stateDirOf,
  summarize,
  targetDomain,
  trailOf,
} from "./model.ts";
import type {
  AnswerDraft,
  DelegateJoin,
  DocumentState,
  DomainPage,
  DomainSummary,
  EndedRecords,
  ItemGroup,
  ListingState,
  Screen,
} from "./model.ts";
import { backlogsDir, documentPath } from "../../lib/store.ts";
import type { Finding, Item } from "../../lib/store.ts";
import { panel } from "./view.ts";
import type { AnswerModel, BoundaryList, BoundaryModel, Theme } from "./view.ts";

// How often the panel checks whether focus moved to another domain, and how often it rereads
// the document in case a folder watch was reclaimed.
const FOLLOW_MS = 1_000;
const REFRESH_MS = 30_000;
const ROW_PAGE_SIZE = 10;

/**
 * The Backlog panel.
 */
export default class Panel extends View {
  // The domain the document belongs to, and what is known about it.
  domain: string | undefined;
  doc: DocumentState = { kind: "loading" };
  // The last state read for each domain this session, drawn while a reread of it runs.
  docs = new Map<string, DocumentState>();
  // The domain focus last named, kept while a pane with no terminal (the panel) has focus.
  followed: string | undefined;
  // The domain opened from the listing or the trail, shown over the one focus names until
  // focus moves to another domain terminal. The Domains crumb clears it.
  picked: string | undefined;
  // The Domains crumb was pressed: the listing shows, whatever domain focus names, until a
  // domain is opened or focus moves to another domain terminal.
  listed = false;
  // The all-domains listing, kept across opening a domain so Back shows it at once.
  listing: ListingState = { kind: "loading" };
  // Bumped by every load, so a slower, older read never overwrites a newer one.
  generation = 0;
  // Fold state per domain and status, for groups the user has folded or opened.
  folds = new Map<string, boolean>();
  // Rows revealed per group in the current domain.
  paginationDomain: string | undefined;
  revealedRows = new Map<string, number>();
  // The backlogs folder being watched, and the pending watch on it.
  watched: string | undefined;
  watch: FolderWatch | undefined;
  // The item or finding whose detail is open, by domain and id, so a reload shows its latest
  // copy and a vanished record falls back to the lists.
  selected: { kind: "item" | "finding"; domain: string; id: string } | undefined;
  // A domain page remains mounted beneath a finding detail so its scroll position is retained.
  page: DomainPage | undefined;
  // The state folder the last load found, the ended records read for the delegate refs that had
  // no live terminal then, and which sessions those were, so a delegate that loses its terminal
  // between document changes is looked up again.
  stateDir: string | undefined;
  ended: EndedRecords = new Map();
  endedFor: string | undefined;
  endedGeneration = 0;
  // The answer field's retained text state, whether it has the keyboard, and the draft being
  // written on the open item's ask.
  input: ReturnType<typeof createAnswerInput> | undefined;
  typing = false;
  draft: AnswerDraft | undefined;
  boundaryInput: InputState | undefined;
  boundaryEditing: { domain: string; list: BoundaryList } | undefined;
  boundaryBusy = false;
  boundaryHovered: string | undefined;
  boundaryError: BoundaryModel["error"];

  init(_props: unknown, cx: AsyncContext) {
    const input = createAnswerInput();
    input.on("change", (_event, changed) => this.type(input.value(), changed));
    input.on("submit", (_event, submitted) => this.answer(submitted));
    input.on("focus", (_event, gained) => this.setTyping(true, gained));
    input.on("blur", (_event, lost) => this.setTyping(false, lost));
    this.input = input;
    const boundaryInput = InputState.new({ placeholder: "Path" });
    boundaryInput.on("submit", (_event, submitted) => this.addBoundary(submitted));
    this.boundaryInput = boundaryInput;
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
    return this.listed ? undefined : (this.picked ?? this.focusDomain());
  }

  // Record where focus went: a focused domain terminal replaces a domain opened by hand.
  track() {
    const followed = this.focusDomain();
    if (followed === this.followed) return;
    this.followed = followed;
    this.page = undefined;
    this.selected = undefined;
    if (followed === undefined) return;
    this.picked = undefined;
    this.listed = false;
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
      this.ended = mergeEnded(this.ended, found);
      task.notify();
    });
  }

  openDomain(domain: string, cx: Context) {
    this.picked = domain;
    this.listed = false;
    this.page = undefined;
    this.selected = undefined;
    this.load(cx);
  }

  // Open a screen the trail or a link names. Details open over their list, pages open over the
  // domain's main list, and Domains shows the listing.
  go(screen: Screen, cx: Context) {
    if (screen.kind === "item" || screen.kind === "finding") {
      this.selected = { kind: screen.kind, domain: screen.domain, id: screen.id };
      this.page =
        screen.kind === "finding" ? { kind: "findings", domain: screen.domain } : undefined;
      this.clearDraft();
      cx.notify();
      return;
    }
    this.selected = undefined;
    this.clearDraft();
    if (screen.kind === "domains") {
      this.page = undefined;
      this.picked = undefined;
      this.listed = true;
      this.load(cx);
      return;
    }
    if (screen.kind === "domain") {
      this.page = undefined;
      if (this.target() === screen.domain) {
        cx.notify();
        return;
      }
      this.openDomain(screen.domain, cx);
      return;
    }
    this.page = screen;
    this.picked = screen.domain;
    this.listed = false;
    if (this.target() === screen.domain) {
      cx.notify();
      return;
    }
    this.load(cx);
  }

  load(cx: Context) {
    const generation = ++this.generation;
    this.track();
    const domain = this.target();
    if (domain !== this.paginationDomain) {
      this.paginationDomain = domain;
      this.revealedRows.clear();
    }
    cx.spawn(async (task) => {
      const stateDir = stateDirOf(await this.read(configPath(home())), home());
      if (generation !== this.generation) return;
      this.stateDir = stateDir;
      this.watchBacklogs(backlogsDir(stateDir), task);
      if (domain !== this.domain) {
        this.domain = domain;
        this.selected = undefined;
        this.doc = cachedDocument(this.docs, domain);
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
      this.docs.set(domain, doc);
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
    const live = terminals();
    const rows = await Promise.all(
      names.map(async (name) => {
        const doc = await this.readDomain(stateDir, name);
        const agents =
          doc.kind === "loaded"
            ? countLiveDelegates(joinDelegates(doc.backlog, live, this.ended, name))
            : 0;
        return summarize(name, doc, agents);
      }),
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
    this.go({ kind: "item", domain: this.domain, id: item.id }, cx);
  }

  openFinding(finding: Finding, cx: Context) {
    if (this.domain === undefined) return;
    this.go({ kind: "finding", domain: this.domain, id: finding.id }, cx);
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
    const doc = domain === this.domain ? this.doc : cachedDocument(this.docs, domain);
    const item = this.detail(domain, doc);
    if (domain === undefined || item === undefined || item.ask === null) return undefined;
    return { item, draft: draftFor(draftKey(domain, item, item.ask), item.ask, this.draft) };
  }

  choose(option: string, cx: Context) {
    const open = this.answering();
    if (open === undefined || open.draft.busy) return;
    this.draft = {
      ...open.draft,
      choice: open.draft.choice === option ? undefined : option,
      discuss: false,
      text: "",
      error: undefined,
    };
    this.input?.set_value("");
    cx.notify();
  }

  discuss(cx: Context) {
    const open = this.answering();
    if (open === undefined || open.draft.busy) return;
    this.draft = {
      ...open.draft,
      choice: undefined,
      discuss: !open.draft.discuss,
      text: "",
      error: undefined,
    };
    this.input?.set_value("");
    if (this.draft.discuss) this.input?.focus();
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
    const note =
      open.draft.choice !== undefined || open.draft.discuss
        ? open.draft.text.trim() || undefined
        : undefined;
    const { key } = open.draft;
    const { command, args } = answerCommand(home(), this.domain, open.item.id, answer, note);
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
      discuss: (cx) => this.discuss(cx),
      submit: (cx) => this.answer(cx),
    };
  }

  beginBoundary(list: BoundaryList, cx: Context) {
    const domain = this.target();
    if (domain === undefined || this.boundaryBusy) return;
    this.boundaryEditing = { domain, list };
    this.boundaryError = undefined;
    this.boundaryInput?.set_value("");
    this.boundaryInput?.focus();
    cx.notify();
  }

  cancelBoundary(cx: Context) {
    this.boundaryEditing = undefined;
    this.boundaryError = undefined;
    this.boundaryInput?.set_value("");
    cx.notify();
  }

  hoverBoundary(domain: string, list: BoundaryList, path: string, hovered: boolean, cx: Context) {
    const key = `${domain}\\0${list}\\0${path}`;
    if (hovered) {
      if (this.boundaryHovered === key) return;
      this.boundaryHovered = key;
    } else {
      if (this.boundaryHovered !== key) return;
      this.boundaryHovered = undefined;
    }
    cx.notify();
  }

  applyBoundary(domain: string, boundary: NonNullable<ReturnType<typeof boundaryOutput>>) {
    const current = this.docs.get(domain) ?? (this.domain === domain ? this.doc : undefined);
    if (current?.kind !== "loaded") return;
    const updated: DocumentState = {
      ...current,
      backlog: { ...current.backlog, boundary },
    };
    this.docs.set(domain, updated);
    if (this.domain === domain) this.doc = updated;
  }

  addBoundary(cx: Context) {
    const editing = this.boundaryEditing;
    if (editing === undefined || this.boundaryBusy) return;
    const { domain, list } = editing;
    const path = this.boundaryInput?.value().trim() ?? "";
    if (path === "") {
      this.boundaryError = {
        domain,
        list,
        path: undefined,
        message: "refused: path must not be blank",
      };
      cx.notify();
      return;
    }
    this.runBoundary("add", list, path, domain, cx);
  }

  removeBoundary(list: BoundaryList, path: string, cx: Context) {
    const domain = this.target();
    if (domain === undefined || this.boundaryBusy) return;
    this.runBoundary("rm", list, path, domain, cx);
  }

  runBoundary(action: "add" | "rm", list: BoundaryList, path: string, domain: string, cx: Context) {
    const { command, args } = boundaryCommand(home(), domain, action, path, list === "adjacent");
    this.boundaryBusy = true;
    this.boundaryError = undefined;
    cx.notify();
    cx.spawn(async (task) => {
      let error: string | undefined;
      let boundary: ReturnType<typeof boundaryOutput>;
      try {
        const ran = await exec(command, args);
        if (ran.code !== 0)
          error = ran.stderr.trim() || ran.stdout.trim() || `coordinate exited ${ran.code}`;
        else boundary = boundaryOutput(ran.stdout);
      } catch (failure) {
        error = `could not run coordinate: ${String(failure)}`;
      }
      this.boundaryBusy = false;
      if (error === undefined) {
        if (boundary !== undefined) this.applyBoundary(domain, boundary);
        if (
          action === "add" &&
          this.boundaryEditing?.domain === domain &&
          this.boundaryEditing.list === list
        ) {
          this.boundaryEditing = undefined;
          this.boundaryInput?.set_value("");
        }
        this.load(task);
      } else {
        this.boundaryError = { domain, list, path, message: error };
      }
      task.notify();
    });
  }

  boundaryModel(domain: string | undefined): BoundaryModel {
    const editing = this.boundaryEditing;
    const error = this.boundaryError;
    return {
      domain: domain ?? "domains",
      editing: domain !== undefined && editing?.domain === domain ? editing.list : undefined,
      input: this.boundaryInput,
      busy: this.boundaryBusy,
      hovered: this.boundaryHovered,
      error: domain !== undefined && error?.domain === domain ? error : undefined,
      begin: (list, cx) => this.beginBoundary(list, cx),
      cancel: (cx) => this.cancelBoundary(cx),
      remove: (list, path, cx) => this.removeBoundary(list, path, cx),
      hover: (list, path, hovered, cx) => {
        if (domain !== undefined) this.hoverBoundary(domain, list, path, hovered, cx);
      },
    };
  }

  // The open item as the document now has it, if it is still there.
  detail(domain: string | undefined, doc: DocumentState): Item | undefined {
    const selected = this.selected;
    if (selected?.kind !== "item" || selected.domain !== domain || doc.kind !== "loaded")
      return undefined;
    return doc.backlog.items.find((item) => item.id === selected.id);
  }

  // The open finding as the document now has it, if it is still there.
  findingDetail(domain: string | undefined, doc: DocumentState): Finding | undefined {
    const selected = this.selected;
    if (selected?.kind !== "finding" || selected.domain !== domain || doc.kind !== "loaded")
      return undefined;
    return doc.backlog.findings.find((finding) => finding.id === selected.id);
  }

  // The screen drawn: a detail only while its record is still in the document.
  screen(
    domain: string | undefined,
    item: Item | undefined,
    finding: Finding | undefined,
    page: DomainPage | undefined,
  ): Screen {
    if (domain === undefined) return { kind: "domains" };
    if (item !== undefined) return { kind: "item", domain, id: item.id };
    if (finding !== undefined) return { kind: "finding", domain, id: finding.id };
    if (page?.domain === domain) return page;
    return { kind: "domain", domain };
  }

  visibleRows(domain: string | undefined, group: string, total: number): number {
    const revealed =
      domain === this.paginationDomain
        ? (this.revealedRows.get(group) ?? ROW_PAGE_SIZE)
        : ROW_PAGE_SIZE;
    return Math.min(total, revealed);
  }

  revealMore(domain: string | undefined, group: string, cx: Context) {
    if (domain !== this.paginationDomain) {
      this.paginationDomain = domain;
      this.revealedRows.clear();
    }
    this.revealedRows.set(group, (this.revealedRows.get(group) ?? ROW_PAGE_SIZE) + ROW_PAGE_SIZE);
    cx.notify();
  }

  // The document's delegates joined to the terminals live now.
  delegates(domain: string | undefined, doc: DocumentState): DelegateJoin {
    if (domain === undefined || doc.kind !== "loaded") return { byItem: new Map(), unfiled: [] };
    return joinDelegates(doc.backlog, terminals(), this.ended, domain);
  }

  render(): Element {
    const domain = this.target();
    const doc = domain === this.domain ? this.doc : cachedDocument(this.docs, domain);
    const detail = this.detail(domain, doc);
    const finding = this.findingDetail(domain, doc);
    const origin =
      finding?.from === null || finding === undefined || doc.kind !== "loaded"
        ? undefined
        : doc.backlog.items.find((item) => item.id === finding.from);
    return panel(theme() as Theme, {
      domain,
      doc,
      listing: this.listing,
      trail: trailOf(this.screen(domain, detail, finding, this.page)),
      go: (screen, cx) => this.go(screen, cx),
      groups: doc.kind === "loaded" ? groupItems(doc.backlog) : [],
      findings: doc.kind === "loaded" ? openFindings(doc.backlog) : [],
      page: this.page === undefined || this.page.domain !== domain ? undefined : this.page.kind,
      finding,
      origin,
      openFinding: (record, cx) => this.openFinding(record, cx),
      delegates: this.delegates(domain, doc),
      openDomain: (name, cx) => this.openDomain(name, cx),
      isOpen: (group) => this.isOpen(group),
      toggle: (group, cx) => this.toggleFold(group, cx),
      visibleRows: (group, total) => this.visibleRows(domain, group, total),
      loadMore: (group, cx) => this.revealMore(domain, group, cx),
      detail,
      open: (item, cx) => this.open(item, cx),
      answer: this.answerModel(),
      boundary: this.boundaryModel(domain),
    });
  }
}
