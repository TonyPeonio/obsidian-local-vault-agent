import { describe, expect, it } from "vitest";
import type { App } from "obsidian";
import { ObsidianVault } from "../src/obsidian-vault";
import { isExcluded } from "../src/settings";

/**
 * A stand-in for the parts of the Obsidian app the vault adapter touches, holding one public note
 * and a private folder. `log` records every call that reads or changes a file, so a test can show
 * that a refused operation never reached the vault at all.
 */
function fakeApp() {
	const file = (path: string) => ({ path, basename: path.split("/").pop()!.replace(/\.[^.]+$/, ""), extension: path.split(".").pop()!, parent: { path: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "/" }, stat: { mtime: 1, ctime: 1, size: 10 } });
	const files = new Map(
		["Notes/Public.md", "Private/Diary.md", "Private/scan.png", "Private/Deep/Letter.md"].map((p) => [p, file(p)]),
	);
	const log: string[] = [];
	let active: string | null = null;
	const app = {
		vault: {
			getMarkdownFiles: () => Array.from(files.values()).filter((f) => f.extension === "md"),
			getFiles: () => Array.from(files.values()),
			getFileByPath: (p: string) => files.get(p) ?? null,
			getFolderByPath: () => ({}),
			createFolder: async () => undefined,
			cachedRead: async (f: { path: string }) => (log.push(`read ${f.path}`), `CANARY text of ${f.path}`),
			readBinary: async (f: { path: string }) => (log.push(`readBinary ${f.path}`), new ArrayBuffer(4)),
			create: async (p: string) => void log.push(`create ${p}`),
			createBinary: async (p: string) => void log.push(`createBinary ${p}`),
			process: async (f: { path: string }) => void log.push(`modify ${f.path}`),
		},
		metadataCache: {
			getFirstLinkpathDest: (link: string) => Array.from(files.values()).find((f) => f.basename === link) ?? null,
			getFileCache: () => ({ headings: [{ level: 2, heading: "Secret heading" }], links: [], embeds: [], frontmatter: { mood: "private" } }),
			resolvedLinks: { "Private/Diary.md": { "Notes/Public.md": 1 }, "Notes/Public.md": { "Notes/Public.md": 1 } },
		},
		workspace: {
			getActiveFile: () => (active ? files.get(active)! : null),
			// The focused editor shows the active file, whichever note that is.
			getActiveViewOfType: () => ({ file: active ? files.get(active)! : null, editor: { getSelection: () => "CANARY selection" } }),
			getMostRecentLeaf: () => null,
			getLeavesOfType: () => [],
		},
		fileManager: {
			renameFile: async (f: { path: string }, to: string) => void log.push(`rename ${f.path} -> ${to}`),
			trashFile: async (f: { path: string }) => void log.push(`trash ${f.path}`),
		},
	};
	return { app: app as unknown as App, log, open: (p: string | null) => (active = p) };
}

describe("excluded folders are a boundary, not a filter", () => {
	const make = () => {
		const f = fakeApp();
		const vault = new ObsidianVault(f.app, (p) => isExcluded(p, ["Private"]));
		return { ...f, vault };
	};
	const refused = /is inside a folder that is excluded in the plugin's settings/;

	it("does not list, resolve or admit to the existence of anything inside", () => {
		const { vault } = make();
		expect(vault.listNotes().map((n) => n.path)).toEqual(["Notes/Public.md"]);
		expect(vault.listAttachments()).toEqual([]);
		for (const name of ["Private/Diary.md", "Private/Diary", "Diary", "[[Diary]]", "Private/Deep/Letter.md", "Letter"]) expect(vault.resolve(name), name).toBeNull();
		expect(vault.resolveFile("Private/scan.png")).toBeNull();
		expect(vault.resolveFile("scan.png")).toBeNull();
		expect(vault.exists("Private/Diary.md")).toBe(false);
		expect(vault.exists("Private/Diary")).toBe(false);
		expect(vault.exists("Notes/Public.md")).toBe(true);
	});

	it("refuses every read and write there, without touching the vault", async () => {
		const { vault, log } = make();
		await expect(vault.read("Private/Diary.md")).rejects.toThrow(refused);
		await expect(vault.read("Private/Diary")).rejects.toThrow(refused);
		await expect(vault.read("private/deep/Letter.md")).rejects.toThrow(refused);
		await expect(vault.readBinary("Private/scan.png")).rejects.toThrow(refused);
		await expect(vault.modify("Private/Diary.md", "x")).rejects.toThrow(refused);
		await expect(vault.create("Private/New note.md", "x")).rejects.toThrow(refused);
		await expect(vault.createBinary("Private/new.png", new ArrayBuffer(1))).rejects.toThrow(refused);
		await expect(vault.trash("Private/Diary.md")).rejects.toThrow(refused);
		// Neither out of the folder nor into it.
		await expect(vault.rename("Private/Diary.md", "Notes/Diary.md")).rejects.toThrow(refused);
		await expect(vault.rename("Notes/Public.md", "Private/Public.md")).rejects.toThrow(refused);
		expect(log).toEqual([]);
		// The same calls outside the folder go through.
		expect(await vault.read("Notes/Public.md")).toContain("Notes/Public.md");
		await vault.modify("Notes/Public.md", "x");
		await vault.rename("Notes/Public.md", "Notes/Renamed.md");
		expect(log).toEqual(["read Notes/Public.md", "modify Notes/Public.md", "rename Notes/Public.md -> Notes/Renamed.md"]);
	});

	it("gives no metadata for a note inside, and never names one as a backlink", () => {
		const { vault } = make();
		expect(vault.getMetadata("Private/Diary.md")).toEqual({ tags: [], links: [], backlinks: [], headings: [], frontmatter: {} });
		const pub = vault.getMetadata("Notes/Public.md");
		expect(pub.backlinks).toEqual(["Notes/Public.md"]);
		expect(JSON.stringify(pub)).not.toContain("Private");
	});

	it("does not treat an excluded note the user has open as the open note, nor its selection as the selection", () => {
		const { vault, open } = make();
		open("Private/Diary.md");
		expect(vault.getActiveNotePath()).toBeNull();
		expect(vault.getSelection()).toBeNull();
		open("Notes/Public.md");
		expect(vault.getActiveNotePath()).toBe("Notes/Public.md");
		expect(vault.getSelection()).toBe("CANARY selection");
	});
});
