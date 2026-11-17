import { describe, expect, it } from "vitest";
import { Agent, newConversation, type AgentConfig } from "../src/agent";
import { keywordSearch } from "../src/search";
import { ALL_TOOLS, editNote, editNotes, replaceNote } from "../src/tools";
import type { ApprovalRequest, ToolContext } from "../src/types";
import { UndoStack } from "../src/undo";
import { FakeOllama, FakeVault } from "./fakes";

function ctx(vault: FakeVault, approve: (r: ApprovalRequest) => Promise<"approve" | "reject">, signal?: AbortSignal): ToolContext & { records: unknown[] } {
	const records: unknown[] = [];
	return { vault, search: async () => [], approve, maxResultChars: 4000, signal, recordChange: (c) => records.push(c), records };
}

/** A vault whose writes fail for one path, like a file locked by another program. */
class FailingVault extends FakeVault {
	constructor(
		initial: Record<string, string>,
		private failing: string,
	) {
		super(initial);
	}
	async modify(path: string, content: string): Promise<void> {
		if (path === this.failing) throw new Error("EBUSY: resource busy or locked");
		return super.modify(path, content);
	}
}

describe("writes are whole or nothing", () => {
	it("writes nothing when Stop was pressed while the diff was open", async () => {
		const vault = new FakeVault({ "A.md": "one two" });
		const abort = new AbortController();
		const c = ctx(vault, async () => {
			abort.abort();
			return "approve";
		}, abort.signal);
		await expect(editNote.execute({ path: "A", old_text: "two", new_text: "three" }, c)).rejects.toThrow(/Stopped before writing/);
		expect(await vault.read("A.md")).toBe("one two");
		expect(c.records).toEqual([]);
	});

	it("writes nothing when the note changed while the diff was open", async () => {
		const vault = new FakeVault({ "A.md": "one two" });
		const c = ctx(vault, async () => {
			await vault.modify("A.md", "one two, and the user typed this");
			return "approve";
		});
		await expect(replaceNote.execute({ path: "A", content: "rewritten" }, c)).rejects.toThrow(/changed while the change was waiting/);
		expect(await vault.read("A.md")).toBe("one two, and the user typed this");
	});

	it("records nothing for a write that failed, and leaves the note as it was", async () => {
		const vault = new FailingVault({ "A.md": "one two" }, "A.md");
		const c = ctx(vault, async () => "approve");
		await expect(editNote.execute({ path: "A", old_text: "two", new_text: "three" }, c)).rejects.toThrow(/EBUSY/);
		expect(await vault.read("A.md")).toBe("one two");
		expect(c.records).toEqual([]);
	});

	it("edit_notes: a failed note is reported and unchanged, the others are written and recorded", async () => {
		const vault = new FailingVault({ "A.md": "alpha", "B.md": "beta", "C.md": "gamma" }, "B.md");
		const c = ctx(vault, async () => "approve");
		const out = await editNotes.execute(
			{
				edits: [
					{ path: "A", old_text: "alpha", new_text: "ALPHA" },
					{ path: "B", old_text: "beta", new_text: "BETA" },
					{ path: "C", old_text: "gamma", new_text: "GAMMA" },
				],
			},
			c,
		);
		expect(out).toContain("B.md: the write failed (EBUSY");
		expect([await vault.read("A.md"), await vault.read("B.md"), await vault.read("C.md")]).toEqual(["ALPHA", "beta", "GAMMA"]);
		expect(c.records).toHaveLength(2);
	});
});

const config: AgentConfig = { model: "fake", numCtx: 8192, temperature: 0, keepAlive: "1m", maxIterations: 6, maxToolResultChars: 4000, autoApprove: false, autoContinue: false, extraSystemPrompt: "", citations: "off" };

describe("a turn that fails or is stopped", () => {
	it("keeps every applied change complete and recorded, so the whole turn can be undone", async () => {
		const vault = new FakeVault({ "A.md": "alpha", "B.md": "beta" });
		const undo = new UndoStack();
		const ollama = new FakeOllama([
			{ tool: "edit_note", args: { path: "A", old_text: "alpha", new_text: "ALPHA" } },
			{ tool: "edit_note", args: { path: "B", old_text: "beta", new_text: "BETA" } },
			{ error: new Error("connection reset") },
		]);
		const agent = new Agent({ client: ollama.asClient(), vault, tools: ALL_TOOLS, search: (q, l) => keywordSearch(vault, q, l), approve: async () => "approve", getConfig: () => config, undo });
		const conv = newConversation();
		await expect(agent.run(conv, "uppercase both", {})).rejects.toThrow(/connection reset/);
		expect([await vault.read("A.md"), await vault.read("B.md")]).toEqual(["ALPHA", "BETA"]);
		expect(undo.forTurn(0, conv.id).map((c) => [c.path, c.before, c.after])).toEqual([
			["B.md", "beta", "BETA"],
			["A.md", "alpha", "ALPHA"],
		]);
	});

	it("stopping during an approval writes nothing for that change", async () => {
		const vault = new FakeVault({ "A.md": "alpha" });
		const abort = new AbortController();
		const ollama = new FakeOllama([{ tool: "edit_note", args: { path: "A", old_text: "alpha", new_text: "ALPHA" } }, { content: "done" }]);
		const agent = new Agent({
			client: ollama.asClient(),
			vault,
			tools: ALL_TOOLS,
			search: (q, l) => keywordSearch(vault, q, l),
			approve: async () => {
				abort.abort();
				return "approve";
			},
			getConfig: () => config,
			undo: new UndoStack(),
		});
		await agent.run(newConversation(), "uppercase", {}, abort.signal).catch(() => undefined);
		expect(await vault.read("A.md")).toBe("alpha");
	});
});

describe("a write refused because the note changed while its diff was open", () => {
	it("lets the model read the note again instead of answering from the earlier read", async () => {
		const vault = new FakeVault({ "A.md": "one\ntwo" });
		const ollama = new FakeOllama([
			{ tool: "read_note", args: { path: "A" } },
			{ tool: "replace_note", args: { path: "A", content: "ONE\ntwo" } },
			{ tool: "read_note", args: { path: "A" } },
			{ content: "done" },
		]);
		const agent = new Agent({
			client: ollama.asClient(),
			vault,
			tools: ALL_TOOLS,
			search: (q, l) => keywordSearch(vault, q, l),
			// A line arrives from sync while the diff is open, then the user approves.
			approve: async () => {
				await vault.modify("A.md", "one\ntwo\nthree from the phone");
				return "approve";
			},
			getConfig: () => ({ ...config, autoApprove: false }),
			undo: new UndoStack(),
		});
		const done: { name: string; result: string; ok: boolean }[] = [];
		await agent.run(newConversation(), "uppercase the first line", { onToolDone: (call, result, ok) => done.push({ name: call.function.name, result, ok }) });
		expect(done.map((d) => [d.name, d.ok])).toEqual([
			["read_note", true],
			["replace_note", false],
			["read_note", true],
		]);
		expect(done[1].result).toContain("Read it again");
		expect(done[2].result).toContain("three from the phone");
		expect(await vault.read("A.md")).toBe("one\ntwo\nthree from the phone");
	});
});

describe("block ids for citations after Stop", () => {
	const NOTE = "# Isolation forests\n\n## Transcript\n\n**[12:05]** The contamination parameter defaults to 0.05 here, meaning we expect five percent outliers.\n";

	async function cite(stop: boolean) {
		const vault = new FakeVault({ "Lecture.md": NOTE });
		const undo = new UndoStack();
		const abort = new AbortController();
		let asked = 0;
		const ollama = new FakeOllama([
			{ tool: "read_note", args: { path: "Lecture" } },
			{ content: 'The professor said "The contamination parameter defaults to 0.05 here" ([[Lecture]]).' },
		]);
		const agent = new Agent({
			client: ollama.asClient(),
			vault,
			tools: ALL_TOOLS,
			search: (q, l) => keywordSearch(vault, q, l),
			approve: async () => {
				asked++;
				if (stop) abort.abort();
				return "approve";
			},
			getConfig: () => ({ ...config, citations: "blocks" as const }),
			undo,
		});
		await agent.run(newConversation(), "What about contamination?", {}, abort.signal).catch(() => undefined);
		return { vault, undo, asked };
	}

	it("writes nothing when the block-id diff is approved after Stop", async () => {
		const { vault, undo, asked } = await cite(true);
		expect(asked).toBe(1);
		expect(await vault.read("Lecture.md")).toBe(NOTE);
		expect(undo.size).toBe(0);
	});

	it("still adds the ids when the turn was not stopped", async () => {
		const { vault, undo, asked } = await cite(false);
		expect(asked).toBe(1);
		expect(await vault.read("Lecture.md")).toContain("^t12-05");
		expect(undo.list().map((c) => c.tool)).toEqual(["add_block_ids"]);
	});
});
