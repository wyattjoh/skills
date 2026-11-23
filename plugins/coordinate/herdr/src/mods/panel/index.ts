// coordinate-panel: one coordinate domain's backlog, following the focused terminal. Backlog
// answers and delegate-harness policy edits go through the coordinate CLI.
import { View } from "gpui-kit";
import { InputState } from "gpui-base";
import { PANEL } from "@wyattjoh/herdr-ui";
import { createAnswerInput } from "./textarea.ts";
import type { AsyncContext, Context, Element, FocusHandle } from "gpui-kit";
import { checking, exec, focused, home, readTextFile, terminals, theme, watchFolder } from "herdr";
import { closeOverlay, openOverlay } from "./overlay.ts";
import type { FolderWatch } from "herdr";
import {
  FOLDED_BY_DEFAULT,
  LIST_SCRIPT,
  answerCommand,
  answerFailure,
  boundaryCommand,
  boundaryOutput,
  cachedDocument,
  changedBacklogDocuments,
  chosenAnswer,
  configPath,
  countLiveDelegates,
  draftFor,
  draftKey,
  endedDate,
  endedPath,
  groupItems,
  harnessPolicyFailure,
  harnessPolicyOutput,
  harnessPolicyResetCommand,
  harnessPolicySetCommand,
  harnessPolicyShowCommand,
  changedHarnessPolicy,
  joinDelegates,
  mergeEnded,
  missingSessions,
  openFindings,
  parseListing,
  policyDialogProps,
  policyDialogSpec,
  readDocument,
  sameHarnessSelection,
  stateDirOf,
  summarize,
  targetDomain,
  trailOf,
} from "./model.ts";
import type {
  AnswerDraft,
  DelegateHarness,
  DelegateJoin,
  DocumentState,
  DomainPage,
  DomainSummary,
  EndedRecords,
  HarnessPolicyDraft,
  HarnessPolicyState,
  HarnessSelection,
  ItemGroup,
  ListingState,
  PolicyDialogProps,
  Screen,
} from "./model.ts";
import { advanceAnswerFlow, startAnswerFlow } from "./answer-flow.ts";
import type { AnswerFlow } from "./answer-flow.ts";
import {
  ANSWER_CAROUSEL,
  ANSWER_FLOW_SPEED_OPTIONS,
  ANSWER_FLOW_LAYOUT_BASELINE,
  ANSWER_FLOW_LAYOUT_PROPOSALS,
  answerFlowLayoutFor,
} from "./look.ts";
import type { AnswerFlowLayoutId } from "./look.ts";
import { backlogsDir, documentPath } from "../../lib/store.ts";
import type { Finding, Item } from "../../lib/store.ts";
import { harnessPolicyDialog, panel } from "./view.ts";
import type {
  AnswerFlowModel,
  AnswerFlowMotion,
  AnswerModel,
  BoundaryList,
  BoundaryModel,
  HarnessPolicyEditorModel,
  Theme,
} from "./view.ts";

// How often the panel checks whether focus moved to another domain, and how often it rereads
// the document in case a folder watch was reclaimed.
const FOLLOW_MS = 1_000;
const REFRESH_MS = 30_000;
const ROW_PAGE_SIZE = 10;
type DomainRead = {
  document: DocumentState;
  text: string | null | undefined;
};

type AnswerFlowTransitionAction = "answered" | "skipped" | "back" | "exit";
type AnswerFlowTransition = AnswerFlowMotion & {
  generation: number;
  action: AnswerFlowTransitionAction;
  targetFlow: AnswerFlow | undefined;
};
type FlowCardMeasurement = { width: number; height: number };
type FlowCardSize = {
  compact: FlowCardMeasurement | undefined;
  expanded: FlowCardMeasurement | undefined;
};

/**
 * The Backlog panel.
 */
export default class Panel extends View {
  // The domain the document belongs to, and what is known about it.
  domain: string | undefined;
  doc: DocumentState = { kind: "loading" };
  // The last state read for each domain this session, drawn while a reread of it runs.
  docs = new Map<string, DocumentState>();
  // Raw snapshots let timer refreshes catch same-size rewrites and skip parsing unchanged text.
  rawDocs = new Map<string, string | null>();
  // Path events mark cached domain states stale; unrelated domains do not trigger a reload.
  dirtyDocs = new Set<string>();
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
  // The Coordinate state folder is also watched for policy writes from another panel or CLI.
  policyWatched: string | undefined;
  policyWatch: FolderWatch | undefined;
  // Set in the copy Herdr opens as the harness policy dialog: that copy shows only the editor,
  // for one scope, and never follows focus or reads a backlog.
  policyDialog: PolicyDialogProps | undefined;
  policyScope: string | null = null;
  policyStateDir: string | undefined;
  policyGeneration = 0;
  harnessPolicyState: HarnessPolicyState = { kind: "loading" };
  harnessPolicyDraft: HarnessPolicyDraft | undefined;
  harnessPolicyBusy = false;
  policyFailure: { domain: string | undefined; message: string } | undefined;
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
  noteInput: ReturnType<typeof createAnswerInput> | undefined;
  typing = false;
  noteTyping = false;
  draft: AnswerDraft | undefined;
  answerFlow: AnswerFlow | undefined;
  answerFlowSpeed = 0;
  answerFlowLayoutId: AnswerFlowLayoutId = ANSWER_FLOW_LAYOUT_BASELINE.id;
  answerFlowPendingLayout: AnswerFlowLayoutId | undefined;
  answerFlowLayoutMenuOpen = false;
  answerFlowLayoutActiveIndex = 0;
  answerFlowLayoutTriggerFocus!: FocusHandle;
  answerFlowLayoutMenuFocus!: FocusHandle;
  answerFlowLayoutMeasurementVersion = 0;
  answerFlowSpeedMenuOpen = false;
  answerFlowSpeedActiveIndex = 0;
  answerFlowSpeedTriggerFocus!: FocusHandle;
  answerFlowSpeedMenuFocus!: FocusHandle;
  answerFlowPendingExpandedSizes = new Map<string, FlowCardMeasurement>();
  answerFlowRationaleOpenFor: string | undefined;
  answerFlowRationaleFocus = new Map<string, FocusHandle>();
  answerFlowMotion: AnswerFlowTransition | undefined;
  answerFlowMotionGeneration = 0;
  answerFlowCardSizes = new Map<string, FlowCardSize>();
  // Sizes a card reported while a motion ran. Layout holds still during the motion, so these wait
  // here: a size callback fires only when the size changes, so a dropped report is never repeated.
  answerFlowDeferredSizes = new Map<string, FlowCardSize>();
  answerFlowViewport: { domain: string; width: number; height: number } | undefined;
  boundaryInput: InputState | undefined;
  boundaryEditing: { domain: string; list: BoundaryList } | undefined;
  boundaryBusy = false;
  boundaryHovered: string | undefined;
  boundaryError: BoundaryModel["error"];

  init(props: unknown, cx: AsyncContext) {
    this.policyDialog = policyDialogProps(props);
    if (this.policyDialog !== undefined) {
      if (checking()) return;
      this.loadPolicyDialog(cx);
      cx.timer.every(REFRESH_MS, (tick) => this.refresh(tick));
      return;
    }
    const input = createAnswerInput();
    input.on("change", (_event, changed) => this.type(input.value(), changed));
    input.on("submit", (_event, submitted) => this.answer(submitted));
    input.on("focus", (_event, gained) => this.setTyping(true, gained));
    input.on("blur", (_event, lost) => this.setTyping(false, lost));
    this.input = input;
    const noteInput = createAnswerInput("Optional note");
    noteInput.on("change", (_event, changed) => this.typeNote(noteInput.value(), changed));
    noteInput.on("focus", (_event, gained) => this.setNoteTyping(true, gained));
    noteInput.on("blur", (_event, lost) => this.setNoteTyping(false, lost));
    this.noteInput = noteInput;
    const boundaryInput = InputState.new({ placeholder: "Path" });
    boundaryInput.on("submit", (_event, submitted) => this.addBoundary(submitted));
    this.boundaryInput = boundaryInput;
    this.answerFlowLayoutTriggerFocus = cx.focus_handle();
    this.answerFlowLayoutMenuFocus = cx.focus_handle();
    this.answerFlowSpeedTriggerFocus = cx.focus_handle();
    this.answerFlowSpeedMenuFocus = cx.focus_handle();
    if (checking()) return;
    this.load(cx);
    cx.timer.every(FOLLOW_MS, (tick) => this.follow(tick));
    cx.timer.every(REFRESH_MS, (tick) => this.refresh(tick));
  }

  // The domain focus names now.
  focusDomain(): string | undefined {
    return targetDomain(focused(), terminals(), this.followed);
  }

  // The domain the panel should show now, or undefined for the listing.
  target(): string | undefined {
    if (this.policyDialog !== undefined) return this.policyDialog.domain;
    return this.listed ? undefined : (this.picked ?? this.focusDomain());
  }

  // Record where focus went: a focused domain terminal replaces a domain opened by hand.
  track() {
    const followed = this.focusDomain();
    if (followed === this.followed) return;
    this.followed = followed;
    this.invalidateAnswerFlowMotion();
    this.answerFlow = undefined;
    this.page = undefined;
    this.selected = undefined;
    if (followed === undefined) return;
    this.picked = undefined;
    this.listed = false;
  }

  // The slow refresh checks both the visible document and CLI-owned policy state.
  refresh(cx: AsyncContext) {
    if (this.policyDialog === undefined) {
      this.load(cx, true);
      return;
    }
    if (this.stateDir !== undefined) this.loadHarnessPolicy(this.stateDir, this.target(), cx, true);
  }

  // The dialog copy reads only the state folder and the policy the CLI reports for its scope.
  loadPolicyDialog(cx: Context) {
    cx.spawn(async (task) => {
      const stateDir = stateDirOf(await this.read(configPath(home())), home());
      this.stateDir = stateDir;
      this.watchHarnessPolicy(stateDir, task);
      this.loadHarnessPolicy(stateDir, this.target(), task);
    });
  }

  // Open the editor as Herdr's centered dialog: a fresh copy of this mod, so its draft is gone
  // when the dialog closes.
  openHarnessPolicyDialog(domain: string | undefined) {
    openOverlay(policyDialogSpec(domain));
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
    this.invalidateAnswerFlowMotion();
    this.answerFlow = undefined;
    this.picked = domain;
    this.listed = false;
    this.page = undefined;
    this.selected = undefined;
    this.load(cx);
  }

  // Open a screen the trail or a link names. Details open over their list, pages open over the
  // domain's main list, and Domains shows the listing.
  go(screen: Screen, cx: Context) {
    this.invalidateAnswerFlowMotion();
    this.answerFlow = undefined;
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

  load(cx: Context, refresh = false) {
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
      if (this.stateDir !== undefined && this.stateDir !== stateDir) {
        this.docs.clear();
        this.rawDocs.clear();
        this.dirtyDocs.clear();
      }
      this.stateDir = stateDir;
      this.watchBacklogs(backlogsDir(stateDir), task);
      if (domain !== this.domain) {
        this.domain = domain;
        this.selected = undefined;
        this.doc = cachedDocument(this.docs, domain);
        task.notify();
      }
      if (domain === undefined) {
        const listing = await this.list(stateDir, refresh, generation);
        if (generation !== this.generation) return;
        this.listing = listing;
        task.notify();
        return;
      }
      const read = await this.readDomain(stateDir, domain, refresh);
      if (generation !== this.generation) return;
      this.cacheDomain(domain, read);
      this.doc = read.document;
      this.reconcileAnswerFlow(domain, read.document);
      task.notify();
      if (read.document.kind === "loaded")
        this.lookUpEnded(stateDir, missingSessions(read.document.backlog, terminals()), task);
    });
  }

  reconcileAnswerFlow(domain: string, document: DocumentState) {
    const flow = this.answerFlow;
    if (
      this.answerFlowMotion !== undefined ||
      flow === undefined ||
      flow.domain !== domain ||
      document.kind !== "loaded"
    )
      return;
    const currentId = flow.ids[flow.current];
    if (currentId === undefined || flow.answered.includes(currentId)) return;
    const item = document.backlog.items.find((candidate) => candidate.id === currentId);
    if (item !== undefined && item.ask !== null) return;
    this.answerFlow = advanceAnswerFlow(flow, item === undefined ? "skipped" : "answered");
    const next = this.answerFlow.ids[this.answerFlow.current];
    if (next !== undefined) this.selected = { kind: "item", domain, id: next };
  }

  // One domain's document. A rejected read (permissions, too large) is unreadable.
  async readDomain(stateDir: string, domain: string, refresh: boolean): Promise<DomainRead> {
    const cached = this.docs.get(domain);
    if (!refresh && !this.dirtyDocs.has(domain) && cached !== undefined)
      return { document: cached, text: this.rawDocs.get(domain) };
    try {
      const text = await readTextFile(documentPath(stateDir, domain));
      if (cached !== undefined && this.rawDocs.has(domain) && this.rawDocs.get(domain) === text)
        return { document: cached, text };
      return { document: readDocument(text), text };
    } catch (error) {
      return { document: { kind: "unreadable", reason: String(error) }, text: undefined };
    }
  }

  cacheDomain(domain: string, read: DomainRead) {
    this.docs.set(domain, read.document);
    if (read.text === undefined) this.rawDocs.delete(domain);
    else this.rawDocs.set(domain, read.text);
    this.dirtyDocs.delete(domain);
  }

  // Every domain document, listed through the shell, each read and summarized on its own so
  // one bad document only marks its own row.
  async list(stateDir: string, refresh: boolean, generation: number): Promise<ListingState> {
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
        const read = await this.readDomain(stateDir, name, refresh);
        if (generation === this.generation) this.cacheDomain(name, read);
        const agents =
          read.document.kind === "loaded"
            ? countLiveDelegates(joinDelegates(read.document.backlog, live, this.ended, name))
            : 0;
        return summarize(name, read.document, agents);
      }),
    );
    return {
      kind: "loaded",
      domains: rows.filter((row): row is DomainSummary => row !== undefined),
    };
  }

  // Reload relevant JSON changes. A released/reclaimed watch or failure ends the loop; the timer
  // refreshes the current view and re-arms the watch.
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
          const changes = changedBacklogDocuments(changed, dir);
          if (changes.all) {
            for (const domain of this.docs.keys()) this.dirtyDocs.add(domain);
            if (this.domain !== undefined) this.dirtyDocs.add(this.domain);
          }
          for (const domain of changes.domains) this.dirtyDocs.add(domain);
          const domain = this.target();
          if (
            changes.all ||
            (domain === undefined ? changes.domains.length > 0 : changes.domains.includes(domain))
          )
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

  // The policy file is a direct child of the configured state directory. Reload only for that
  // file or a directory event; backlog and ended-record changes do not alter editor state.
  watchHarnessPolicy(stateDir: string, cx: AsyncContext) {
    if (this.policyWatched === stateDir) return;
    this.policyWatch?.cancel();
    this.policyWatched = stateDir;
    let current = watchFolder(stateDir);
    this.policyWatch = current;
    cx.spawn(async (task) => {
      try {
        for (;;) {
          const changed = await current;
          if (this.policyWatch !== current || changed.length === 0) break;
          current = watchFolder(stateDir);
          this.policyWatch = current;
          if (changedHarnessPolicy(changed, stateDir))
            this.loadHarnessPolicy(stateDir, this.target(), task, true);
        }
      } catch {
        // Fall through: the watch is gone either way.
      }
      if (this.policyWatch !== current) return;
      this.policyWatch = undefined;
      this.policyWatched = undefined;
    });
  }

  loadHarnessPolicy(
    stateDir: string,
    domain: string | undefined,
    cx: Context,
    refresh = false,
    showLoading = false,
  ) {
    const scope = domain ?? "";
    const scopeChanged = this.policyScope !== scope || this.policyStateDir !== stateDir;
    if (!refresh && !scopeChanged) return;
    if (scopeChanged) {
      this.harnessPolicyDraft = undefined;
      this.policyFailure = undefined;
      this.harnessPolicyBusy = false;
      this.harnessPolicyState = { kind: "loading" };
    } else if (showLoading) {
      this.harnessPolicyState = { kind: "loading" };
    }
    this.policyScope = scope;
    this.policyStateDir = stateDir;
    const generation = ++this.policyGeneration;
    cx.spawn(async (task) => {
      const state = await this.readHarnessPolicy(domain);
      if (
        generation !== this.policyGeneration ||
        this.policyScope !== (domain ?? "") ||
        this.policyStateDir !== stateDir
      )
        return;
      this.harnessPolicyState = state;
      task.notify();
    });
  }

  async readHarnessPolicy(domain: string | undefined): Promise<HarnessPolicyState> {
    const { command, args } = harnessPolicyShowCommand(home(), domain);
    try {
      const ran = await exec(command, args);
      if (ran.code !== 0) return { kind: "error", message: harnessPolicyFailure(ran) };
      const view = harnessPolicyOutput(ran.stdout, domain);
      return view === undefined
        ? {
            kind: "error",
            message:
              "Coordinate returned invalid harness policy data. Update the Coordinate skill, then reopen this panel.",
          }
        : { kind: "loaded", view };
    } catch (failure) {
      return { kind: "error", message: `could not run coordinate: ${String(failure)}` };
    }
  }

  close() {
    this.watch?.cancel();
    this.policyWatch?.cancel();
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

  openWaiting(item: Item, cx: Context) {
    const domain = this.target();
    if (domain === undefined || item.ask === null) return;
    const doc = domain === this.domain ? this.doc : cachedDocument(this.docs, domain);
    if (doc.kind !== "loaded") return;
    const ids = doc.backlog.items
      .filter((candidate) => candidate.ask !== null)
      .map((candidate) => candidate.id);
    this.invalidateAnswerFlowMotion();
    this.answerFlowCardSizes.clear();
    this.answerFlowViewport = undefined;
    this.answerFlow = startAnswerFlow(domain, ids, item.id);
    this.answerFlowRationaleFocus = new Map(ids.map((id) => [id, cx.focus_handle()] as const));
    this.selected = { kind: "item", domain, id: item.id };
    this.page = undefined;
    this.clearDraft();
    cx.notify();
  }

  // Make the sizes reported during a motion the measured ones. Nothing remeasures a card whose
  // size already changed, so a stale size would outlive the content it measured.
  applyDeferredAnswerFlowSizes() {
    for (const [key, sizes] of this.answerFlowDeferredSizes) {
      const previous = this.answerFlowCardSizes.get(key) ?? {
        compact: undefined,
        expanded: undefined,
      };
      this.answerFlowCardSizes.set(key, {
        compact: sizes.compact ?? previous.compact,
        expanded: sizes.expanded ?? previous.expanded,
      });
    }
    this.answerFlowDeferredSizes.clear();
  }

  invalidateAnswerFlowMotion() {
    this.answerFlowMotionGeneration += 1;
    this.answerFlowMotion = undefined;
    this.applyDeferredAnswerFlowSizes();
    this.clearAnswerFlowLayoutPending();
  }

  clearAnswerFlowLayoutPending() {
    this.answerFlowPendingLayout = undefined;
    this.answerFlowPendingExpandedSizes.clear();
    this.answerFlowLayoutMeasurementVersion += 1;
    this.answerFlowLayoutMenuOpen = false;
    this.answerFlowSpeedMenuOpen = false;
    this.answerFlowRationaleOpenFor = undefined;
    this.answerFlowRationaleFocus.clear();
  }

  restartAnswerFlowLayoutMeasurement() {
    if (this.answerFlowPendingLayout === undefined) return;
    this.answerFlowPendingExpandedSizes.clear();
    this.answerFlowLayoutMeasurementVersion += 1;
  }

  flowCardSizeKey(domain: string, id: string) {
    return `${domain}\\0${id}`;
  }

  answerFlowCardMeasurement(domain: string, id: string, kind: "compact" | "expanded") {
    return this.answerFlowCardSizes.get(this.flowCardSizeKey(domain, id))?.[kind];
  }

  answerFlowReady(domain: string, ids: readonly string[]) {
    const viewport = this.answerFlowViewport;
    if (
      viewport === undefined ||
      viewport.domain !== domain ||
      viewport.width <= 0 ||
      viewport.height <= 0
    )
      return false;
    const tolerance = Math.max(1, viewport.width * 0.01);
    const expandedWidth = viewport.width * ANSWER_CAROUSEL.compactWidthRatio;
    const compactWidth = Math.max(1, expandedWidth - 2 * PANEL.padding);
    return [...ids, "done"].every((id) => {
      const compact = this.answerFlowCardMeasurement(domain, id, "compact");
      const expanded = this.answerFlowCardMeasurement(domain, id, "expanded");
      return (
        compact !== undefined &&
        expanded !== undefined &&
        Math.abs(compact.width - compactWidth) < tolerance &&
        Math.abs(expanded.width - expandedWidth) < tolerance
      );
    });
  }

  measureAnswerFlowViewport(domain: string, size: FlowCardMeasurement, cx: Context) {
    if (size.width <= 0 || size.height <= 0) return;
    const previous = this.answerFlowViewport;
    if (
      previous !== undefined &&
      previous.domain === domain &&
      Math.abs(previous.width - size.width) < 1 &&
      Math.abs(previous.height - size.height) < 1
    )
      return;
    const widthChanged =
      previous !== undefined &&
      previous.domain === domain &&
      Math.abs(previous.width - size.width) >= 1;
    this.answerFlowViewport = { domain, ...size };
    if (widthChanged) this.restartAnswerFlowLayoutMeasurement();
    cx.notify();
  }

  measureAnswerFlowCard(
    domain: string,
    id: string,
    kind: "compact" | "expanded",
    size: FlowCardMeasurement,
    cx: Context,
  ) {
    if (size.width <= 0 || size.height <= 0) return;
    const key = this.flowCardSizeKey(domain, id);
    if (this.answerFlowMotion !== undefined) {
      this.answerFlowDeferredSizes.set(key, {
        ...(this.answerFlowDeferredSizes.get(key) ?? { compact: undefined, expanded: undefined }),
        [kind]: size,
      });
      return;
    }
    const previous = this.answerFlowCardSizes.get(key) ?? {
      compact: undefined,
      expanded: undefined,
    };
    const priorMeasurement = previous[kind];
    if (
      priorMeasurement !== undefined &&
      Math.abs(priorMeasurement.width - size.width) < 1 &&
      Math.abs(priorMeasurement.height - size.height) < 1
    )
      return;
    this.answerFlowCardSizes.set(key, { ...previous, [kind]: size });
    cx.notify();
  }

  measureAnswerFlowLayoutCard(
    domain: string,
    layoutId: AnswerFlowLayoutId,
    version: number,
    id: string,
    size: FlowCardMeasurement,
    cx: Context,
  ) {
    const flow = this.answerFlow;
    const viewport = this.answerFlowViewport;
    if (
      flow === undefined ||
      flow.domain !== domain ||
      this.answerFlowMotion !== undefined ||
      this.answerFlowPendingLayout !== layoutId ||
      this.answerFlowLayoutMeasurementVersion !== version ||
      !flow.ids.includes(id) ||
      viewport?.domain !== domain ||
      size.width <= 0 ||
      size.height <= 0
    )
      return;
    const expectedWidth = viewport.width * ANSWER_CAROUSEL.compactWidthRatio;
    const tolerance = Math.max(1, viewport.width * 0.01);
    if (Math.abs(size.width - expectedWidth) >= tolerance) return;
    const previous = this.answerFlowPendingExpandedSizes.get(id);
    if (
      previous !== undefined &&
      Math.abs(previous.width - size.width) < 1 &&
      Math.abs(previous.height - size.height) < 1
    )
      return;
    this.answerFlowPendingExpandedSizes.set(id, size);
    if (flow.ids.some((flowId) => !this.answerFlowPendingExpandedSizes.has(flowId))) return;

    const nextSizes = new Map(this.answerFlowCardSizes);
    for (const flowId of flow.ids) {
      const key = this.flowCardSizeKey(domain, flowId);
      const previousSize = nextSizes.get(key) ?? { compact: undefined, expanded: undefined };
      nextSizes.set(key, {
        ...previousSize,
        expanded: this.answerFlowPendingExpandedSizes.get(flowId),
      });
    }
    this.answerFlowCardSizes = nextSizes;
    this.answerFlowLayoutId = layoutId;
    this.answerFlowPendingLayout = undefined;
    this.answerFlowPendingExpandedSizes.clear();
    cx.notify();
  }

  setAnswerFlowSpeedMenuOpen(open: boolean, cx: Context) {
    if (this.answerFlow === undefined || this.answerFlowSpeedMenuOpen === open) return;
    this.answerFlowSpeedMenuOpen = open;
    if (open) {
      this.answerFlowLayoutMenuOpen = false;
      this.answerFlowSpeedActiveIndex = this.answerFlowSpeed;
      this.answerFlowSpeedMenuFocus.focus();
    } else this.answerFlowSpeedTriggerFocus.focus();
    cx.notify();
  }

  setAnswerFlowSpeed(index: number, cx: Context) {
    if (
      this.answerFlow === undefined ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= ANSWER_FLOW_SPEED_OPTIONS.length
    )
      return;
    this.answerFlowSpeed = index;
    this.answerFlowSpeedMenuOpen = false;
    this.answerFlowSpeedTriggerFocus.focus();
    cx.notify();
  }

  moveAnswerFlowSpeedMenu(delta: number, cx: Context) {
    if (!this.answerFlowSpeedMenuOpen) return;
    const count = ANSWER_FLOW_SPEED_OPTIONS.length;
    this.answerFlowSpeedActiveIndex = (this.answerFlowSpeedActiveIndex + delta + count) % count;
    cx.notify();
  }

  setAnswerFlowSpeedActiveIndex(index: number, cx: Context) {
    const count = ANSWER_FLOW_SPEED_OPTIONS.length;
    if (
      !this.answerFlowSpeedMenuOpen ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= count ||
      this.answerFlowSpeedActiveIndex === index
    )
      return;
    this.answerFlowSpeedActiveIndex = index;
    cx.notify();
  }

  setAnswerFlowLayoutMenuOpen(open: boolean, cx: Context) {
    if (this.answerFlow === undefined || this.answerFlowLayoutMenuOpen === open) return;
    this.answerFlowLayoutMenuOpen = open;
    if (open) {
      this.answerFlowSpeedMenuOpen = false;
      const selectedId = this.answerFlowPendingLayout ?? this.answerFlowLayoutId;
      const selectedIndex = ANSWER_FLOW_LAYOUT_PROPOSALS.findIndex(({ id }) => id === selectedId);
      this.answerFlowLayoutActiveIndex = selectedIndex >= 0 ? selectedIndex : 0;
      this.answerFlowLayoutMenuFocus.focus();
    } else this.answerFlowLayoutTriggerFocus.focus();
    cx.notify();
  }

  moveAnswerFlowLayoutMenu(delta: number, cx: Context) {
    if (!this.answerFlowLayoutMenuOpen) return;
    const count = ANSWER_FLOW_LAYOUT_PROPOSALS.length + 1;
    this.answerFlowLayoutActiveIndex = (this.answerFlowLayoutActiveIndex + delta + count) % count;
    cx.notify();
  }

  setAnswerFlowLayoutActiveIndex(index: number, cx: Context) {
    const count = ANSWER_FLOW_LAYOUT_PROPOSALS.length + 1;
    if (
      !this.answerFlowLayoutMenuOpen ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= count ||
      this.answerFlowLayoutActiveIndex === index
    )
      return;
    this.answerFlowLayoutActiveIndex = index;
    cx.notify();
  }

  activateAnswerFlowLayoutMenu(cx: Context) {
    if (!this.answerFlowLayoutMenuOpen) return;
    const resetIndex = ANSWER_FLOW_LAYOUT_PROPOSALS.length;
    if (this.answerFlowLayoutActiveIndex === resetIndex) {
      this.resetAnswerFlowLayout(cx);
      return;
    }
    const layout = ANSWER_FLOW_LAYOUT_PROPOSALS[this.answerFlowLayoutActiveIndex];
    if (layout !== undefined) this.selectAnswerFlowLayout(layout.id, cx);
  }

  requestAnswerFlowLayout(id: AnswerFlowLayoutId, cx: Context) {
    if (this.answerFlow === undefined) return;
    if (
      id !== ANSWER_FLOW_LAYOUT_BASELINE.id &&
      !ANSWER_FLOW_LAYOUT_PROPOSALS.some((layout) => layout.id === id)
    )
      return;
    this.answerFlowRationaleOpenFor = undefined;
    const next = id === this.answerFlowLayoutId ? undefined : id;
    if (next !== this.answerFlowPendingLayout) {
      this.answerFlowPendingLayout = next;
      this.answerFlowPendingExpandedSizes.clear();
      this.answerFlowLayoutMeasurementVersion += 1;
    }
    this.answerFlowLayoutMenuOpen = false;
    this.answerFlowLayoutTriggerFocus.focus();
    cx.notify();
  }

  selectAnswerFlowLayout(id: AnswerFlowLayoutId, cx: Context) {
    if (!ANSWER_FLOW_LAYOUT_PROPOSALS.some((layout) => layout.id === id)) return;
    this.requestAnswerFlowLayout(id, cx);
  }

  resetAnswerFlowLayout(cx: Context) {
    this.requestAnswerFlowLayout(ANSWER_FLOW_LAYOUT_BASELINE.id, cx);
  }

  setAnswerFlowRationaleOpen(id: string, open: boolean, cx: Context) {
    const flow = this.answerFlow;
    if (
      flow === undefined ||
      this.answerFlowMotion !== undefined ||
      answerFlowLayoutFor(this.answerFlowLayoutId).rationale !== "popover" ||
      !flow.ids.includes(id) ||
      (open && this.answerFlowRationaleOpenFor === id) ||
      (!open && this.answerFlowRationaleOpenFor !== id)
    )
      return;
    this.answerFlowRationaleOpenFor = open ? id : undefined;
    cx.notify();
  }

  scheduleAnswerFlowTransition(cx: Context, duration: number, generation: number) {
    cx.timer.after(duration, (tick) => {
      const motion = this.answerFlowMotion;
      if (motion === undefined || motion.generation !== generation) return;
      if (motion.action === "exit") {
        this.finishAnswerFlowExit(motion, tick);
        return;
      }
      const next = motion.targetFlow;
      if (next === undefined) return;
      this.answerFlow = next;
      if (motion.action === "answered" && next.answered.length === next.ids.length) {
        this.finishAnswerFlowExit({ ...motion, action: "exit" }, tick);
        this.load(tick, true);
        return;
      }
      const id = next.ids[next.current];
      this.selected = id === undefined ? undefined : { kind: "item", domain: next.domain, id };
      this.clearDraft();
      this.answerFlowMotion = undefined;
      this.applyDeferredAnswerFlowSizes();
      if (motion.action === "answered") this.load(tick, true);
      else this.reconcileAnswerFlow(next.domain, this.doc);
      tick.notify();
    });
  }

  transitionAnswerFlow(action: AnswerFlowTransitionAction, cx: Context) {
    const flow = this.answerFlow;
    if (
      flow === undefined ||
      this.answerFlowMotion !== undefined ||
      this.draft?.busy === true ||
      !this.answerFlowReady(flow.domain, flow.ids)
    )
      return;
    let nextAction = action;
    let targetFlow: AnswerFlow | undefined;
    if (action === "answered" || action === "skipped") targetFlow = advanceAnswerFlow(flow, action);
    else if (action === "back") {
      if (flow.current <= 0) nextAction = "exit";
      else targetFlow = { ...flow, current: flow.current - 1 };
    }
    if (nextAction !== "exit" && (targetFlow === undefined || targetFlow === flow)) return;
    if (this.answerFlowLayoutMenuOpen) this.setAnswerFlowLayoutMenuOpen(false, cx);
    this.answerFlowRationaleOpenFor = undefined;
    this.restartAnswerFlowLayoutMeasurement();
    const generation = ++this.answerFlowMotionGeneration;
    const durationMultiplier = ANSWER_FLOW_SPEED_OPTIONS[this.answerFlowSpeed]?.durationFactor ?? 1;
    const duration = ANSWER_CAROUSEL.transitionDuration * durationMultiplier;
    this.answerFlowMotion = {
      action: nextAction,
      generation,
      targetFlow,
      targetIndex: targetFlow?.current,
      duration,
      exiting: nextAction === "exit",
    };
    cx.notify();
    this.scheduleAnswerFlowTransition(cx, duration, generation);
  }

  finishAnswerFlowExit(motion: AnswerFlowTransition, cx: Context) {
    if (this.answerFlowMotion?.generation !== motion.generation) return;
    const domain = this.answerFlow?.domain;
    this.answerFlowMotion = undefined;
    this.answerFlowDeferredSizes.clear();
    this.answerFlow = undefined;
    this.clearAnswerFlowLayoutPending();
    this.clearDraft();
    this.selected = undefined;
    this.page = undefined;
    this.picked = domain;
    this.listed = false;
    cx.notify();
  }

  backAnswerFlow(cx: Context) {
    this.transitionAnswerFlow("back", cx);
  }

  skipAnswerFlow(cx: Context) {
    this.transitionAnswerFlow("skipped", cx);
  }

  openFinding(finding: Finding, cx: Context) {
    if (this.domain === undefined) return;
    this.go({ kind: "finding", domain: this.domain, id: finding.id }, cx);
  }

  // Forget the draft and empty the field, so another item or ask starts clean.
  clearDraft() {
    this.draft = undefined;
    this.input?.set_value("");
    this.noteInput?.set_value("");
    this.typing = false;
    this.noteTyping = false;
  }

  setTyping(typing: boolean, cx: Context) {
    this.typing = typing;
    cx.notify();
  }

  setNoteTyping(typing: boolean, cx: Context) {
    this.noteTyping = typing;
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
    if (this.answerFlowMotion !== undefined || open === undefined || open.draft.busy) return;
    this.draft = {
      ...open.draft,
      choice: open.draft.choice === option ? undefined : option,
      discuss: false,
      text: "",
      note: "",
      error: undefined,
    };
    this.input?.set_value("");
    this.noteInput?.set_value("");
    this.noteTyping = false;
    cx.notify();
  }

  discuss(cx: Context) {
    const open = this.answering();
    if (this.answerFlowMotion !== undefined || open === undefined || open.draft.busy) return;
    this.draft = {
      ...open.draft,
      choice: undefined,
      discuss: !open.draft.discuss,
      text: "",
      note: "",
      error: undefined,
    };
    this.input?.set_value("");
    this.noteInput?.set_value("");
    this.noteTyping = false;
    if (this.draft.discuss) this.input?.focus();
    cx.notify();
  }

  type(value: string, cx: Context) {
    const open = this.answering();
    if (
      this.answerFlowMotion !== undefined ||
      open === undefined ||
      open.draft.busy ||
      open.draft.text === value
    )
      return;
    this.draft = { ...open.draft, text: value, error: undefined };
    cx.notify();
  }

  typeNote(value: string, cx: Context) {
    const open = this.answering();
    if (
      this.answerFlowMotion !== undefined ||
      open === undefined ||
      open.draft.busy ||
      open.draft.choice !== undefined ||
      open.draft.discuss ||
      open.draft.note === value
    )
      return;
    this.draft = { ...open.draft, note: value, error: undefined };
    cx.notify();
  }

  // Record the draft's answer with the coordinate CLI. Success is exit 0 and nothing less: the
  // draft clears and the document is read again; any other end shows the CLI's message.
  answer(cx: Context) {
    const open = this.answering();
    if (
      this.answerFlowMotion !== undefined ||
      open === undefined ||
      open.draft.busy ||
      this.domain === undefined
    )
      return;
    const answer = chosenAnswer(open.draft);
    if (answer === undefined) return;
    const noteText =
      open.draft.choice !== undefined || open.draft.discuss ? open.draft.text : open.draft.note;
    const note = noteText.trim() || undefined;
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
        const flow = this.answerFlow;
        if (flow !== undefined && flow.domain === this.domain) {
          this.draft = { ...open.draft, busy: false, error: undefined };
          this.transitionAnswerFlow("answered", task);
          return;
        }
        this.clearDraft();
        this.load(task, true);
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
      noteInput: this.noteInput,
      noteTyping: this.noteTyping,
      choose: (option, cx) => this.choose(option, cx),
      discuss: (cx) => this.discuss(cx),
      submit: (cx) => this.answer(cx),
    };
  }

  answerFlowModel(): AnswerFlowModel | undefined {
    const flow = this.answerFlow;
    if (flow === undefined || flow.domain !== this.target()) return undefined;
    const doc = flow.domain === this.domain ? this.doc : cachedDocument(this.docs, flow.domain);
    const backlog = doc.kind === "loaded" ? doc.backlog : undefined;
    const itemFor = (id: string) => backlog?.items.find((candidate) => candidate.id === id);
    const cards: AnswerFlowModel["cards"] = flow.ids.map((id) => {
      const sizes = this.answerFlowCardSizes.get(this.flowCardSizeKey(flow.domain, id));
      return {
        id,
        item: itemFor(id),
        kind: "question" as const,
        compactHeight: sizes?.compact?.height,
        expandedHeight: sizes?.expanded?.height,
      };
    });
    const summarySizes = this.answerFlowCardSizes.get(this.flowCardSizeKey(flow.domain, "done"));
    cards.push({
      id: "done",
      item: undefined,
      kind: "summary" as const,
      compactHeight: summarySizes?.compact?.height,
      expandedHeight: summarySizes?.expanded?.height,
    });
    const motion = this.answerFlowMotion;
    const counts = motion?.targetFlow ?? flow;
    return {
      domain: flow.domain,
      cards,
      currentIndex: flow.current,
      layout: answerFlowLayoutFor(this.answerFlowLayoutId),
      layoutSelection: answerFlowLayoutFor(this.answerFlowPendingLayout ?? this.answerFlowLayoutId),
      layoutPending: this.answerFlowPendingLayout !== undefined,
      layoutMenuOpen: this.answerFlowLayoutMenuOpen,
      layoutActiveIndex: this.answerFlowLayoutActiveIndex,
      layoutTriggerFocus: this.answerFlowLayoutTriggerFocus,
      layoutMenuFocus: this.answerFlowLayoutMenuFocus,
      layoutMeasurement:
        this.answerFlowPendingLayout !== undefined && motion === undefined
          ? answerFlowLayoutFor(this.answerFlowPendingLayout)
          : undefined,
      layoutMeasurementVersion: this.answerFlowLayoutMeasurementVersion,
      rationaleOpenFor: this.answerFlowRationaleOpenFor,
      viewport:
        this.answerFlowViewport?.domain === flow.domain
          ? { width: this.answerFlowViewport.width, height: this.answerFlowViewport.height }
          : undefined,
      ready: this.answerFlowReady(flow.domain, flow.ids),
      motion:
        motion === undefined
          ? undefined
          : {
              targetIndex: motion.targetIndex,
              duration: motion.duration,
              exiting: motion.exiting,
            },
      speedIndex: this.answerFlowSpeed,
      speedMenuOpen: this.answerFlowSpeedMenuOpen,
      speedActiveIndex: this.answerFlowSpeedActiveIndex,
      speedTriggerFocus: this.answerFlowSpeedTriggerFocus,
      speedMenuFocus: this.answerFlowSpeedMenuFocus,
      setSpeedMenuOpen: (open, cx) => this.setAnswerFlowSpeedMenuOpen(open, cx),
      moveSpeedMenu: (delta, cx) => this.moveAnswerFlowSpeedMenu(delta, cx),
      setSpeedActiveIndex: (index, cx) => this.setAnswerFlowSpeedActiveIndex(index, cx),
      setSpeed: (index, cx) => this.setAnswerFlowSpeed(index, cx),
      measureViewport: (size, cx) => this.measureAnswerFlowViewport(flow.domain, size, cx),
      measure: (id, kind, size, cx) => this.measureAnswerFlowCard(flow.domain, id, kind, size, cx),
      measureLayout: (layoutId, version, id, size, cx) =>
        this.measureAnswerFlowLayoutCard(flow.domain, layoutId, version, id, size, cx),
      setLayoutMenuOpen: (open, cx) => this.setAnswerFlowLayoutMenuOpen(open, cx),
      moveLayoutMenu: (delta, cx) => this.moveAnswerFlowLayoutMenu(delta, cx),
      setLayoutActiveIndex: (index, cx) => this.setAnswerFlowLayoutActiveIndex(index, cx),
      activateLayoutMenu: (cx) => this.activateAnswerFlowLayoutMenu(cx),
      selectLayout: (id, cx) => this.selectAnswerFlowLayout(id, cx),
      resetLayout: (cx) => this.resetAnswerFlowLayout(cx),
      setRationaleOpen: (id, open, cx) => this.setAnswerFlowRationaleOpen(id, open, cx),
      rationaleFocusFor: (id) => this.answerFlowRationaleFocus.get(id),
      position: Math.min(flow.current + 1, flow.ids.length),
      total: flow.ids.length,
      done: flow.current >= flow.ids.length,
      answeredCount: counts.answered.length,
      skippedCount: counts.skipped.length,
      answer: this.answerModel(),
      answerFor: (id) => {
        const selected = this.selected;
        if (selected?.kind !== "item" || selected.domain !== flow.domain || selected.id !== id)
          return undefined;
        return this.answerModel();
      },
      back: (cx) => this.backAnswerFlow(cx),
      skip: (cx) => this.skipAnswerFlow(cx),
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
        this.load(task, true);
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

  policyViewFor(domain: string | undefined) {
    if (
      this.policyScope !== (domain ?? "") ||
      this.policyStateDir !== this.stateDir ||
      this.harnessPolicyState.kind !== "loaded"
    )
      return undefined;
    const view = this.harnessPolicyState.view;
    if (domain === undefined) return view.domain === null ? view : undefined;
    return view.domain?.name === domain ? view : undefined;
  }

  policyDraftFor(domain: string | undefined): HarnessPolicyDraft | undefined {
    const draft = this.harnessPolicyDraft;
    return draft?.domain === domain ? draft : undefined;
  }

  beginHarnessPolicyOverride(domain: string | undefined, cx: Context) {
    if (domain === undefined || domain !== this.target() || this.harnessPolicyBusy) return;
    const view = this.policyViewFor(domain);
    if (view?.domain?.mode !== "inherit" || this.policyDraftFor(domain) !== undefined) return;
    this.harnessPolicyDraft = {
      scope: "domain",
      domain,
      revision: view.revision,
      selection: {
        enabled: [...view.domain.effective.enabled],
        default: view.domain.effective.default,
      },
    };
    this.policyFailure = undefined;
    cx.notify();
  }

  toggleHarnessPolicy(domain: string | undefined, harness: DelegateHarness, cx: Context) {
    if (domain !== this.target() || this.harnessPolicyBusy) return;
    const view = this.policyViewFor(domain);
    if (view === undefined) return;
    const draft = this.policyDraftFor(domain);
    if (draft !== undefined && draft.revision !== view.revision) return;
    if (domain !== undefined && view.domain?.mode === "inherit" && draft === undefined) return;
    const current =
      draft?.selection ?? (domain === undefined ? view.global.policy : view.domain!.effective);
    const enabled = new Set(current.enabled);
    if (enabled.has(harness)) enabled.delete(harness);
    else enabled.add(harness);
    const next: HarnessSelection = {
      enabled: (["pi", "claude"] as const).filter((entry) => enabled.has(entry)),
      default: current.default === harness && !enabled.has(harness) ? null : current.default,
    };
    this.harnessPolicyDraft = {
      scope: domain === undefined ? "global" : "domain",
      domain,
      revision: draft?.revision ?? view.revision,
      selection: next,
    };
    this.policyFailure = undefined;
    cx.notify();
  }

  setHarnessPolicyDefault(
    domain: string | undefined,
    defaultHarness: DelegateHarness | null,
    cx: Context,
  ) {
    if (domain !== this.target() || this.harnessPolicyBusy) return;
    const view = this.policyViewFor(domain);
    if (view === undefined) return;
    const draft = this.policyDraftFor(domain);
    if (draft !== undefined && draft.revision !== view.revision) return;
    if (domain !== undefined && view.domain?.mode === "inherit" && draft === undefined) return;
    const current =
      draft?.selection ?? (domain === undefined ? view.global.policy : view.domain!.effective);
    if (
      defaultHarness === current.default ||
      (defaultHarness !== null && !current.enabled.includes(defaultHarness))
    )
      return;
    this.harnessPolicyDraft = {
      scope: domain === undefined ? "global" : "domain",
      domain,
      revision: draft?.revision ?? view.revision,
      selection: { ...current, enabled: [...current.enabled], default: defaultHarness },
    };
    this.policyFailure = undefined;
    cx.notify();
  }

  cancelHarnessPolicyDraft(domain: string | undefined, cx: Context) {
    if (domain !== this.target() || this.harnessPolicyBusy) return;
    this.harnessPolicyDraft = undefined;
    this.policyFailure = undefined;
    cx.notify();
    if (this.policyDialog !== undefined) closeOverlay(this.policyDialog.overlay);
  }

  reloadHarnessPolicy(domain: string | undefined, cx: Context) {
    if (domain !== this.target() || this.harnessPolicyBusy || this.stateDir === undefined) return;
    this.harnessPolicyDraft = undefined;
    this.policyFailure = undefined;
    this.loadHarnessPolicy(this.stateDir, domain, cx, true, true);
    cx.notify();
  }

  saveHarnessPolicy(domain: string | undefined, cx: Context) {
    if (domain !== this.target() || this.harnessPolicyBusy) return;
    const view = this.policyViewFor(domain);
    const draft = this.policyDraftFor(domain);
    if (view === undefined || draft === undefined || draft.revision !== view.revision) return;
    const original = domain === undefined ? view.global.policy : view.domain?.effective;
    const explicitOverride = domain !== undefined && view.domain?.mode === "inherit";
    if (
      original === undefined ||
      (!explicitOverride && sameHarnessSelection(draft.selection, original))
    )
      return;
    const command = harnessPolicySetCommand(home(), domain, draft.selection, draft.revision);
    this.runHarnessPolicyMutation(domain, command, cx);
  }

  resetHarnessPolicy(domain: string | undefined, cx: Context) {
    if (domain === undefined || domain !== this.target() || this.harnessPolicyBusy) return;
    const view = this.policyViewFor(domain);
    if (view?.domain?.mode !== "replace") return;
    const command = harnessPolicyResetCommand(home(), domain, view.revision);
    this.runHarnessPolicyMutation(domain, command, cx);
  }

  runHarnessPolicyMutation(
    domain: string | undefined,
    command: { command: string; args: string[] },
    cx: Context,
  ) {
    const stateDir = this.stateDir;
    if (stateDir === undefined) return;
    const scope = domain ?? "";
    const current = () =>
      this.target() === domain && this.policyScope === scope && this.policyStateDir === stateDir;
    this.harnessPolicyBusy = true;
    this.policyFailure = undefined;
    cx.notify();
    cx.spawn(async (task) => {
      let failure: string | undefined;
      let stale = false;
      try {
        const ran = await exec(command.command, command.args);
        if (ran.code !== 0) {
          failure = harnessPolicyFailure(ran);
          stale = /stale harness policy revision/i.test(`${ran.stderr}\n${ran.stdout}`);
        }
      } catch (error) {
        failure = `could not run coordinate: ${String(error)}`;
      }
      if (!current()) return;
      if (failure === undefined) {
        this.harnessPolicyDraft = undefined;
        this.policyFailure = undefined;
        this.harnessPolicyState = await this.readHarnessPolicy(domain);
      } else {
        this.policyFailure = { domain, message: failure };
        if (stale) this.harnessPolicyState = await this.readHarnessPolicy(domain);
      }
      if (!current()) return;
      this.harnessPolicyBusy = false;
      task.notify();
    });
  }

  harnessPolicyModel(domain: string | undefined): HarnessPolicyEditorModel {
    const inScope = this.policyScope === (domain ?? "") && this.policyStateDir === this.stateDir;
    const state = inScope ? this.harnessPolicyState : { kind: "loading" as const };
    const draft = this.policyDraftFor(domain);
    const failure =
      this.policyFailure !== undefined && this.policyFailure.domain === domain
        ? this.policyFailure.message
        : undefined;
    const conflict =
      (state.kind === "loaded" && draft !== undefined && draft.revision !== state.view.revision) ||
      (draft !== undefined &&
        failure?.startsWith("Policy changed while you were editing") === true);
    return {
      scope: domain === undefined ? "global" : "domain",
      domain,
      state,
      draft,
      busy: inScope && this.harnessPolicyBusy,
      failure,
      conflict,
      beginOverride: (cx) => this.beginHarnessPolicyOverride(domain, cx),
      toggle: (harness, cx) => this.toggleHarnessPolicy(domain, harness, cx),
      setDefault: (harness, cx) => this.setHarnessPolicyDefault(domain, harness, cx),
      save: (cx) => this.saveHarnessPolicy(domain, cx),
      reset: (cx) => this.resetHarnessPolicy(domain, cx),
      cancel: (cx) => this.cancelHarnessPolicyDraft(domain, cx),
      reload: (cx) => this.reloadHarnessPolicy(domain, cx),
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
    if (this.policyDialog !== undefined)
      return harnessPolicyDialog(
        theme() as Theme,
        this.harnessPolicyModel(this.policyDialog.domain),
      );
    const domain = this.target();
    const doc = domain === this.domain ? this.doc : cachedDocument(this.docs, domain);
    const detail = this.detail(domain, doc);
    const finding = this.findingDetail(domain, doc);
    const origin =
      finding?.from === null || finding === undefined || doc.kind !== "loaded"
        ? undefined
        : doc.backlog.items.find((item) => item.id === finding.from);
    const flow = this.answerFlowModel();
    const trail =
      flow === undefined
        ? trailOf(this.screen(domain, detail, finding, this.page))
        : (() => {
            const flowTrail = trailOf({
              kind: "item",
              domain: flow.domain,
              id:
                flow.cards[flow.currentIndex]?.item?.id ??
                flow.cards[flow.currentIndex]?.id ??
                "answer-flow",
            });
            const questionCrumb = flowTrail[flowTrail.length - 1]!;
            return [
              ...flowTrail.slice(0, -1),
              { ...questionCrumb, id: "crumb-answer-flow", label: "Questions", to: undefined },
            ];
          })();
    return panel(theme() as Theme, {
      domain,
      doc,
      listing: this.listing,
      trail,
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
      openWaiting: (item, cx) => this.openWaiting(item, cx),
      answer: this.answerModel(),
      flow,
      boundary: this.boundaryModel(domain),
      openHarnessPolicy: () => this.openHarnessPolicyDialog(domain),
    });
  }
}
