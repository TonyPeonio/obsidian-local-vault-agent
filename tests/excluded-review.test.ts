import { describe, expect, it } from "vitest";
import type { App } from "obsidian";
import LocalVaultAgentPlugin from "../src/main";
import { allowedLectures, lectureTranscript, listLectures } from "../src/lecture-companion";
import { ObsidianVault } from "../src/obsidian-vault";
import { commandAllowedOn, isExcluded } from "../src/settings";
import type { LectureInfo, LectureSource, ToolContext } from "../src/types";
import { FakeVault } from "./fakes";

// Written in review of the excluded-folder commands: the matching at its edges, and two ways an
// excluded note still reached the model or was written to that no command check covers.

describe("review: which paths an excluded folder covers", () => {
	const app = { vault: { getFileByPath: () => null }, metadataCache: { getFirstLinkpathDest: () => null } } as unknown as App;
	/** What the vault guard does with the path: true when it refuses it as excluded. */
	const guardRefuses = (path: string, excluded: string[]) =>
		new ObsidianVault(app, (p) => isExcluded(p, excluded)).read(path).then(
			() => false,
			(err: Error) => /excluded in the plugin's settings/.test(err.message),
		);

	const cases: { excluded: string[]; inside: string[]; outside: string[] }[] = [
		{
			// A folder whose name begins another folder's name.
			excluded: ["Private"],
			inside: ["Private/Diary.md", "Private/a/b/c/Deep.md", "private/diary.md", "PRIVATE/Scan.PNG", "Private"],
			outside: ["Private notes/Plan.md", "Private-notes/Plan.md", "Privates/Plan.md", "Private.md", "Private notes.md", "Notes/Private/Plan.md", "Notes/Private.md"],
		},
		{
			// The longer name excluded: the shorter one is not.
			excluded: ["Private notes"],
			inside: ["Private notes/Plan.md", "private NOTES/plan.md"],
			outside: ["Private/Diary.md", "Private notes 2/Plan.md"],
		},
		{
			// Written with a trailing slash, a leading slash, backslashes, spaces around it.
			excluded: ["Private/", "/Archive/Old/", "Work\\Clients\\", "  Journal  "],
			inside: ["Private/Diary.md", "Archive/Old/2019.md", "Work/Clients/Acme/Call.md", "work/clients/acme.md", "Journal/2026-11-18.md"],
			outside: ["Archive/New/2026.md", "Archive/Older/2018.md", "Archive.md", "Work/Clients2/Call.md", "Work/Other.md", "Clients/Acme.md", "Journal 2/x.md"],
		},
		{
			// A nested folder: its parent and its siblings stay open.
			excluded: ["Projects/Secret/Drafts"],
			inside: ["Projects/Secret/Drafts/One.md", "Projects/Secret/Drafts/2026/Two.md"],
			outside: ["Projects/Secret/Plan.md", "Projects/Secret/Drafts.md", "Projects/Secret/Drafts old/One.md", "Projects/Plan.md", "Drafts/One.md"],
		},
		{
			// Entries that name nothing exclude nothing.
			excluded: ["", "  ", "/", "\\"],
			inside: [],
			outside: ["Private/Diary.md", "Note.md"],
		},
	];

	it("the same paths for a command as for the vault guard: letter case, slashes, nested folders, a name that begins another", async () => {
		for (const c of cases) {
			for (const path of c.inside) {
				expect(commandAllowedOn(path, c.excluded), `${path} in ${JSON.stringify(c.excluded)}`).toBe(false);
				expect(await guardRefuses(path, c.excluded), `guard: ${path}`).toBe(true);
			}
			for (const path of c.outside) {
				expect(commandAllowedOn(path, c.excluded), `${path} not in ${JSON.stringify(c.excluded)}`).toBe(true);
				expect(await guardRefuses(path, c.excluded), `guard: ${path}`).toBe(false);
			}
		}
	});
});

const LECTURES: LectureInfo[] = [
	{ path: "Courses/CSCI 470/2026-10-02.md", course: "CSCI 470", date: "2026-10-02", kind: "lecture", sentence: "Isolation forests and contamination." },
	{ path: "Private/Therapy/2026-10-03.md", course: "Therapy", date: "2026-10-03", kind: "meeting", sentence: "CANARY what was said in the session." },
	{ path: "Private/Board/2026-10-04.md", course: "CSCI 470", date: "2026-10-04", kind: "meeting", sentence: "CANARY grade dispute." },
];
const source = (): LectureSource => ({
	courses: () => ["CSCI 470", "Therapy", "PHYS 100"],
	lectures: (course?: string) => (course ? LECTURES.filter((l) => l.course === course) : LECTURES),
	transcript: async (path: string) => [{ start: 5, text: `CANARY transcript of ${path}` }],
});
const allowed = (path: string) => commandAllowedOn(path, ["Private"]);
/** A vault that knows every lecture note, as if the note's path had been found some other way. */
const ctx = (lectures: LectureSource): ToolContext => ({ vault: new FakeVault(Object.fromEntries(LECTURES.map((l) => [l.path, "# Lecture"]))), search: async () => [], approve: async () => "approve", maxResultChars: 4000, lectures });

describe("review: Lecture Companion's lectures in an excluded folder", () => {
	it("were listed and read out to the model by the source the agent was given until now", async () => {
		expect(await listLectures.execute({}, ctx(source()))).toContain("CANARY what was said in the session.");
		expect(await lectureTranscript.execute({ path: "Private/Therapy/2026-10-03.md" }, ctx(source()))).toContain("CANARY transcript of Private/Therapy/2026-10-03.md");
	});

	it("are not listed, their course is not named, and their transcript is refused", async () => {
		const open = allowedLectures(source(), allowed);
		const listed = await listLectures.execute({}, ctx(open));
		expect(listed).not.toContain("CANARY");
		expect(listed).not.toContain("Private");
		expect(listed).not.toContain("Therapy");
		expect(listed).toContain("1 lecture. Courses: CSCI 470, PHYS 100.");
		expect(listed).toContain("Courses/CSCI 470/2026-10-02.md");
		expect(await listLectures.execute({ course: "Therapy" }, ctx(open))).not.toContain("CANARY");
		for (const path of ["Private/Therapy/2026-10-03.md", "Private/Therapy/2026-10-03", "private/board/2026-10-04.md", "Therapy 2026-10-03"]) {
			await expect(lectureTranscript.execute({ path }, ctx(open)), path).rejects.toThrow(/No lecture found/);
		}
		// A lecture outside is read as before.
		expect(await lectureTranscript.execute({ path: "Courses/CSCI 470/2026-10-02.md" }, ctx(open))).toContain("CANARY transcript of Courses/CSCI 470/2026-10-02.md");
	});

	it("changes nothing when no folder is excluded", async () => {
		const all = allowedLectures(source(), () => true);
		expect(all.courses()).toEqual(source().courses());
		expect(all.lectures()).toEqual(LECTURES);
		expect(await listLectures.execute({}, ctx(all))).toBe(await listLectures.execute({}, ctx(source())));
	});

	it("is what the plugin hands to the agent and to the quiz", async () => {
		const api = { version: 1, ...source(), transcribe: async () => "", ollama: () => ({ url: "u", model: "m" }) };
		const p = Object.assign(Object.create(LocalVaultAgentPlugin.prototype) as LocalVaultAgentPlugin, {
			app: { plugins: { plugins: { "lecture-companion": { api } } } },
			settings: { excludedFolders: ["private/"] },
		});
		const lectures = p.lecturesForAgent();
		expect(lectures?.lectures().map((l) => l.path)).toEqual(["Courses/CSCI 470/2026-10-02.md"]);
		expect(lectures?.courses()).toEqual(["CSCI 470", "PHYS 100"]);
		await expect(lectures?.transcript("Private/Therapy/2026-10-03.md")).rejects.toThrow(/No lecture found/);
		// The microphone and the settings still get Lecture Companion itself.
		expect(p.lectureCompanion()).toBe(api);
		Object.assign(p, { app: {} });
		expect(p.lecturesForAgent()).toBeNull();
	});
});

describe("review: a picture pasted into the chat while a note of an excluded folder is open", () => {
	/** A plugin whose Obsidian keeps attachments beside the open note, or always in `folder`. */
	function standIn(active: string | null, folder?: string) {
		const asked: string[] = [];
		const created: string[] = [];
		const p = Object.assign(Object.create(LocalVaultAgentPlugin.prototype) as LocalVaultAgentPlugin, {
			app: {
				workspace: { getActiveFile: () => (active ? { path: active } : null) },
				fileManager: {
					getAvailablePathForAttachment: async (name: string, sourcePath: string) => {
						asked.push(sourcePath);
						if (folder !== undefined) return `${folder}/${name}`;
						return sourcePath.includes("/") ? `${sourcePath.slice(0, sourcePath.lastIndexOf("/"))}/${name}` : name;
					},
				},
				vault: {
					getFolderByPath: () => ({}),
					createBinary: async (path: string) => (created.push(path), { path }),
				},
			},
			settings: { excludedFolders: ["Private"] },
		});
		return { p, asked, created };
	}

	it("is not saved inside the excluded folder: it goes where an attachment goes when no note is open", async () => {
		const x = standIn("Private/Diary.md");
		expect(await x.p.saveAttachment("Pasted image.png", new ArrayBuffer(4))).toBe("Pasted image.png");
		expect(x.created).toEqual(["Pasted image.png"]);
		expect(x.asked).toEqual(["Private/Diary.md", ""]);
	});

	it("is saved beside the open note as before when that note is not excluded, and with no note open", async () => {
		const x = standIn("Notes/Public.md");
		expect(await x.p.saveAttachment("Pasted image.png", new ArrayBuffer(4))).toBe("Notes/Pasted image.png");
		expect(x.asked).toEqual(["Notes/Public.md"]);
		const none = standIn(null);
		expect(await none.p.saveAttachment("Pasted image.png", new ArrayBuffer(4))).toBe("Pasted image.png");
		expect(none.asked).toEqual([""]);
	});

	it("known and left: an attachment folder that is itself excluded is still used", async () => {
		const x = standIn("Notes/Public.md", "Private/attachments");
		expect(await x.p.saveAttachment("Pasted image.png", new ArrayBuffer(4))).toBe("Private/attachments/Pasted image.png");
	});
});
