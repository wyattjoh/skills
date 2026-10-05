import { currentAssignment, needsOutcome, ticketMachine, workerMachine } from "../fleet/model.ts";
import { createSimulation, type DemoAction } from "./simulation.ts";

type Step = {
  label: string;
  action: DemoAction;
  role: "implementor" | "reviewer";
  verdict: "approved" | "changes_requested";
  invalid: boolean;
  settings: Parameters<ReturnType<typeof createSimulation>["configure"]>[0];
};
const step = (
  label: string,
  action: DemoAction,
  options: Partial<Omit<Step, "label" | "action">> = {},
): Step => ({
  label,
  action,
  role: "implementor",
  verdict: "approved",
  invalid: false,
  settings: {},
  ...options,
});
const start = step("Start a background implementor in the existing worktree", "start");
const complete = step("Record checked implementation before yield", "complete");
const review = step("Coordinator dispatches file-bound review", "review");
const approved = step("Reviewer submits validated approval to implementor", "submit", {
  role: "reviewer",
});
const forward = step("Implementor forwards approval to coordinator", "forward");
const land = step("Caller merges, checks and verifies ancestry before cleanup", "land", {
  settings: { merged: true },
});
const scenarios: Record<string, { title: string; description: string; steps: Step[] }> = {
  approval: {
    title: "Approval and landing",
    description:
      "Approval is routed through the implementor; only verified landing retires workers.",
    steps: [start, complete, review, approved, forward, land],
  },
  fixes: {
    title: "Findings and retained re-review",
    description: "Medium findings go directly to implementation. Fixes rearm the same reviewer.",
    steps: [
      start,
      complete,
      review,
      step("Return structured blocking findings", "submit", {
        role: "reviewer",
        verdict: "changes_requested",
      }),
      step("Fix and commit a new head", "head"),
      step("Implementor requests retained re-review", "rereview"),
      approved,
      forward,
      land,
    ],
  },
  question: {
    title: "Question and rearmed guard",
    description:
      "Accounted waiting is legal; its correlated answer creates a new guarded assignment.",
    steps: [
      start,
      step("Ask the coordinator", "question"),
      step("Waiting may settle", "stop"),
      step("Coordinator answers the exact question", "answer"),
      step("New assignment still requires an outcome", "stop"),
      complete,
      review,
      approved,
      forward,
      land,
    ],
  },
  reviewer: {
    title: "Reviewer question",
    description: "A question answer updates both reviewer and ticket assignment bindings.",
    steps: [
      start,
      complete,
      review,
      step("Reviewer asks coordinator, not user", "question", { role: "reviewer" }),
      step("Answer rebinds the review", "answer", { role: "reviewer" }),
      approved,
      forward,
      land,
    ],
  },
  guard: {
    title: "Repeated unreported stops",
    description: "Repeated attempts to yield stay active; a final chat message is not an outcome.",
    steps: [
      start,
      step("Try to yield without reporting", "stop"),
      step("Try again, still guarded", "stop"),
      complete,
      review,
      step("Reviewer bare approval is rejected", "bare-approval", { role: "reviewer" }),
      approved,
      forward,
      land,
    ],
  },
  invalid: {
    title: "Invalid and stale artifacts",
    description:
      "Bad metadata never releases the gate. Head movement requires fresh implementation and review.",
    steps: [
      start,
      complete,
      review,
      step("Submit invalid Markdown", "submit", { role: "reviewer", invalid: true }),
      step("Reviewer remains guarded", "stop", { role: "reviewer" }),
      step("Move HEAD after review dispatch", "head"),
      step("Old bound report is stale", "submit", { role: "reviewer" }),
      step("Coordinator accounts for stale work and rearms implementation", "refresh"),
      complete,
      review,
      approved,
      forward,
      land,
    ],
  },
  recovery: {
    title: "Offline recipient and restart",
    description: "Actual Machine codecs restore snapshots; pending callbacks survive and replay.",
    steps: [
      step("Start while coordinator is offline", "start", { settings: { online: false } }),
      complete,
      step("Persist encoded Machine snapshots and outbox", "save"),
      step("Restart from encoded snapshots", "restore"),
      step("Coordinator reconnects and replays pending work", "recover"),
      review,
      approved,
      forward,
      land,
    ],
  },
  fault: {
    title: "Observed fault, not completion",
    description:
      "Native interruption records Lost/Blocked and a coordinator callback, never reviewer approval.",
    steps: [
      start,
      step("Observe a native control fault", "fault"),
      step("Accounted fault waiting may settle", "stop"),
      step("Coordinator explicitly recovers implementation", "refresh"),
      complete,
      review,
      approved,
      forward,
      land,
    ],
  },
  off: {
    title: "Without extension",
    description:
      "An idle terminal can hide unreported work. The semantic model deliberately remains unaccounted.",
    steps: [
      start,
      step("Turn off the stop hook and settle", "stop", { settings: { extension: false } }),
    ],
  },
};
const element = <T extends HTMLElement>(id: string, Type: { new (): T }): T => {
  const value = document.getElementById(id);
  if (!(value instanceof Type)) throw new Error(`Missing ${id}`);
  return value;
};
const scenarioSelect = element("scenario", HTMLSelectElement);
const roleSelect = element("role", HTMLSelectElement);
const report = element("report", HTMLTextAreaElement);
const filename = element("filename", HTMLInputElement);
const verdict = element("verdict", HTMLSelectElement);
const nextButton = element("next", HTMLButtonElement);
let simulation = createSimulation();
let scenario = "approval";
let index = 0;
const role = (): "implementor" | "reviewer" =>
  roleSelect.value === "reviewer" ? "reviewer" : "implementor";
const refreshTemplate = (): void => {
  try {
    report.value = simulation.template(
      verdict.value === "changes_requested" ? "changes_requested" : "approved",
    );
    filename.value = simulation.binding().filename;
  } catch {
    report.value = "Review template becomes available after review dispatch.";
    filename.value = "";
  }
};
const render = (): void => {
  const s = simulation.getState();
  const flow = scenarios[scenario]!;
  element("description", HTMLParagraphElement).textContent = flow.description;
  element("step", HTMLParagraphElement).textContent =
    index >= flow.steps.length
      ? "Guided flow complete. Free play remains available."
      : `${index + 1}/${flow.steps.length} · ${flow.steps[index]!.label}`;
  nextButton.disabled = index >= flow.steps.length;
  const notice = element("notice", HTMLDivElement);
  notice.textContent = s.notice;
  notice.dataset.tone = s.error ? "error" : "info";
  element("ticket", HTMLDivElement).textContent =
    `T1 · ${s.ticket?.state.path ?? "NotStarted"} · HEAD ${s.head}`;
  for (const r of ["implementor", "reviewer"] as const) {
    const w = s.workers[r];
    const assignment = w === undefined ? undefined : currentAssignment(w);
    element(r, HTMLPreElement).textContent =
      w === undefined
        ? "Not launched"
        : `${w.value.workerId} · ${w.state.path}\n${assignment?.id ?? "Retired"}\n${assignment?.goal ?? "Git resources retained"}\nGuard: ${s.extension && needsOutcome(w) ? "armed" : "accounted waiting / off"}\nReprompts: ${w.value.reprompts}`;
  }
  element("outbox", HTMLPreElement).textContent =
    s.callbacks
      .map((c) => `${c.delivered ? "delivered" : "pending"} → ${c.target}\n${c.id}: ${c.text}`)
      .join("\n\n") || "No callbacks";
  element("ledger", HTMLPreElement).textContent = s.ledger.join("\n\n") || "No accepted outcomes";
  element("log", HTMLPreElement).textContent = s.log.slice(-16).join("\n") || "No events yet";
  element("snapshot", HTMLPreElement).textContent = JSON.stringify(
    { ticket: s.ticket, workers: s.workers },
    null,
    2,
  );
  for (const name of ["online", "extension", "checksPass", "merged", "foreignPane"] as const)
    element(name, HTMLInputElement).checked = s[name];
};
const selectScenario = (name: string): void => {
  if (scenarios[name] === undefined) throw new Error("Unknown scenario");
  simulation = createSimulation();
  scenario = name;
  index = 0;
  scenarioSelect.value = name;
  refreshTemplate();
  render();
};
const dispatch = (action: DemoAction, selectedRole = role()): void => {
  simulation.dispatch(action, selectedRole, report.value, filename.value || undefined);
  if (["review", "rereview", "answer", "refresh"].includes(action)) refreshTemplate();
  render();
};
const next = (): void => {
  const item = scenarios[scenario]!.steps[index];
  if (item === undefined) return;
  simulation.configure(item.settings);
  roleSelect.value = item.role;
  if (item.action === "submit") {
    verdict.value = item.verdict;
    refreshTemplate();
    if (item.invalid) report.value = "# Review\n\nverdict: approved\n";
  }
  dispatch(item.action, item.role);
  index++;
  render();
};
for (const [name, flow] of Object.entries(scenarios)) {
  const option = document.createElement("option");
  option.value = name;
  option.textContent = flow.title;
  scenarioSelect.append(option);
}
scenarioSelect.addEventListener("change", () => selectScenario(scenarioSelect.value));
nextButton.addEventListener("click", next);
element("reset", HTMLButtonElement).addEventListener("click", () => selectScenario(scenario));
verdict.addEventListener("change", refreshTemplate);
for (const button of document.querySelectorAll<HTMLButtonElement>("[data-action]"))
  button.addEventListener("click", () => {
    const action = button.dataset.action;
    if (action !== undefined) dispatch(action as DemoAction);
  });
for (const name of ["online", "extension", "checksPass", "merged", "foreignPane"] as const)
  element(name, HTMLInputElement).addEventListener("change", () => {
    simulation.configure({ [name]: element(name, HTMLInputElement).checked });
    render();
  });
declare global {
  interface Window {
    fleetDemo: {
      model: { workerMachine: typeof workerMachine; ticketMachine: typeof ticketMachine };
      scenarios: typeof scenarios;
      getState: typeof simulation.getState;
      selectScenario: typeof selectScenario;
      dispatch: typeof dispatch;
      next: typeof next;
    };
  }
}
window.fleetDemo = {
  model: { workerMachine, ticketMachine },
  scenarios,
  getState: () => simulation.getState(),
  selectScenario,
  dispatch,
  next,
};
selectScenario("approval");
