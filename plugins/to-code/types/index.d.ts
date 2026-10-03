export type ToCodeMemory = {
  watched: Record<string, number>;
  baselines: Record<string, number>;
  dispatched: string[];
  nudged: boolean;
};

declare module "claude-code" {
  interface PluginState {
    "to-code": { memory: ToCodeMemory };
  }
}
