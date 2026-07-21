// This template runs in the user's React app, not in Deno. The directives
// below silence Deno-LSP-only noise about browser globals; they're harmless
// when copied into a React/Next.js/Vite/Remix project.
// deno-lint-ignore-file no-window no-window-prefix
// @ts-nocheck: template file copied into a React project; types resolve there.
import { useEffect } from "react";
import { DialStore } from "dialkit";

const STORAGE_KEY = "dialkit:session";

export type DialKitSeedPreset = {
  name: string;
  values: Record<string, unknown>;
};

export type DialKitSeedPresets = Record<string, DialKitSeedPreset[]>;

type SerializedPanel = {
  values: Record<string, unknown>;
  presets: Array<{ name: string; values: Record<string, unknown> }>;
  activePresetName: string | null;
};

export function DialKitPersistence({
  seedPresets = {},
}: { seedPresets?: DialKitSeedPresets } = {}) {
  useEffect(() => {
    const valueUnsubs = new Map<string, () => void>();
    const hydrated = new Set<string>();
    let cancelled = false;
    let retryFrameId: number | null = null;

    const readSaved = (): Record<string, SerializedPanel> | null => {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      try {
        return JSON.parse(raw) as Record<string, SerializedPanel>;
      } catch {
        return null;
      }
    };

    const persist = () => {
      const panels = DialStore.getPanels();
      if (panels.length === 0) return;

      const out: Record<string, SerializedPanel> = {};
      for (const panel of panels) {
        const presets = DialStore.getPresets(panel.id);
        const activeId = DialStore.getActivePresetId(panel.id);
        out[panel.name] = {
          values: DialStore.getValues(panel.id),
          presets: presets.map((preset) => ({
            name: preset.name,
            values: preset.values,
          })),
          activePresetName: presets.find((preset) => preset.id === activeId)?.name ?? null,
        };
      }
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(out));
    };

    // Create a preset with the given values without leaking into baseValues or
    // mutating prior presets. The order matters:
    //   1. clearActivePreset resets panel.values to baseValues and deactivates
    //      any active preset, ensuring a clean slate.
    //   2. savePreset captures the (clean) panel.values into the new preset
    //      and makes it active.
    //   3. Subsequent updateValue calls write through to the now-active
    //      preset (and to panel.values), but never to baseValues or older
    //      presets.
    const createPreset = (panelId: string, name: string, values: Record<string, unknown>) => {
      DialStore.clearActivePreset(panelId);
      DialStore.savePreset(panelId, name);
      for (const [path, value] of Object.entries(values)) {
        DialStore.updateValue(panelId, path, value as never);
      }
    };

    const sync = () => {
      const saved = readSaved();
      const panels = DialStore.getPanels();
      const liveIds = new Set(panels.map((panel) => panel.id));

      if (panels.length === 0) return;

      for (const panel of panels) {
        if (!hydrated.has(panel.id)) {
          const entry = saved?.[panel.name];

          if (entry) {
            // Rehydrate from saved session
            for (const preset of entry.presets) {
              createPreset(panel.id, preset.name, preset.values);
            }

            for (const [path, value] of Object.entries(entry.values)) {
              DialStore.updateValue(panel.id, path, value as never);
            }

            if (entry.activePresetName) {
              const match = DialStore.getPresets(panel.id).find(
                (preset) => preset.name === entry.activePresetName,
              );
              if (match) {
                DialStore.loadPreset(panel.id, match.id);
              }
            }
          } else {
            // No saved state for this panel: seed from preconfigured presets
            const seeds = seedPresets[panel.name];
            if (seeds && seeds.length > 0) {
              for (const seed of seeds) {
                createPreset(panel.id, seed.name, seed.values);
              }
              const allPresets = DialStore.getPresets(panel.id);
              if (allPresets.length > 0) {
                DialStore.loadPreset(panel.id, allPresets[0].id);
              }
            }
          }

          hydrated.add(panel.id);
        }

        if (!valueUnsubs.has(panel.id)) {
          valueUnsubs.set(panel.id, DialStore.subscribe(panel.id, persist));
        }
      }

      for (const [id, unsub] of valueUnsubs) {
        if (!liveIds.has(id)) {
          unsub();
          valueUnsubs.delete(id);
          hydrated.delete(id);
        }
      }

      persist();
    };

    const ensureInitialSync = () => {
      if (cancelled) return;
      if (DialStore.getPanels().length === 0) {
        retryFrameId = globalThis.requestAnimationFrame(ensureInitialSync);
        return;
      }
      queueMicrotask(sync);
    };

    ensureInitialSync();
    const unsubGlobal = DialStore.subscribeGlobal(sync);

    return () => {
      cancelled = true;
      if (retryFrameId !== null) {
        window.cancelAnimationFrame(retryFrameId);
      }
      unsubGlobal();
      valueUnsubs.forEach((unsub) => unsub());
    };
  }, []);

  return null;
}
