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
