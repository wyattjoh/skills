import * as gpuiBase from "gpui-base";
import type { Context, Element } from "gpui-kit";

type TextareaState = {
  value(): string;
  set_value(value: string): void;
  focus(): void;
  on(
    event: "change" | "submit" | "focus" | "blur",
    handler: (_event: unknown, cx: Context) => void,
  ): boolean;
  set_auto_grow(minRows: number, maxRows: number): void;
};
type TextareaApi = {
  createState(options?: { placeholder?: string; value?: string; rows?: number }): TextareaState;
  render(state: TextareaState): Element;
};

/** The retained GPUI textarea state used by the answer field. */
export type AnswerInputState = TextareaState;

let testApi: TextareaApi | undefined;

/**
 * Install a textarea API adapter for the renderer test shim, which lacks GPUI's textarea exports.
 * @param api The test-only adapter.
 */
export const setAnswerTextareaTestApi = (api: TextareaApi): void => {
  testApi = api;
};

const textareaApi = (): TextareaApi => {
  if (testApi !== undefined) return testApi;
  const exports = gpuiBase as unknown as Record<string, unknown>;
  const stateFactory = exports.TextareaState as Record<string, unknown> | undefined;
  const textareaFactory = exports.Textarea as Record<string, unknown> | undefined;
  const createState = stateFactory?.["new"];
  const render = textareaFactory?.["new"];
  if (typeof createState !== "function" || typeof render !== "function")
    throw new Error("GPUI TextareaState and Textarea exports are required");
  return {
    createState: createState as TextareaApi["createState"],
    render: render as TextareaApi["render"],
  };
};

/**
 * Create a retained, auto-growing multiline answer state.
 * @returns The state used by the panel's answer field.
 */
export const createAnswerInput = (placeholder = "Or type an answer"): AnswerInputState => {
  const input = textareaApi().createState({ placeholder, rows: 1 });
  input.set_auto_grow(1, 100);
  return input;
};

/**
 * Render the answer input using GPUI's textarea.
 * @param state The retained answer state.
 * @returns The rendered textarea element.
 */
export const answerInputElement = (state: AnswerInputState): Element => textareaApi().render(state);
