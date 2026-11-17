// The core uses `window.setTimeout` (Obsidian's popout-safe timers); under Node there is no window.
(globalThis as unknown as { window?: unknown }).window ??= globalThis;
