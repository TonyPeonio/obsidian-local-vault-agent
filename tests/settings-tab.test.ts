import { describe, expect, it } from "vitest";
import type { App, Setting } from "obsidian";
import { t } from "../src/i18n";
import type LocalVaultAgentPlugin from "../src/main";
import { DEFAULT_SETTINGS } from "../src/settings";
import { LocalVaultAgentSettingTab } from "../src/settings-tab";

interface Item {
	name: string;
	desc?: string;
	visible?: () => boolean;
	render: (s: Setting) => unknown;
}

/** Records what a row's renderer does to its Setting. */
class FakeSetting {
	desc: string | null = null;
	buttons = 0;
	setDesc(d: string): this {
		this.desc = d;
		return this;
	}
	addButton(): this {
		this.buttons++;
		return this;
	}
}

function harness(provider: "ollama" | "openai") {
	const state: { lc: { ollama: () => { url: string; model: string } } | null } = { lc: null };
	const plugin = {
		settings: { ...DEFAULT_SETTINGS, provider },
		lectureCompanion: () => state.lc,
		saveSettings: async () => {},
	} as unknown as LocalVaultAgentPlugin;
	const tab = new LocalVaultAgentSettingTab({} as App, plugin);
	const find = (name: string): Item => {
		const groups = tab.getSettingDefinitions() as unknown as { items: Item[] }[];
		const item = groups.flatMap((g) => g.items).find((i) => i.name === name);
		if (!item) throw new Error(`no settings row named ${name}`);
		return item;
	};
	const render = (item: Item) => {
		const st = new FakeSetting();
		const returned = item.render(st as unknown as Setting);
		return { st, returned };
	};
	return { state, plugin, find, render };
}

describe("settings tab and Lecture Companion", () => {
	it("says what is true when the tab opens, not when the definitions were built", () => {
		const h = harness("ollama");
		// Built while Lecture Companion has not loaded yet, as at plugin load on Obsidian 1.13+.
		const status = h.find(t("set.lcStatus.name"));
		const copy = h.find(t("set.lc.name"));
		expect(h.render(status).st.desc).toBe(t("set.lcStatus.off"));
		expect(copy.visible?.()).toBe(false);

		h.state.lc = { ollama: () => ({ url: "http://localhost:11434", model: "qwen3:14b" }) };
		expect(h.render(status).st.desc).toBe(t("set.lcStatus.on"));
		expect(copy.visible?.()).toBe(true);
		const first = h.render(copy).st;
		expect(first.desc).toBe(t("set.lc.desc", { url: "http://localhost:11434", model: "qwen3:14b" }));
		expect(first.buttons).toBe(1);

		// Lecture Companion's settings change later: the next open shows the new values.
		h.state.lc = { ollama: () => ({ url: "http://localhost:11434", model: "gemma3:12b" }) };
		expect(h.render(copy).st.desc).toBe(t("set.lc.desc", { url: "http://localhost:11434", model: "gemma3:12b" }));
	});

	it("offers Lecture Companion's Ollama settings only when the provider is Ollama", () => {
		const h = harness("openai");
		h.state.lc = { ollama: () => ({ url: "http://localhost:11434", model: "qwen3:14b" }) };
		const copy = h.find(t("set.lc.name"));
		expect(copy.visible?.()).toBe(false);
		h.plugin.settings.provider = "ollama";
		expect(copy.visible?.()).toBe(true);
	});

	it("returns nothing from a row's render, so Obsidian has no bogus cleanup function to call", () => {
		const h = harness("ollama");
		h.state.lc = { ollama: () => ({ url: "http://localhost:11434", model: "qwen3:14b" }) };
		expect(h.render(h.find(t("set.lc.name"))).returned).toBeUndefined();
		expect(h.render(h.find(t("set.lcStatus.name"))).returned).toBeUndefined();
	});
});
