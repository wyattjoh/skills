// coordinate-panel: one coordinate domain's backlog, following the focused terminal. Backlog
// answers and delegate-harness policy edits go through the coordinate CLI.
import { View } from "gpui-kit";
import { InputState } from "gpui-base";
import { PANEL } from "@wyattjoh/herdr-ui";
import { createAnswerInput } from "./textarea.ts";
import type { AsyncContext, Context, Element, FocusHandle } from "gpui-kit";
import {
  checking,
  exec,
  focused,
  home,
  props,
  readTextFile,
  terminals,
  theme,
  watchFolder,
} from "herdr";
import { closeOverlay, openOverlay } from "./overlay.ts";
import type { FolderWatch } from "herdr";
import {
  FOLDED_BY_DEFAULT,
  LIST_SCRIPT,
  answerCommand,
  answerFailure,
  canDismissItem,
  dismissCommand,
  dismissFindingCommand,
  promoteFindingCommand,
  canTriageFinding,
  statusCommand,
  statusTargets,
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
  harnessPolicyDraftDirty,
  harnessPolicySaveCommand,
  harnessPolicyShowCommand,
  changedHarnessPolicy,
  joinDelegates,
  mergeEnded,
  missingSessions,
  openFindings,
  outboxOutput,
  outboxShowCommand,
  parseListing,
  promotedItemId,
  queueOutput,
  queueShowCommand,
  wikiListCommand,
  wikiListOutput,
  wikiShowCommand,
  wikiShowOutput,
  policyDialogProps,
  policyDialogSpec,
  readDocument,
  seedHarnessPolicyDraft,
  overridingDomains,
  domainOverrides,
  rebaseHarnessPolicyDraft,
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
  HarnessPolicyState,
  HarnessSelection,
  HarnessPolicyDraft,
  HarnessPolicyDraftEntry,
  ItemGroup,
  ListingState,
  OutboxEvent,
  PolicyDialogProps,
  QueuedEntry,
  Screen,
  WikiPage,
} from "./model.ts";
import {
  advanceAnswerFlow,
  dropClearedQuestions,
  queueAnswer,
  staleQueuedAnswers,
  startAnswerFlow,
  stepAnswerFlow,
} from "./answer-flow.ts";
import type { AnswerFlow, FlowAskState, QueuedAnswer } from "./answer-flow.ts";
import { ANSWER_CAROUSEL, ANSWER_FLOW_SPEED_OPTIONS } from "./look.ts";
import { backlogsDir, documentPath } from "../../lib/store.ts";
import type { Finding, Item, ItemStatus } from "../../lib/store.ts";
import { harnessPolicyDialog } from "./policy-dialog.ts";
import type { HarnessPolicyEditorModel } from "./policy-dialog.ts";
import { panel } from "./view.ts";
import type {
  AnswerFlowModel,
  AnswerFlowMotion,
  AnswerModel,
  BoundaryList,
  BoundaryModel,
  FindingActionsModel,
  StatusChangeModel,
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
  policyDialogFocus: FocusHandle | undefined;
  policyScope: string | null = null;
  policyStateDir: string | undefined;
  policyGeneration = 0;
  harnessPolicyState: HarnessPolicyState = { kind: "loading" };
  // The domains the dialog's picker lists, which of them have their own saved override, and
  // whether that menu is open.
  policyDomains: string[] = [];
  policyOverrides: string[] = [];
  // Those domains' saved overrides, for the global scope's notes on what each keeps enabled.
  policyOverrideSelections: [string, HarnessSelection][] = [];
  policyOverridesGeneration = 0;
  policyDomainMenuOpen = false;
  // The edit in progress, and the way out it is waiting on a Discard confirm for.
  // Keyed by scope ("" for global): switching scope keeps each one.
  harnessPolicyDrafts = new Map<string, HarnessPolicyDraftEntry>();
  // Whether the Discard changes? confirm is up, for a close with unsaved changes in any scope.
  policyConfirm = false;
  harnessPolicyBusy = false;
  policyFailure: { domain: string | undefined; message: string } | undefined;
  // The item or finding whose detail is open, by domain and id, so a reload shows its latest
  // copy and a vanished record falls back to the lists.
  // A wiki page's id is its name.
  selected: { kind: "item" | "finding" | "wiki-page"; domain: string; id: string } | undefined;
  // A domain page remains mounted beneath a finding detail so its scroll position is retained.
  page: DomainPage | undefined;
  // The state folder the last load found, the ended records read for the delegate refs that had
  // no live terminal then, and which sessions those were, so a delegate that loses its terminal
  // between document changes is looked up again.
  stateDir: string | undefined;
  // Each domain's capacity queue and undelivered watcher events, read through the CLI after each
  // backlog load. A failed or invalid read leaves the domain with none.
  queues = new Map<string, QueuedEntry[]>();
  outboxes = new Map<string, OutboxEvent[]>();
  // Each domain's wiki pages, read with the queue and outbox, and the body of each page opened,
  // keyed by domain and name, read when it opens; a failed read leaves no body.
  wikis = new Map<string, WikiPage[]>();
  wikiBodies = new Map<string, string>();
  watchDataGeneration = 0;
  wikiBodyGeneration = 0;
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
  answerFlowSpeedMenuOpen = false;
  answerFlowSpeedActiveIndex = 0;
  answerFlowSpeedTriggerFocus!: FocusHandle;
  answerFlowSpeedMenuFocus!: FocusHandle;
  answerFlowMotion: AnswerFlowTransition | undefined;
  answerFlowMotionGeneration = 0;
  answerFlowCardSizes = new Map<string, FlowCardSize>();
  // Sizes a card reported while a motion ran. Layout holds still during the motion, so these wait
  // here: a size callback fires only when the size changes, so a dropped report is never repeated.
  answerFlowDeferredSizes = new Map<string, FlowCardSize>();
  answerFlowViewport: { domain: string; width: number; height: number } | undefined;
  // Answers queued in the flow, per domain, until Send all and back records them. They outlive the
  // flow, so leaving the questions page and coming back finds them again. While a send runs, the
  // domain it sends for, and the message of the send that last failed.
  answerQueues = new Map<string, QueuedAnswer[]>();
  answerSending: string | undefined;
  answerSendError: { domain: string; message: string } | undefined;
  boundaryInput: InputState | undefined;
  boundaryEditing: { domain: string; list: BoundaryList } | undefined;
  boundaryBusy = false;
  boundaryHovered: string | undefined;
  boundaryError: BoundaryModel["error"];
  // The finding Approve or Dismiss last ran on: which one is still running, or the CLI's refusal.
  findingAction:
    | {
        domain: string;
        id: string;
        running: "approve" | "dismiss" | undefined;
        error: string | undefined;
      }
    | undefined;

  // The item whose Change status was last used: its menu is open, a status is being set, or the
  // CLI refused one.
  statusChange:
    | {
        domain: string;
        id: string;
        open: boolean;
        running: ItemStatus | undefined;
        error: string | undefined;
      }
    | undefined;

  init(_props: unknown, cx: AsyncContext) {
    // Herdr delivers an overlay's props through props(), not init's argument: the object the
    // opener passed, plus the overlay's own id.
    this.policyDialog = policyDialogProps(props());
    if (this.policyDialog !== undefined) {
      this.policyDialogFocus = cx.focus_handle();
      if (checking()) return;
      this.policyDialogFocus.focus();
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
    if (this.stateDir === undefined) return;
    this.loadHarnessPolicy(this.stateDir, this.target(), cx, true);
    this.loadPolicyDomains(this.stateDir, cx);
  }

  // The dialog copy reads only the state folder, the domain names for its picker, the policy the
  // CLI reports for its scope, and each listed domain's scoped policy for the override tags.
  loadPolicyDialog(cx: Context) {
    cx.spawn(async (task) => {
      const stateDir = stateDirOf(await this.read(configPath(home())), home());
      this.stateDir = stateDir;
      this.watchHarnessPolicy(stateDir, task);
      this.loadHarnessPolicy(stateDir, this.target(), task);
      this.loadPolicyDomains(stateDir, task);
    });
  }

  loadPolicyDomains(stateDir: string, cx: Context) {
    cx.spawn(async (task) => {
      try {
        const listed = await exec("sh", [
          "-c",
          LIST_SCRIPT,
          "coordinate-panel",
          backlogsDir(stateDir),
        ]);
        this.policyDomains = listed.code === 0 ? parseListing(listed.stdout) : [];
      } catch {
        this.policyDomains = [];
      }
      task.notify();
      this.loadPolicyOverrides(task);
    });
  }

  // Which listed domains have their own override, for the scope menu's badges. The global view
  // lists none, so this is one scoped CLI read per domain; a failed read shows no badge.
  loadPolicyOverrides(cx: Context) {
    const domains = this.policyDomains;
    const generation = ++this.policyOverridesGeneration;
    cx.spawn(async (task) => {
      const reads = await Promise.all(
        domains.map(async (domain) => [domain, await this.readHarnessPolicy(domain)] as const),
      );
      if (generation !== this.policyOverridesGeneration) return;
      this.policyOverrideSelections = domainOverrides(reads);
      this.policyOverrides = overridingDomains(reads);
      task.notify();
    });
  }

  // Open the editor as Herdr's centered dialog: a fresh copy of this mod, so it starts from the
  // policy on disk.
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
    if (screen.kind === "wiki-page") {
      this.selected = { kind: "wiki-page", domain: screen.domain, id: screen.name };
      this.page = { kind: "wiki", domain: screen.domain };
      this.clearDraft();
      this.loadWikiBody(screen.domain, screen.name, cx);
      cx.notify();
      return;
    }
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
        this.queues.clear();
        this.outboxes.clear();
        this.wikis.clear();
        this.wikiBodies.clear();
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
      this.pruneAnswerQueue(domain, read.document);
      this.reconcileAnswerFlow(domain, read.document);
      task.notify();
      if (read.document.kind !== "loaded") return;
      this.lookUpEnded(stateDir, missingSessions(read.document.backlog, terminals()), task);
      this.loadWatchData(stateDir, domain, task);
    });
  }

  // Read the domain's capacity queue, watcher outbox and wiki pages through the CLI, side by
  // side. A newer load, a moved state folder or another domain on screen drops the result.
  loadWatchData(stateDir: string, domain: string, cx: Context) {
    const generation = ++this.watchDataGeneration;
    cx.spawn(async (task) => {
      const [queue, outbox, wiki] = await Promise.all([
        this.readCli(queueShowCommand(home(), domain), (text) => queueOutput(text, domain)),
        this.readCli(outboxShowCommand(home(), domain), (text) => outboxOutput(text, domain)),
        this.readCli(wikiListCommand(home(), domain), (text) => wikiListOutput(text, domain)),
      ]);
      if (generation !== this.watchDataGeneration || this.stateDir !== stateDir) return;
      this.queues.set(domain, queue);
      this.outboxes.set(domain, outbox);
      this.wikis.set(domain, wiki);
      if (this.target() === domain) task.notify();
    });
  }

  // Read an opened wiki page's body through the CLI. Only the latest open's read lands, and a
  // failed or invalid read leaves the page with no body.
  loadWikiBody(domain: string, name: string, cx: Context) {
    const generation = ++this.wikiBodyGeneration;
    const stateDir = this.stateDir;
    const key = `${domain}\0${name}`;
    cx.spawn(async (task) => {
      const [body] = await this.readCli(wikiShowCommand(home(), domain, name), (text) => {
        const read = wikiShowOutput(text, domain, name);
        return read === undefined ? undefined : [read];
      });
      if (generation !== this.wikiBodyGeneration || this.stateDir !== stateDir) return;
      if (body === undefined) this.wikiBodies.delete(key);
      else this.wikiBodies.set(key, body);
      task.notify();
    });
  }

  // One read-only CLI call whose JSON lists records; any failure reads as an empty list.
  async readCli<T>(
    { command, args }: { command: string; args: string[] },
    parse: (text: string) => T[] | undefined,
  ): Promise<T[]> {
    try {
      const ran = await exec(command, args);
      return ran.code === 0 ? (parse(ran.stdout) ?? []) : [];
    } catch {
      return [];
    }
  }

  // Repair the flow against the live document: a question answered outside the flow is dropped,
  // wherever it sits, and a current question whose item vanished is skipped. Waits while a motion
  // runs or the flow's own answer is in flight; the motion's end reconciles again.
  reconcileAnswerFlow(domain: string, document: DocumentState, keep?: string) {
    const flow = this.answerFlow;
    if (
      this.answerFlowMotion !== undefined ||
      this.draft?.busy === true ||
      flow === undefined ||
      flow.domain !== domain ||
      document.kind !== "loaded"
    )
      return;
    const items = new Map(document.backlog.items.map((item) => [item.id, item] as const));
    const stateOf = (id: string): FlowAskState => {
      const item = items.get(id);
      return item === undefined ? "missing" : item.ask === null ? "cleared" : "open";
    };
    const { flow: repaired, dropped } = dropClearedQuestions(flow, stateOf, keep);
    let next = repaired;
    const currentId = next.ids[next.current];
    if (
      currentId !== undefined &&
      !next.answered.includes(currentId) &&
      stateOf(currentId) === "missing"
    )
      next = advanceAnswerFlow(next, "skipped");
    if (next === flow) return;
    this.answerFlow = next;
    for (const id of dropped) this.forgetAnswerFlowCard(domain, id);
    const id = next.ids[next.current];
    if (id !== undefined) this.selected = { kind: "item", domain, id };
  }

  queueFor(domain: string | undefined): QueuedAnswer[] {
    return domain === undefined ? [] : (this.answerQueues.get(domain) ?? []);
  }

  setQueue(domain: string, queue: QueuedAnswer[]) {
    if (queue.length === 0) this.answerQueues.delete(domain);
    else this.answerQueues.set(domain, queue);
  }

  // Unqueue answers and stop counting their questions as answered in the flow, the running motion's
  // target included, so the next reconcile treats them like any other question.
  forgetQueued(domain: string, ids: readonly string[]) {
    this.setQueue(
      domain,
      this.queueFor(domain).filter((entry) => !ids.includes(entry.id)),
    );
    const strip = (flow: AnswerFlow | undefined) =>
      flow === undefined || flow.domain !== domain
        ? flow
        : { ...flow, answered: flow.answered.filter((id) => !ids.includes(id)) };
    this.answerFlow = strip(this.answerFlow);
    const motion = this.answerFlowMotion;
    if (motion !== undefined)
      this.answerFlowMotion = { ...motion, targetFlow: strip(motion.targetFlow) };
  }

  // Drop queued answers whose question is gone (answered elsewhere, closed, or asked again), since
  // the CLI would refuse them. Waits while that domain's queue is being sent.
  pruneAnswerQueue(domain: string, document: DocumentState) {
    const queue = this.queueFor(domain);
    if (this.answerSending === domain || document.kind !== "loaded" || queue.length === 0) return;
    const items = new Map(document.backlog.items.map((item) => [item.id, item] as const));
    const stale = staleQueuedAnswers(queue, (id) => {
      const item = items.get(id);
      return item === undefined || item.ask === null ? undefined : draftKey(domain, item, item.ask);
    });
    if (stale.length > 0) this.forgetQueued(domain, stale);
  }

  // Start the shown question's draft clean, or from its queued answer so it can be changed.
  restoreQueuedDraft() {
    this.clearDraft();
    const open = this.answering();
    const queued = this.queueFor(this.target()).find((entry) => entry.key === open?.draft.key);
    if (open === undefined || queued === undefined) return;
    this.draft = { ...open.draft, ...queued.draft };
    this.input?.set_value(queued.draft.text);
    this.noteInput?.set_value(queued.draft.note);
  }

  // Release what a dropped question held: its measured sizes and any size reported mid-motion.
  forgetAnswerFlowCard(domain: string, id: string) {
    const key = this.flowCardSizeKey(domain, id);
    this.answerFlowCardSizes.delete(key);
    this.answerFlowDeferredSizes.delete(key);
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
          if (changedHarnessPolicy(changed, stateDir)) {
            this.loadHarnessPolicy(stateDir, this.target(), task, true);
            this.loadPolicyOverrides(task);
          }
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
      this.rebasePolicyDraft(domain);
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
    this.answerFlow = startAnswerFlow(
      domain,
      ids,
      item.id,
      this.queueFor(domain).map((entry) => entry.id),
    );
    this.selected = { kind: "item", domain, id: item.id };
    this.page = undefined;
    this.restoreQueuedDraft();
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
    this.answerFlowViewport = { domain, ...size };
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

  setAnswerFlowSpeedMenuOpen(open: boolean, cx: Context) {
    if (this.answerFlow === undefined || this.answerFlowSpeedMenuOpen === open) return;
    this.answerFlowSpeedMenuOpen = open;
    if (open) {
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
      const id = next.ids[next.current];
      this.selected = id === undefined ? undefined : { kind: "item", domain: next.domain, id };
      this.restoreQueuedDraft();
      this.answerFlowMotion = undefined;
      this.applyDeferredAnswerFlowSizes();
      this.reconcileAnswerFlow(next.domain, this.doc);
      tick.notify();
    });
  }

  // The document the flow's questions are read from.
  flowDocument(domain: string): DocumentState {
    return domain === this.domain ? this.doc : cachedDocument(this.docs, domain);
  }

  transitionAnswerFlow(action: AnswerFlowTransitionAction, cx: Context) {
    let flow = this.answerFlow;
    if (
      flow === undefined ||
      this.answerFlowMotion !== undefined ||
      this.answerSending !== undefined ||
      this.draft?.busy === true
    )
      return;
    // Repair the flow before choosing a target, so a question answered elsewhere is never the
    // card the motion lands on. The question being answered here is not one of those.
    const startedAt = flow.ids[flow.current];
    this.reconcileAnswerFlow(
      flow.domain,
      this.flowDocument(flow.domain),
      action === "answered" ? startedAt : undefined,
    );
    flow = this.answerFlow ?? flow;
    if (action !== "answered" && flow.ids[flow.current] !== startedAt) {
      cx.notify();
      return;
    }
    if (!this.answerFlowReady(flow.domain, flow.ids)) return;
    let nextAction = action;
    let targetFlow: AnswerFlow | undefined;
    // Moving on from a question with a queued answer leaves it queued rather than skipping it.
    const queued = this.queueFor(flow.domain).some((entry) => entry.id === flow.ids[flow.current]);
    if (action === "skipped" && queued) targetFlow = stepAnswerFlow(flow);
    else if (action === "answered" || action === "skipped")
      targetFlow = advanceAnswerFlow(flow, action);
    else if (action === "back") {
      if (flow.current <= 0) nextAction = "exit";
      else targetFlow = { ...flow, current: flow.current - 1 };
    }
    if (nextAction !== "exit" && (targetFlow === undefined || targetFlow === flow)) return;
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
    this.closeAnswerFlow(cx);
  }

  // Leave the flow for its domain's page, with the exit motion when the carousel can run one.
  leaveAnswerFlow(cx: Context) {
    this.transitionAnswerFlow("exit", cx);
    if (this.answerFlowMotion === undefined) this.closeAnswerFlow(cx);
  }

  closeAnswerFlow(cx: Context) {
    const domain = this.answerFlow?.domain;
    this.answerFlowMotion = undefined;
    this.answerFlowDeferredSizes.clear();
    this.answerFlow = undefined;
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
    // In the flow, Answer queues the answer and moves on; Send all and back records the queue.
    const domain = this.domain;
    if (this.answerFlow?.domain === domain) {
      if (this.answerSending !== undefined) return;
      const { choice, discuss, text, note: draftNote } = open.draft;
      this.setQueue(
        domain,
        queueAnswer(this.queueFor(domain), {
          id: open.item.id,
          key,
          answer,
          note,
          draft: { choice, discuss, text, note: draftNote },
        }),
      );
      this.transitionAnswerFlow("answered", cx);
      cx.notify();
      return;
    }
    const { command, args } = answerCommand(home(), domain, open.item.id, answer, note);
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
        this.load(task, true);
      } else this.draft = { ...this.draft, busy: false, error };
      task.notify();
    });
  }

  // Dismiss the open question's item from the answer flow: the CLI closes it as dismissed, and the
  // flow then drops its card like one answered elsewhere. A refusal shows inline and stays.
  dismissAnswerFlowItem(cx: Context) {
    const open = this.answering();
    if (
      this.answerFlow === undefined ||
      this.answerFlowMotion !== undefined ||
      this.answerSending !== undefined ||
      open === undefined ||
      open.draft.busy ||
      this.domain === undefined ||
      !canDismissItem(open.item)
    )
      return;
    const { key } = open.draft;
    const domain = this.domain;
    const { command, args } = dismissCommand(home(), this.domain, open.item.id);
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
        this.forgetQueued(domain, [open.item.id]);
        this.clearDraft();
        this.load(task, true);
      } else this.draft = { ...this.draft, busy: false, error };
      task.notify();
    });
  }

  // Record every queued answer for the flow's domain with the coordinate CLI, one at a time in queue
  // order. Each recorded answer leaves the queue; the first failure stops the send, keeps it and the
  // rest queued, and shows the CLI's message. When all are recorded the flow returns to the domain.
  sendAnswerQueue(cx: Context) {
    const flow = this.answerFlow;
    if (
      flow === undefined ||
      this.answerSending !== undefined ||
      this.answerFlowMotion !== undefined ||
      this.draft?.busy === true
    )
      return;
    const { domain } = flow;
    const entries = this.queueFor(domain);
    if (entries.length === 0) return;
    this.answerSending = domain;
    this.answerSendError = undefined;
    cx.notify();
    cx.spawn(async (task) => {
      let error: string | undefined;
      for (const entry of entries) {
        const { command, args } = answerCommand(home(), domain, entry.id, entry.answer, entry.note);
        try {
          const ran = await exec(command, args);
          if (ran.code !== 0) error = answerFailure(ran);
        } catch (failure) {
          error = `could not run coordinate: ${String(failure)}`;
        }
        if (error !== undefined) break;
        this.setQueue(
          domain,
          this.queueFor(domain).filter((queued) => queued !== entry),
        );
      }
      this.answerSending = undefined;
      if (error !== undefined) this.answerSendError = { domain, message: error };
      else if (this.answerFlow?.domain === domain && this.target() === domain)
        this.leaveAnswerFlow(task);
      this.load(task, true);
      task.notify();
    });
  }

  // The answer row's model for the view, when the open item has an ask.
  answerModel(): AnswerModel | undefined {
    const open = this.answering();
    if (open === undefined) return undefined;
    const inFlow = this.answerFlow !== undefined && this.answerFlow.domain === this.domain;
    return {
      draft: open.draft,
      input: this.input,
      typing: this.typing,
      noteInput: this.noteInput,
      noteTyping: this.noteTyping,
      choose: (option, cx) => this.choose(option, cx),
      discuss: (cx) => this.discuss(cx),
      submit: (cx) => this.answer(cx),
      skip: inFlow ? (cx) => this.skipAnswerFlow(cx) : undefined,
      dismiss:
        inFlow && canDismissItem(open.item) ? (cx) => this.dismissAnswerFlowItem(cx) : undefined,
    };
  }

  answerFlowModel(): AnswerFlowModel | undefined {
    const flow = this.answerFlow;
    if (flow === undefined || flow.domain !== this.target()) return undefined;
    const doc = this.flowDocument(flow.domain);
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
    const queue = this.queueFor(flow.domain);
    return {
      domain: flow.domain,
      cards,
      currentIndex: flow.current,
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
      position: Math.min(flow.current + 1, flow.ids.length),
      total: flow.ids.length,
      done: flow.current >= flow.ids.length,
      answeredCount: counts.answered.filter((id) => !queue.some((entry) => entry.id === id)).length,
      skippedCount: counts.skipped.length,
      queuedCount: queue.length,
      sending: this.answerSending === flow.domain,
      sendError:
        this.answerSendError?.domain === flow.domain ? this.answerSendError.message : undefined,
      send: (cx) => this.sendAnswerQueue(cx),
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

  // Approve or Dismiss a finding with the coordinate CLI: promote makes it an item, dismiss closes
  // it as dismissed. A reload then shows it closed; a refusal shows inline and leaves it open.
  runFindingAction(action: "approve" | "dismiss", domain: string, finding: Finding, cx: Context) {
    if (this.findingAction?.running !== undefined || !canTriageFinding(finding)) return;
    const build = action === "approve" ? promoteFindingCommand : dismissFindingCommand;
    const { command, args } = build(home(), domain, finding.id);
    const running = { domain, id: finding.id, running: action, error: undefined };
    this.findingAction = running;
    cx.notify();
    cx.spawn(async (task) => {
      let error: string | undefined;
      try {
        const ran = await exec(command, args);
        if (ran.code !== 0) error = answerFailure(ran);
      } catch (failure) {
        error = `could not run coordinate: ${String(failure)}`;
      }
      if (this.findingAction !== running) return;
      this.findingAction =
        error === undefined ? undefined : { domain, id: finding.id, running: undefined, error };
      if (error === undefined) this.load(task, true);
      task.notify();
    });
  }

  findingActionsModel(
    domain: string | undefined,
    finding: Finding | undefined,
  ): FindingActionsModel | undefined {
    if (domain === undefined || finding === undefined || !canTriageFinding(finding))
      return undefined;
    const state =
      this.findingAction?.domain === domain && this.findingAction.id === finding.id
        ? this.findingAction
        : undefined;
    return {
      running: state?.running,
      busy: this.findingAction?.running !== undefined,
      error: state?.error,
      approve: (cx) => this.runFindingAction("approve", domain, finding, cx),
      dismiss: (cx) => this.runFindingAction("dismiss", domain, finding, cx),
    };
  }

  // Open or close an item's Change status menu. Another item's menu or refusal is dropped.
  toggleStatusMenu(domain: string, item: Item, cx: Context) {
    if (this.statusChange?.running !== undefined) return;
    const state =
      this.statusChange?.domain === domain && this.statusChange.id === item.id
        ? this.statusChange
        : undefined;
    this.statusChange = {
      domain,
      id: item.id,
      open: !(state?.open ?? false),
      running: undefined,
      error: state?.error,
    };
    cx.notify();
  }

  // Set an item's status with the coordinate CLI, as a finding's actions do: a reload after exit 0
  // shows the new status, and a refusal shows inline and leaves the item as it was.
  changeStatus(domain: string, item: Item, status: ItemStatus, cx: Context) {
    if (this.statusChange?.running !== undefined || !statusTargets(item).includes(status)) return;
    const { command, args } = statusCommand(home(), domain, item.id, status);
    const running = { domain, id: item.id, open: false, running: status, error: undefined };
    this.statusChange = running;
    cx.notify();
    cx.spawn(async (task) => {
      let error: string | undefined;
      try {
        const ran = await exec(command, args);
        if (ran.code !== 0) error = answerFailure(ran);
      } catch (failure) {
        error = `could not run coordinate: ${String(failure)}`;
      }
      if (this.statusChange !== running) return;
      this.statusChange =
        error === undefined
          ? undefined
          : { domain, id: item.id, open: false, running: undefined, error };
      if (error === undefined) this.load(task, true);
      task.notify();
    });
  }

  statusChangeModel(
    domain: string | undefined,
    item: Item | undefined,
  ): StatusChangeModel | undefined {
    if (domain === undefined || item === undefined) return undefined;
    const targets = statusTargets(item);
    if (targets.length === 0) return undefined;
    const state =
      this.statusChange?.domain === domain && this.statusChange.id === item.id
        ? this.statusChange
        : undefined;
    return {
      targets,
      open: state?.open ?? false,
      running: state?.running,
      busy: this.statusChange?.running !== undefined,
      error: state?.error,
      toggle: (cx) => this.toggleStatusMenu(domain, item, cx),
      change: (status, cx) => this.changeStatus(domain, item, status, cx),
    };
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

  // The shown scope's draft, for the tests and callers that only care about what is on screen.
  get harnessPolicyDraft(): HarnessPolicyDraft | undefined {
    return this.harnessPolicyDrafts.get(this.target() ?? "")?.draft;
  }

  // After a read of a scope, carry its draft onto the new revision when another scope's write
  // moved it; a change to this scope's own policy leaves the draft stale.
  rebasePolicyDraft(domain: string | undefined) {
    const entry = this.harnessPolicyDrafts.get(domain ?? "");
    const view = this.policyViewFor(domain);
    if (entry === undefined || view === undefined) return;
    this.harnessPolicyDrafts.set(domain ?? "", rebaseHarnessPolicyDraft(entry, view));
  }

  // The edit in progress for a scope: the stored draft, or one seeded from the policy as read.
  // Nothing is stored until a control changes it.
  currentPolicyDraft(domain: string | undefined): HarnessPolicyDraft | undefined {
    const stored = this.harnessPolicyDrafts.get(domain ?? "");
    if (stored !== undefined) return stored.draft;
    const view = this.policyViewFor(domain);
    return view === undefined ? undefined : seedHarnessPolicyDraft(view, domain);
  }

  // Whether the draft for a scope differs from the policy it was made against.
  policyDirty(domain: string | undefined): boolean {
    const entry = this.harnessPolicyDrafts.get(domain ?? "");
    return entry !== undefined && harnessPolicyDraftDirty(entry.base, entry.draft);
  }

  // Whether any scope, shown or not, has unsaved changes.
  anyPolicyDirty(): boolean {
    return [...this.harnessPolicyDrafts.values()].some((entry) =>
      harnessPolicyDraftDirty(entry.base, entry.draft),
    );
  }

  // The policy changed on disk since the draft was seeded.
  policyConflict(domain: string | undefined): boolean {
    const view = this.policyViewFor(domain);
    const entry = this.harnessPolicyDrafts.get(domain ?? "");
    return view !== undefined && entry !== undefined && entry.draft.revision !== view.revision;
  }

  // A control may change the draft when the scope is loaded, nothing is being saved, the draft
  // is not stale, and a domain is not inheriting.
  editablePolicyDraft(domain: string | undefined): HarnessPolicyDraft | undefined {
    if (domain !== this.target() || this.harnessPolicyBusy || this.policyConflict(domain))
      return undefined;
    return this.currentPolicyDraft(domain);
  }

  // A draft that is back to what is on disk is no draft at all, so a later change on disk is not
  // reported as a conflict with edits that are no longer there.
  storePolicyDraft(draft: HarnessPolicyDraft, cx: Context) {
    const view = this.policyViewFor(draft.domain);
    const key = draft.domain ?? "";
    if (view === undefined || !harnessPolicyDraftDirty(view, draft))
      this.harnessPolicyDrafts.delete(key);
    else this.harnessPolicyDrafts.set(key, { base: view, draft });
    this.policyFailure = undefined;
    cx.notify();
  }

  toggleHarnessPolicy(domain: string | undefined, harness: DelegateHarness, cx: Context) {
    const draft = this.editablePolicyDraft(domain);
    if (draft === undefined || draft.inherit) return;
    const enabled = new Set(draft.selection.enabled);
    if (enabled.has(harness)) enabled.delete(harness);
    else enabled.add(harness);
    this.storePolicyDraft(
      {
        ...draft,
        selection: {
          enabled: (["pi", "claude"] as const).filter((entry) => enabled.has(entry)),
          default:
            draft.selection.default === harness && !enabled.has(harness)
              ? null
              : draft.selection.default,
        },
      },
      cx,
    );
  }

  setHarnessPolicyDefault(
    domain: string | undefined,
    defaultHarness: DelegateHarness | null,
    cx: Context,
  ) {
    const draft = this.editablePolicyDraft(domain);
    if (
      draft === undefined ||
      draft.inherit ||
      defaultHarness === draft.selection.default ||
      (defaultHarness !== null && !draft.selection.enabled.includes(defaultHarness))
    )
      return;
    this.storePolicyDraft(
      { ...draft, selection: { enabled: [...draft.selection.enabled], default: defaultHarness } },
      cx,
    );
  }

  // The Inherit global switch is part of the draft: off keeps the effective policy as the
  // starting point for an override, on discards the override at save.
  setHarnessPolicyInherit(domain: string | undefined, inherit: boolean, cx: Context) {
    const draft = this.editablePolicyDraft(domain);
    if (domain === undefined || draft === undefined || draft.inherit === inherit) return;
    this.storePolicyDraft({ ...draft, inherit }, cx);
  }

  // Write the draft through the CLI with the revision it was read at.
  saveHarnessPolicy(domain: string | undefined, cx: Context) {
    if (domain !== this.target() || this.harnessPolicyBusy || this.policyConflict(domain)) return;
    const view = this.policyViewFor(domain);
    const draft = this.harnessPolicyDrafts.get(domain ?? "")?.draft;
    if (view === undefined || draft === undefined) return;
    const command = harnessPolicySaveCommand(home(), view, draft);
    if (command !== undefined) this.runHarnessPolicyMutation(domain, command, cx);
  }

  // Throw away the draft and read the policy again, as the Reload button does.
  reloadHarnessPolicy(domain: string | undefined, cx: Context) {
    if (domain !== this.target() || this.harnessPolicyBusy || this.stateDir === undefined) return;
    this.harnessPolicyDrafts.delete(domain ?? "");
    this.policyFailure = undefined;
    this.loadHarnessPolicy(this.stateDir, domain, cx, true, true);
    cx.notify();
  }

  closePolicyDialog() {
    if (this.policyDialog !== undefined) closeOverlay(this.policyDialog.overlay);
  }

  // Every way out of the dialog (Cancel, Escape, a click beside the window) goes through here:
  // with unsaved changes in any scope it asks first, and otherwise it closes at once. While a
  // save is running it does nothing.
  requestPolicyClose(cx: Context) {
    if (this.policyDialog === undefined || this.harnessPolicyBusy) return;
    if (this.anyPolicyDirty()) {
      this.policyDomainMenuOpen = false;
      this.policyConfirm = true;
      cx.notify();
      return;
    }
    this.performPolicyClose();
  }

  performPolicyClose() {
    this.policyConfirm = false;
    this.harnessPolicyDrafts.clear();
    this.closePolicyDialog();
  }

  keepEditingPolicy(cx: Context) {
    if (!this.policyConfirm) return;
    this.policyConfirm = false;
    this.policyDialogFocus?.focus();
    cx.notify();
  }

  discardPolicyChanges() {
    if (!this.policyConfirm) return;
    this.performPolicyClose();
  }

  // Show another scope in the dialog: the global defaults, or one domain.
  selectPolicyDomain(domain: string | undefined, cx: Context) {
    if (this.policyDialog === undefined || this.harnessPolicyBusy) return;
    this.policyDomainMenuOpen = false;
    if (domain === this.policyDialog.domain) {
      cx.notify();
      return;
    }
    this.switchPolicyScope(domain, cx);
  }

  switchPolicyScope(domain: string | undefined, cx: Context) {
    if (this.policyDialog === undefined) return;
    this.policyFailure = undefined;
    this.policyDialog = { ...this.policyDialog, domain };
    if (this.stateDir !== undefined) this.loadHarnessPolicy(this.stateDir, domain, cx);
    this.policyDialogFocus?.focus();
    cx.notify();
  }

  setPolicyDomainMenuOpen(open: boolean, cx: Context) {
    if (this.policyDialog === undefined || this.policyDomainMenuOpen === open) return;
    this.policyDomainMenuOpen = open;
    if (!open) this.policyDialogFocus?.focus();
    cx.notify();
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
      if (failure === undefined) this.loadPolicyOverrides(task);
      if (!current()) return;
      if (failure === undefined) {
        this.harnessPolicyDrafts.delete(scope);
        this.policyFailure = undefined;
        this.harnessPolicyState = await this.readHarnessPolicy(domain);
      } else {
        this.policyFailure = { domain, message: failure };
        if (stale) {
          this.harnessPolicyState = await this.readHarnessPolicy(domain);
          this.rebasePolicyDraft(domain);
        }
      }
      if (!current()) return;
      this.harnessPolicyBusy = false;
      task.notify();
    });
  }

  harnessPolicyModel(domain: string | undefined): HarnessPolicyEditorModel {
    const inScope = this.policyScope === (domain ?? "") && this.policyStateDir === this.stateDir;
    const draft = inScope ? this.currentPolicyDraft(domain) : undefined;
    return {
      scope: domain === undefined ? "global" : "domain",
      domain,
      domains: this.policyDomains,
      overrides: this.policyOverrides,
      overrideSelections: this.policyOverrideSelections,
      domainMenuOpen: this.policyDomainMenuOpen,
      state: inScope ? this.harnessPolicyState : { kind: "loading" as const },
      busy: inScope && this.harnessPolicyBusy,
      failure:
        this.policyFailure !== undefined && this.policyFailure.domain === domain
          ? this.policyFailure.message
          : undefined,
      draft,
      dirty: inScope && this.policyDirty(domain),
      conflict: inScope && this.policyConflict(domain),
      confirming: this.policyConfirm,
      focus: this.policyDialogFocus!,
      selectGlobal: (cx) => this.selectPolicyDomain(undefined, cx),
      selectDomain: (name, cx) => this.selectPolicyDomain(name, cx),
      setDomainMenuOpen: (open, cx) => this.setPolicyDomainMenuOpen(open, cx),
      toggle: (harness, cx) => this.toggleHarnessPolicy(domain, harness, cx),
      setDefault: (harness, cx) => this.setHarnessPolicyDefault(domain, harness, cx),
      setInherit: (inherit, cx) => this.setHarnessPolicyInherit(domain, inherit, cx),
      reload: (cx) => this.reloadHarnessPolicy(domain, cx),
      save: (cx) => this.saveHarnessPolicy(domain, cx),
      cancel: (cx) => this.requestPolicyClose(cx),
      keepEditing: (cx) => this.keepEditingPolicy(cx),
      discard: () => this.discardPolicyChanges(),
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

  // The open wiki page while the domain's wiki still lists it, with its body once read.
  wikiPageDetail(
    domain: string | undefined,
  ): { page: WikiPage; body: string | undefined } | undefined {
    const selected = this.selected;
    if (selected?.kind !== "wiki-page" || selected.domain !== domain) return undefined;
    const page = this.wikis.get(selected.domain)?.find((entry) => entry.name === selected.id);
    if (page === undefined) return undefined;
    return { page, body: this.wikiBodies.get(`${selected.domain}\0${page.name}`) };
  }

  // The screen drawn: a detail only while its record is still in the document (or, for a wiki
  // page, in the domain's wiki list).
  screen(
    domain: string | undefined,
    item: Item | undefined,
    finding: Finding | undefined,
    page: DomainPage | undefined,
    wikiPage: WikiPage | undefined = undefined,
  ): Screen {
    if (domain === undefined) return { kind: "domains" };
    if (item !== undefined) return { kind: "item", domain, id: item.id };
    if (finding !== undefined) return { kind: "finding", domain, id: finding.id };
    if (wikiPage !== undefined) return { kind: "wiki-page", domain, name: wikiPage.name };
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

  queuedFor(domain: string | undefined): QueuedEntry[] {
    return domain === undefined ? [] : (this.queues.get(domain) ?? []);
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
    const wikiPage = this.wikiPageDetail(domain);
    const origin =
      finding?.from === null || finding === undefined || doc.kind !== "loaded"
        ? undefined
        : doc.backlog.items.find((item) => item.id === finding.from);
    const promotedId = finding === undefined ? undefined : promotedItemId(finding);
    const promoted =
      promotedId === undefined || doc.kind !== "loaded"
        ? undefined
        : doc.backlog.items.find((item) => item.id === promotedId);
    const flow = this.answerFlowModel();
    const trail =
      flow === undefined
        ? trailOf(this.screen(domain, detail, finding, this.page, wikiPage?.page))
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
      groups: doc.kind === "loaded" ? groupItems(doc.backlog, this.queuedFor(domain)) : [],
      queued: this.queuedFor(domain),
      outbox: domain === undefined ? [] : (this.outboxes.get(domain) ?? []),
      wiki: domain === undefined ? [] : (this.wikis.get(domain) ?? []),
      wikiPage,
      openWikiPage: (name, cx) => {
        if (domain !== undefined) this.go({ kind: "wiki-page", domain, name }, cx);
      },
      findings: doc.kind === "loaded" ? openFindings(doc.backlog) : [],
      page: this.page === undefined || this.page.domain !== domain ? undefined : this.page.kind,
      finding,
      origin,
      promoted,
      openFinding: (record, cx) => this.openFinding(record, cx),
      findingActions: this.findingActionsModel(domain, finding),
      delegates: this.delegates(domain, doc),
      openDomain: (name, cx) => this.openDomain(name, cx),
      isOpen: (group) => this.isOpen(group),
      toggle: (group, cx) => this.toggleFold(group, cx),
      visibleRows: (group, total) => this.visibleRows(domain, group, total),
      loadMore: (group, cx) => this.revealMore(domain, group, cx),
      detail,
      statusChange: this.statusChangeModel(domain, detail),
      open: (item, cx) => this.open(item, cx),
      openWaiting: (item, cx) => this.openWaiting(item, cx),
      answer: this.answerModel(),
      flow,
      boundary: this.boundaryModel(domain),
      openHarnessPolicy: () => this.openHarnessPolicyDialog(domain),
    });
  }
}
