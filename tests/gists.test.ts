import { describe, expect, it } from "vitest";
import { GistCache, cleanGist, gistPrompt, type GistData } from "../src/gists";
import { FakeOllama, FakeVault } from "./fakes";

class MemoryStore {
	data: GistData | null = null;
	saves = 0;
	async load() {
		return this.data;
	}
	async save(d: GistData) {
		this.data = JSON.parse(JSON.stringify(d));
		this.saves++;
	}
}

const LONG = "# Chess Robot\n\n" + "The gantry moves pieces with an electromagnet and sometimes drags neighbours. ".repeat(3);

function setup(turns: { content: string }[], opts: { enabled?: boolean; busy?: () => boolean } = {}) {
	const vault = new FakeVault({
		"Projects/Chess Robot.md": LONG,
		"Recipes/Pasta.md": "Boil water, add pasta.",
		"Templates/Daily.md": "template",
	});
	const ollama = new FakeOllama(turns);
	const store = new MemoryStore();
	const gists = new GistCache(ollama.asClient(), vault, store, {
		getModel: () => "fake",
		isEnabled: () => opts.enabled ?? true,
		shouldIndex: (p) => !p.startsWith("Templates/"),
		isBusy: opts.busy,
		sleep: async () => {},
	});
	return { vault, ollama, store, gists };
}

describe("gist helpers", () => {
	it("cleans model output into one short line", () => {
		expect(cleanGist('Summary: "Notes on the  chess\nrobot."')).toBe("Notes on the chess robot.");
		expect(cleanGist("<think>hmm</think>\nA gist.")).toBe("A gist.");
		expect(cleanGist("word ".repeat(100)).length).toBeLessThanOrEqual(240);
		expect(cleanGist("word ".repeat(100))).toMatch(/…$/);
	});
	it("sends the head of the note with the path", () => {
		const p = gistPrompt("A/B.md", "x".repeat(50), 20);
		expect(p).toContain("Note path: A/B.md");
		expect(p).toContain("x".repeat(20) + "\n[…]");
	});
});

describe("GistCache", () => {
	it("asks the model once per long note and uses the text itself for tiny notes", async () => {
		const { gists, ollama, store } = setup([{ content: "Problems with the chess robot's magnet dragging pieces." }]);
		await gists.syncAll();
		expect(gists.get("Projects/Chess Robot.md")).toBe("Problems with the chess robot's magnet dragging pieces.");
		expect(gists.get("Recipes/Pasta.md")).toBe("Boil water, add pasta.");
		expect(gists.get("Templates/Daily.md")).toBeUndefined();
		expect(ollama.requests).toHaveLength(1);
		expect(ollama.requests[0].think).toBe(false);
		expect(ollama.requests[0].messages[1].content).toContain("Note path: Projects/Chess Robot.md");
		expect(store.saves).toBe(1);
		expect(gists.status()).toMatchObject({ done: 2, total: 2, pending: 0, building: false });
	});

	it("only regenerates notes whose mtime changed, and follows renames and deletes", async () => {
		const { gists, ollama, vault } = setup([{ content: "first" }, { content: "second" }]);
		await gists.syncAll();
		await gists.syncAll();
		expect(ollama.requests).toHaveLength(1);
		await vault.modify("Projects/Chess Robot.md", LONG + " Updated.");
		await gists.syncAll();
		expect(ollama.requests).toHaveLength(2);
		expect(gists.get("Projects/Chess Robot.md")).toBe("second");
		gists.rename("Projects/Chess Robot.md", "Archive/Robot.md");
		expect(gists.get("Archive/Robot.md")).toBe("second");
		gists.remove("Archive/Robot.md");
		expect(gists.count).toBe(1);
	});

	it("waits while the agent is busy and does nothing when disabled", async () => {
		let busy = true;
		let polls = 0;
		const { gists, ollama } = setup([{ content: "g" }], {
			busy: () => {
				polls++;
				if (polls >= 3) busy = false;
				return busy;
			},
		});
		await gists.syncAll();
		expect(polls).toBeGreaterThanOrEqual(3);
		expect(ollama.requests).toHaveLength(1);

		const off = setup([{ content: "never" }], { enabled: false });
		await off.gists.syncAll();
		expect(off.ollama.requests).toHaveLength(0);
	});

	it("records an error instead of throwing", async () => {
		const { gists } = setup([]); // no scripted turn → FakeOllama throws
		await gists.syncAll();
		expect(gists.status().lastError).toMatch(/no scripted turn/);
	});
});
