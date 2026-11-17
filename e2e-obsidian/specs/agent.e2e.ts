import { browser, expect } from "@wdio/globals";
import { MockOllama } from "./mock-ollama";

/**
 * The paths a user actually walks, in a real Obsidian: ask in the chat → the diff dialog →
 * approve → the note is changed; undo it; open "Report a problem" and read what it would send.
 */

const NOTE = "E2E note.md";
const mock = new MockOllama();

interface PluginUnderTest {
	settings: Record<string, unknown>;
	saveSettings(): Promise<void>;
	undo: { size: number; latest(): unknown };
}

async function readNote(): Promise<string> {
	return browser.executeObsidian(async ({ app }, path) => {
		const file = app.vault.getFileByPath(path);
		return file ? app.vault.read(file) : "(missing)";
	}, NOTE);
}

describe("Local Vault Agent in Obsidian", function () {
	before(async function () {
		const url = await mock.start();
		await browser.executeObsidian(
			async ({ app }, { url, note }) => {
				const plugin = (app as unknown as { plugins: { plugins: Record<string, unknown> } }).plugins.plugins["local-vault-agent"] as PluginUnderTest;
				Object.assign(plugin.settings, { ollamaUrl: url, model: "mock-model", semanticSearch: false, setupShown: true, survey: "done", citations: "off", autoApproveEdits: false, thinking: "auto" });
				await plugin.saveSettings();
				const existing = app.vault.getFileByPath(note);
				if (existing) await app.vault.modify(existing, "alpha beta\n");
				else await app.vault.create(note, "alpha beta\n");
			},
			{ url, note: NOTE },
		);
	});

	after(async function () {
		await mock.stop();
	});

	it("loads and exposes its API", async function () {
		const api = await browser.executeObsidian(({ app }) => {
			const plugin = (app as unknown as { plugins: { plugins: Record<string, { api?: { version: number; ollama(): { url: string; model: string; provider?: string } } }> } }).plugins.plugins["local-vault-agent"];
			return plugin?.api ? { version: plugin.api.version, ...plugin.api.ollama() } : null;
		});
		expect(api).toEqual({ version: 1, url: mock.url, model: "mock-model", provider: "ollama" });
	});

	it("chat → diff → approve changes the note", async function () {
		mock.script([{ tool: "edit_note", args: { path: NOTE, old_text: "alpha", new_text: "ALPHA" } }, { content: "Changed alpha to ALPHA in [[E2E note]]." }]);
		await browser.executeObsidianCommand("local-vault-agent:open-chat");
		const input = browser.$(".lva-input");
		await input.waitForExist({ timeout: 20000 });
		await input.click();
		await input.setValue("Change alpha to ALPHA in E2E note");
		await browser.keys("Enter");

		// Nothing is written before the diff is approved.
		const modal = browser.$(".lva-approval-modal");
		await modal.waitForExist({ timeout: 30000 });
		expect(await readNote()).toBe("alpha beta\n");
		await expect(modal.$(".lva-diff")).toHaveText(expect.stringContaining("ALPHA beta"));
		await modal.$("button.mod-cta").click();

		await browser.waitUntil(async () => (await readNote()) === "ALPHA beta\n", { timeout: 20000, timeoutMsg: "the note was not changed after approval" });
		await expect(browser.$(".lva-assistant .lva-markdown")).toHaveText(expect.stringContaining("Changed alpha to ALPHA"));
		expect(mock.chats.length).toBe(2);
	});

	it("rejecting a diff leaves the note alone", async function () {
		mock.script([{ tool: "edit_note", args: { path: NOTE, old_text: "beta", new_text: "BETA" } }, { content: "The change was not applied. What would you like instead?" }]);
		const input = browser.$(".lva-input");
		await input.click();
		await input.setValue("Change beta to BETA in E2E note");
		await browser.keys("Enter");
		const modal = browser.$(".lva-approval-modal");
		await modal.waitForExist({ timeout: 30000 });
		await browser.keys("Escape");
		await modal.waitForExist({ reverse: true, timeout: 10000 });
		await browser.pause(500);
		expect(await readNote()).toBe("ALPHA beta\n");
	});

	it("undo shows the reverse diff and restores the note", async function () {
		await browser.waitUntil(async () => !(await browser.$(".lva-send.lva-stop").isExisting()), { timeout: 30000 });
		await browser.executeObsidianCommand("local-vault-agent:undo-last-change");
		const modal = browser.$(".lva-approval-modal");
		await modal.waitForExist({ timeout: 20000 });
		await modal.$("button.mod-cta").click();
		await browser.waitUntil(async () => (await readNote()) === "alpha beta\n", { timeout: 20000, timeoutMsg: "undo did not restore the note" });
	});

	it("the change history lists the change and its undo", async function () {
		await browser.executeObsidianCommand("local-vault-agent:change-history");
		const modal = browser.$(".lva-history-modal");
		await modal.waitForExist({ timeout: 20000 });
		const rows = await modal.$$(".lva-history-row");
		expect(rows.length).toBeGreaterThanOrEqual(2);
		await browser.keys("Escape");
	});

	it("report a problem shows a redacted report and sends nothing", async function () {
		const before = mock.chats.length;
		await browser.executeObsidianCommand("local-vault-agent:report-problem");
		const preview = browser.$(".lva-report-preview");
		await preview.waitForExist({ timeout: 20000 });
		const body = await preview.getValue();
		expect(body).toContain("### Environment");
		expect(body).toContain("Local Vault Agent");
		expect(body).toContain("mock-model");
		// No note text, no chat text, no absolute path of the vault.
		expect(body).not.toContain("ALPHA");
		expect(body).not.toContain("Change alpha");
		const vaultPath = await browser.executeObsidian(({ app }) => (app.vault.adapter as unknown as { getBasePath?: () => string }).getBasePath?.() ?? "");
		if (vaultPath) expect(body).not.toContain(vaultPath);
		await browser.keys("Escape");
		expect(mock.chats.length).toBe(before);
	});

	it("the setup checklist shows the four steps with live status", async function () {
		await browser.executeObsidianCommand("local-vault-agent:setup-checklist");
		const modal = browser.$(".lva-setup-modal");
		await modal.waitForExist({ timeout: 20000 });
		await browser.waitUntil(async () => (await modal.$$(".lva-setup-step")).length === 4, { timeout: 20000, timeoutMsg: "the checklist did not list four steps" });
		// The scripted server is reachable and its model can call tools.
		expect((await modal.$$(".lva-setup-step.lva-setup-ok")).length).toBeGreaterThanOrEqual(2);
		await browser.keys("Escape");
		await modal.waitForExist({ reverse: true, timeout: 10000 });
	});

	it("try it on sample notes creates the notes and offers three questions", async function () {
		await browser.executeObsidianCommand("local-vault-agent:try-sample");
		const sampleCount = () => browser.executeObsidian(({ app }) => app.vault.getMarkdownFiles().filter((f) => f.path.startsWith("Local Vault Agent sample/")).length);
		await browser.waitUntil(async () => (await sampleCount()) === 5, { timeout: 20000, timeoutMsg: "the five sample notes were not created" });
		expect(await browser.executeObsidian(({ app }) => app.vault.getFileByPath("Local Vault Agent sample/Start here.md") !== null)).toBe(true);
		await browser.waitUntil(async () => (await browser.$$(".lva-fixes .lva-chip")).length >= 3, { timeout: 20000, timeoutMsg: "the sample questions were not shown" });
	});

	it("the settings page renders, with the provider and the report button", async function () {
		await browser.executeObsidian(({ app }) => {
			const setting = (app as unknown as { setting: { open(): void; openTabById(id: string): void } }).setting;
			setting.open();
			setting.openTabById("local-vault-agent");
		});
		// The text of whatever dialog is open: the settings window's markup differs between Obsidian versions.
		const text = () => browser.execute(() => Array.from(document.querySelectorAll(".modal-container"), (el) => el.textContent ?? "").join("\n"));
		await browser.waitUntil(async () => (await text()).includes("Provider"), { timeout: 20000, timeoutMsg: "the settings page did not show the Provider setting" });
		const shown = await text();
		for (const expected of ["Chat model", "Scheduled jobs", "Report a problem", "Ollama URL", "Answer language", "Paragraph citations"]) expect(shown).toContain(expected);
		await browser.keys("Escape");
	});
});
