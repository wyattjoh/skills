/**
 * Persisted global activity and session-local workspace fleets for the mod.
 */
export type ToCodeMemory = {
  watched: Record<string, number>;
  baselines: Record<string, number>;
  dispatched: string[];
  nudged: boolean;
  nextFleetId: number;
  fleets: Record<
    string,
    {
      workspaces: string[];
      watched: Record<string, number>;
      baselines: Record<string, number>;
      dispatched: string[];
      nudged: boolean;
    }
  >;
};

declare module "claude-code" {
  interface PluginState {
    "to-code": { memory: ToCodeMemory };
  }
}
