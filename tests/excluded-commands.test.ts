import { beforeEach, describe, expect, it } from "vitest";
import { Modal, Notice } from "obsidian";
import LocalVaultAgentPlugin from "../src/main";
import { ObsidianVault } from "../src/obsidian-vault";
import { commandAllowedOn, isExcluded, refusedByExclusion } from "../src/settings";
import { t } from "../src/i18n";
import { turnContext } from "../src/agent";
import type { App } from "obsidian";

const shown = (Notice as unknown as { shown: string[] }).shown;
const opened = (Modal as unknown as { opened: unknown[] }).opened;

describe("commandAllowedOn", () => {
	const excluded = ["Private", "Journal/Secret.md", " /Archive/Old/ "];

	it("refuses a note in an excluded folder, at any depth and in any letter case", () => {
		for (const path of ["Private/Diary.md", "Private/Deep/Letter.md", "private/diary.md", "PRIVATE/scan.png", "Archive/Old/2019.md", "Journal/Secret.md"]) expect(commandAllowedOn(path, excluded), path).toBe(false);
	});

	it("allows every other note, also one whose name only begins like an excluded folder", () => {
		for (const path of ["Notes/Public.md", "Privateer/Ship.md", "Private notes.md", "Archive/New/2026.md", "Journal/Secrets.md", "Journal/Other.md"]) expect(commandAllowedOn(path, excluded), path).toBe(true);
		expect(commandAllowedOn("Private/Diary.md", [])).toBe(true);
		expect(commandAllowedOn("Private/Diary.md", ["", "  "])).toBe(true);
	});

	it("refuses a note named without its extension, as the vault guard does", () => {
		expect(commandAllowedOn("Journal/Secret", excluded)).toBe(false);
		expect(commandAllowedOn("Journal/Other", excluded)).toBe(true);
	});

	it("decides as the vault guard decides, for the same paths", async () => {
		const app = { vault: { getFileByPath: () => null }, metadataCache: { getFirstLinkpathDest: () => null } } as unknown as App;
		const vault = new ObsidianVault(app, (p) => isExcluded(p, excluded));
		for (const path of ["Private/Diary.md", "private/diary.md", "Journal/Secret", "Journal/Secret.md", "Notes/Public.md", "Privateer/Ship.md", "Journal/Other", "Archive/Old/2019.md"]) {
			// The guard refuses with its own message; a path it lets through fails later, on the file that is not there.
			const refusedByGuard = await vault.read(path).then(
				() => false,
				(err: Error) => /excluded in the plugin's settings/.test(err.message),
			);
			expect(refusedByGuard, path).toBe(!commandAllowedOn(path, excluded));
			expect(refusedByExclusion(path, (p) => isExcluded(p, excluded)), path).toBe(refusedByGuard);
		}
	});
});

/**
 * The plugin's command methods run on a stand-in: an app with one public and one private note, a
 * chat view that records what would be sent to the model, and a log of every read of a note.
 */
function standIn(active: string | null, selection = "") {
	const file = (path: string) => ({ path, basename: path.split("/").pop()!.replace(/\.md$/, ""), extension: "md" });
	const reads: string[] = [];
	const writes: string[] = [];
	const sent: string[] = [];
	const prefilled: string[] = [];
	const view = { send: async (m: string) => void sent.push(m), prefill: (m: string) => void prefilled.push(m) };
	const p = Object.assign(Object.create(LocalVaultAgentPlugin.prototype) as LocalVaultAgentPlugin, {
		app: {
			workspace: { getActiveFile: () => (active ? file(active) : null) },
			vault: {
				cachedRead: async (f: { path: string }) => (reads.push(f.path), `CANARY text of ${f.path}`),
				read: async (f: { path: string }) => (reads.push(f.path), `CANARY text of ${f.path}`),
				getFileByPath: (path: string) => file(path),
				readBinary: async (f: { path: string }) => (reads.push(f.path), new ArrayBuffer(4)),
			},
		},
		settings: { excludedFolders: ["Private"], conceptFolders: ["Concepts"], semanticSearch: false },
		vault: { listNotes: () => [], getMetadata: () => ({ tags: [], links: [], backlinks: [], headings: [], frontmatter: {} }) },
		activateView: async () => view,
		activeEditorView: () => (active ? { file: file(active), editor: { getSelection: () => selection } } : null),
		writeWithApproval: async (req: { path: string }) => (writes.push(req.path), true),
	});
	return { p, reads, writes, sent, prefilled };
}

const EXCLUDED_NOTICE = t("notice.excludedNote");
const PRIVATE = "Private/Diary.md";
const PUBLIC = "Notes/Public.md";

describe("a command run on a note in an excluded folder does nothing and says why", () => {
	beforeEach(() => {
		shown.length = 0;
		opened.length = 0;
	});

	it("says it in one sentence", () => {
		expect(EXCLUDED_NOTICE).toMatch(/excluded folder/);
		expect(EXCLUDED_NOTICE.match(/[.!?](\s|$)/g)).toHaveLength(1);
	});

	it("Reformat current note: the note is not read and nothing is sent", async () => {
		const x = standIn(PRIVATE);
		await x.p.reformatCurrentNote();
		expect(x.reads).toEqual([]);
		expect(x.sent).toEqual([]);
		expect(shown).toEqual([EXCLUDED_NOTICE]);

		const ok = standIn(PUBLIC);
		await ok.p.reformatCurrentNote();
		expect(ok.reads).toEqual([PUBLIC]);
		expect(ok.sent).toHaveLength(1);
		// (The prompt names the note; its text is read to say whether it has frontmatter.)
		expect(ok.sent[0]).toContain(PUBLIC);
		expect(shown).toEqual([EXCLUDED_NOTICE]);
	});

	it("Summarize current note: the note's path is not sent", async () => {
		const x = standIn(PRIVATE);
		await x.p.summarizeCurrentNote();
		expect(x.sent).toEqual([]);
		expect(shown).toEqual([EXCLUDED_NOTICE]);

		const ok = standIn(PUBLIC);
		await ok.p.summarizeCurrentNote();
		expect(ok.sent).toHaveLength(1);
		expect(ok.sent[0]).toContain(PUBLIC);
	});

	it("Edit the selected text: no instruction is asked for and the selection is not sent", async () => {
		const x = standIn(PRIVATE, "CANARY selection");
		await x.p.editSelection();
		expect(opened).toHaveLength(0);
		expect(x.sent).toEqual([]);
		expect(shown).toEqual([EXCLUDED_NOTICE]);

		const ok = standIn(PUBLIC, "CANARY selection");
		const running = ok.p.editSelection();
		await Promise.resolve();
		expect(opened).toHaveLength(1);
		(opened[0] as { resolve(s: string): void }).resolve("make it shorter");
		await running;
		expect(ok.sent).toHaveLength(1);
		expect(ok.sent[0]).toContain("CANARY selection");
		expect(ok.sent[0]).toContain(PUBLIC);
		expect(shown).toEqual([EXCLUDED_NOTICE]);
	});

	it("Ask about the selected text: the selection is not put into the message box", async () => {
		const x = standIn(PRIVATE);
		await x.p.askAboutSelection("CANARY selection", PRIVATE);
		expect(x.prefilled).toEqual([]);
		expect(shown).toEqual([EXCLUDED_NOTICE]);

		const ok = standIn(PUBLIC);
		await ok.p.askAboutSelection("CANARY selection", PUBLIC);
		expect(ok.prefilled).toHaveLength(1);
		expect(ok.prefilled[0]).toContain("CANARY selection");
		// With nothing selected there is nothing of the note to keep back: the chat just opens.
		await x.p.askAboutSelection("", PRIVATE);
		expect(x.prefilled).toEqual([""]);
		expect(shown).toEqual([EXCLUDED_NOTICE]);
	});

	it("Suggest concept links: the note is not read and no edit is offered", async () => {
		const x = standIn(PRIVATE);
		await x.p.suggestConceptLinks();
		expect(x.reads).toEqual([]);
		expect(x.writes).toEqual([]);
		expect(opened).toHaveLength(0);
		expect(shown).toEqual([EXCLUDED_NOTICE]);

		// A note outside is read (this stand-in has no concept notes, so it ends there with that notice).
		const ok = standIn(PUBLIC);
		await ok.p.suggestConceptLinks();
		expect(ok.reads).toEqual([PUBLIC]);
		expect(shown).toHaveLength(2);
		expect(shown[1]).toMatch(/No concept notes found/);
	});
});

describe("what else could carry an excluded note to the model", () => {
	it("today's daily note is not named when the daily notes are in an excluded folder", () => {
		const x = standIn(null);
		Object.assign(x.p, { dailyNote: () => ({ path: "Private/2026-11-18.md", exists: true }) });
		expect(x.p.dailyNoteForAgent()).toBeNull();
		Object.assign(x.p, { dailyNote: () => ({ path: "Daily/2026-11-18.md", exists: true }) });
		expect(x.p.dailyNoteForAgent()).toEqual({ path: "Daily/2026-11-18.md", exists: true });
		Object.assign(x.p, { dailyNote: () => null });
		expect(x.p.dailyNoteForAgent()).toBeNull();
	});

	it("an excluded note that is open is not named in the state sent with a message", () => {
		const app = { workspace: { getActiveFile: () => ({ path: PRIVATE, extension: "md" }) } } as unknown as App;
		const vault = new ObsidianVault(app, (p) => isExcluded(p, ["Private"]));
		const context = turnContext(vault, new Date("2026-11-18T12:00:00"), null);
		expect(context).not.toContain("Private");
		expect(context).toContain("No note is currently open in the editor.");
	});

	it("the text of an attachment in an excluded folder is not read, nor a page of its PDF drawn", async () => {
		const x = standIn(null);
		await expect(x.p.readAttachmentText("Private/letter.txt")).rejects.toThrow(/excluded in the plugin's settings/);
		await expect((x.p as unknown as { renderPdfPage(p: string, n: number): Promise<ArrayBuffer> }).renderPdfPage("Private/scan.pdf", 1)).rejects.toThrow(/excluded in the plugin's settings/);
		expect(x.reads).toEqual([]);
	});
});
