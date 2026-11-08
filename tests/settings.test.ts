import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, SETTINGS_VERSION, isExcluded, migrateSettings } from "../src/settings";

describe("migrateSettings", () => {
	it("fills defaults for a fresh install", () => {
		const s = migrateSettings(null);
		expect(s).toEqual(DEFAULT_SETTINGS);
		expect(s.settingsVersion).toBe(SETTINGS_VERSION);
	});

	it("moves a version-1 user still on the old 0.3 temperature default to the new default", () => {
		const s = migrateSettings({ temperature: 0.3, model: "qwen3:14b" });
		expect(s.temperature).toBe(DEFAULT_SETTINGS.temperature);
		expect(s.model).toBe("qwen3:14b");
		expect(s.settingsVersion).toBe(SETTINGS_VERSION);
	});

	it("moves a user still on the old 'auto' thinking default to off, and keeps an explicit choice", () => {
		expect(migrateSettings({ thinking: "auto", settingsVersion: 2 }).thinking).toBe("off");
		expect(migrateSettings({ thinking: "auto" }).thinking).toBe("off");
		expect(migrateSettings({ thinking: "on", settingsVersion: 2 }).thinking).toBe("on");
		expect(migrateSettings({ thinking: "auto", settingsVersion: 3 }).thinking).toBe("auto");
	});

	it("version 4: gists go off and a context window above 32k comes back to 32k, once", () => {
		expect(DEFAULT_SETTINGS.gists).toBe(false);
		expect(migrateSettings({ gists: true, settingsVersion: 3 }).gists).toBe(false);
		expect(migrateSettings({ gists: true, settingsVersion: 4 }).gists).toBe(true);
		expect(migrateSettings({ numCtx: 98304, settingsVersion: 3 }).numCtx).toBe(32768);
		expect(migrateSettings({ numCtx: 98304 }).numCtx).toBe(32768);
		expect(migrateSettings({ numCtx: 16384, settingsVersion: 3 }).numCtx).toBe(16384);
		expect(migrateSettings({ numCtx: 98304, settingsVersion: 4 }).numCtx).toBe(98304);
	});

	it("keeps a temperature the user chose", () => {
		expect(migrateSettings({ temperature: 0.1 }).temperature).toBe(0.1);
		expect(migrateSettings({ temperature: 0.3, settingsVersion: 2 }).temperature).toBe(0.3);
	});
});

describe("isExcluded", () => {
	it("matches folder prefixes case-insensitively", () => {
		expect(isExcluded("Templates/Daily.md", ["templates"])).toBe(true);
		expect(isExcluded("Projects/Templates.md", ["templates"])).toBe(false);
	});
});
