import { describe, expect, it } from "vitest";
import { Agent, newConversation, type AgentConfig } from "../src/agent";
import { keywordSearch } from "../src/search";
import { ALL_TOOLS } from "../src/tools";
import { UndoStack, describeChange, planRevert } from "../src/undo";
import type { ChangeRecord } from "../src/types";
import { FakeOllama, FakeVault } from "./fakes";

const config: AgentConfig = {
	model: "fake",
	numCtx: 8192,
	temperature: 0,
	keepAlive: "1m",
	maxIterations: 6,
	maxToolResultChars: 4000,
	autoApprove: true,
	autoContinue: false,
	extraSystemPrompt: "",
};

function change(partial: Partial<ChangeRecord> & Pick<ChangeRecord, "tool" | "path">): ChangeRecord {
	return { id: 1, before: "", after: "", time: 0, turn: 0, ...partial };
}

describe("UndoStack", () => {
	it("records, lists by turn newest first, and removes", () => {
		const stack = new UndoStack();
		const events: number[] = [];
		stack.onChange(() => events.push(stack.size));
		const a = stack.push({ tool: "edit_note", path: "A.md", before: "1", after: "2", time: 0, turn: 3 });
		const b = stack.push({ tool: "edit_note", path: "B.md", before: "1", after: "2", time: 0, turn: 3 });
		stack.push({ tool: "edit_note", path: "C.md", before: "1", after: "2", time: 0, turn: 5 });
		expect(stack.forTurn(3).map((c) => c.path)).toEqual(["B.md", "A.md"]);
		expect(stack.latest()?.path).toBe("C.md");
		stack.remove(b.id);
		expect(stack.byId(b.id)).toBeUndefined();
		expect(stack.byId(a.id)?.path).toBe("A.md");
		expect(events).toEqual([1, 2, 3, 2]);
	});
});

describe("planRevert", () => {
	it("restores an edited note to its previous content", async () => {
		const vault = new FakeVault({ "A.md": "new text" });
		const plan = await planRevert(change({ tool: "edit_note", path: "A.md", before: "old text", after: "new text" }), vault);
		expect(plan).toMatchObject({ path: "A.md", before: "new text", after: "old text" });
		expect(plan.summary).toBe("Undo: edited A.md");
		await plan.apply();
		expect(await vault.read("A.md")).toBe("old text");
	});

	it("deletes a note the agent created, and recreates a deleted note", async () => {
		const vault = new FakeVault({ "New.md": "hello" });
		const created = await planRevert(change({ tool: "create_note", path: "New.md", after: "hello" }), vault);
		expect(created.after).toBe("");
		await created.apply();
		expect(vault.exists("New.md")).toBe(false);

		const restore = await planRevert(change({ tool: "delete_file", path: "Gone.md", before: "was here" }), vault);
		expect(restore.before).toBe("");
		await restore.apply();
		expect(await vault.read("Gone.md")).toBe("was here");
	});

	it("restores a deleted attachment from the kept bytes", async () => {
		const vault = new FakeVault();
		const bytes = new Uint8Array([1, 2, 3]).buffer;
		const plan = await planRevert(change({ tool: "delete_file", path: "rec.webm", before: "(attachment)", binary: bytes }), vault);
		await plan.apply();
		expect(vault.listAttachments().map((f) => f.path)).toEqual(["rec.webm"]);
		expect(new Uint8Array(await vault.readBinary("rec.webm"))).toEqual(new Uint8Array([1, 2, 3]));
		await expect(planRevert(change({ tool: "delete_file", path: "big.webm", before: "(attachment)" }), vault)).rejects.toThrow(/too large/);
	});

	it("refuses when there is nothing left to undo", async () => {
		const vault = new FakeVault({ "A.md": "old" });
		await expect(planRevert(change({ tool: "edit_note", path: "A.md", before: "old", after: "new" }), vault)).rejects.toThrow(/already/);
		await expect(planRevert(change({ tool: "create_note", path: "Missing.md" }), vault)).rejects.toThrow(/no longer exists/);
		await expect(planRevert(change({ tool: "delete_file", path: "A.md", before: "x" }), vault)).rejects.toThrow(/already exists/);
	});

	it("describes changes", () => {
		expect(describeChange(change({ tool: "append_to_note", path: "A.md" }))).toBe("appended to A.md");
		expect(describeChange(change({ tool: "replace_note", path: "A.md" }))).toBe("rewrote A.md");
		expect(describeChange(change({ tool: "delete_file", path: "A.md" }))).toBe("deleted A.md");
	});
});

describe("agent records approved writes", () => {
	it("pushes one record per write with the turn and reports it to the UI", async () => {
		const vault = new FakeVault({ "Ideas/Sensors.md": "Hall sensors are cheap." });
		const undo = new UndoStack();
		const ollama = new FakeOllama([
			{ tool: "edit_note", args: { path: "Ideas/Sensors", old_text: "cheap", new_text: "pricey" } },
			{ content: "ok" },
			{ tool: "create_note", args: { path: "Out", content: "x" } },
			{ content: "done" },
		]);
		const agent = new Agent({
			client: ollama.asClient(),
			vault,
			tools: ALL_TOOLS,
			search: (q, l) => keywordSearch(vault, q, l),
			approve: async () => "approve",
			getConfig: () => config,
			undo,
		});
		const seen: string[] = [];
		const conv = newConversation();
		await agent.run(conv, "first", {});
		await agent.run(conv, "second", { onChange: (c, call) => seen.push(`${call.function.name}:${c.path}`) });
		// The turn id is the index of the user message that started the run.
		expect(undo.list().map((c) => [c.tool, c.path, c.turn])).toEqual([
			["edit_note", "Ideas/Sensors.md", 0],
			["create_note", "Out.md", 4],
		]);
		expect(seen).toEqual(["create_note:Out.md"]);
		expect(undo.list()[0].before).toBe("Hall sensors are cheap.");
	});
});

describe("planRevert for moves", () => {
	it("moves the file back", async () => {
		const vault = new FakeVault({ "Archive/A.md": "a" });
		const plan = await planRevert(change({ tool: "move_note", path: "Archive/A.md", before: "Projects/A.md", after: "Archive/A.md" }), vault);
		expect(plan.summary).toBe("Undo: move Archive/A.md back to Projects/A.md");
		await plan.apply();
		expect(vault.exists("Projects/A.md")).toBe(true);
		expect(vault.exists("Archive/A.md")).toBe(false);
		await expect(planRevert(change({ tool: "move_note", path: "Archive/A.md", before: "Projects/A.md", after: "Archive/A.md" }), vault)).rejects.toThrow(/no longer there/);
	});
});
