/**
 * Live scenarios against the large synthetic vault (scripts/make-vault.mjs). Measures what the
 * user feels: wall time, tool calls and context per task, plus correctness checks derived from
 * the generator's landmark facts. Undo is exercised for real at the end.
 *
 *   node scripts/make-vault.mjs && npm run e2e:large
 *   GISTS=1 → also generate note gists first (slow) and use them in the outline.
 */
import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";
import { Agent, buildSystemPrompt, looksLikePermissionQuestion, newConversation, type AgentConfig } from "../src/agent";
import { GistCache, type GistData } from "../src/gists";
import { SemanticIndex, type IndexData } from "../src/index";
import { attachMentions } from "../src/mentions";
import { OllamaClient } from "../src/ollama";
import { fuseRankings, keywordSearch } from "../src/search";
import { ALL_TOOLS } from "../src/tools";
import { UndoStack, planRevert } from "../src/undo";
import { FakeVault } from "../tests/fakes";

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const MODEL = process.env.MODEL ?? "qwen3.5:9b";
const EMBED = process.env.EMBED ?? "nomic-embed-text";
const GISTS = process.env.GISTS === "1";
const ONLY = process.env.ONLY; // comma-separated scenario ids

interface Facts {
	lectures: { course: string; date: string; topic: string; term: string; note: string }[];
	recordings: { withSummary: { note: string; rec: string }[]; withoutSummary: { note: string; rec: string }[] };
	attachments: { path: string; size: number }[];
	counts: { notes: number; chars: number; daily: number };
}

function loadVault(dir: string): FakeVault {
	const vault = new FakeVault();
	const walk = (d: string) => {
		for (const name of readdirSync(d)) {
			const p = join(d, name);
			if (statSync(p).isDirectory()) walk(p);
			else if (name.endsWith(".md")) vault.seed(relative(dir, p).replace(/\\/g, "/"), readFileSync(p, "utf8"));
		}
	};
	walk(dir);
	return vault;
}

async function main() {
	const root = join(process.cwd(), "test-vault-large");
	const facts = JSON.parse(readFileSync(join(process.cwd(), "scripts/large-facts.json"), "utf8")) as Facts;
	const vault = loadVault(root);
	for (const a of facts.attachments) vault.seedFile(a.path, a.size);
	const original = new Map<string, string>();
	for (const n of vault.listNotes()) original.set(n.path, await vault.read(n.path));
	const client = new OllamaClient(() => OLLAMA_URL);
	console.log(`Ollama ${await client.version()} at ${OLLAMA_URL}, model ${MODEL}; ${vault.listNotes().length} notes, ${facts.counts.chars} chars, ${facts.attachments.length} attachments`);

	let savedIndex: IndexData | null = null;
	const index = new SemanticIndex(client, vault, { load: async () => savedIndex, save: async (d) => void (savedIndex = d) }, {
		getModel: () => EMBED,
		isEnabled: () => true,
		shouldIndex: (p) => !p.startsWith("Templates/"),
	});
	let t = Date.now();
	await index.syncAll();
	const is = index.status();
	console.log(`Index: ${is.indexedFiles} notes, ${is.totalChunks} chunks in ${((Date.now() - t) / 1000).toFixed(1)} s`);

	let savedGists: GistData | null = null;
	const gists = new GistCache(client, vault, { load: async () => savedGists, save: async (d) => void (savedGists = d) }, {
		getModel: () => MODEL,
		isEnabled: () => GISTS,
		shouldIndex: (p) => !p.startsWith("Templates/"),
	});
	if (GISTS) {
		t = Date.now();
		await gists.syncAll();
		const gs = gists.status();
		console.log(`Gists: ${gs.done}/${gs.total} in ${((Date.now() - t) / 1000).toFixed(1)} s (${((Date.now() - t) / 1000 / Math.max(1, gs.done)).toFixed(1)} s/note)${gs.lastError ? ` error: ${gs.lastError}` : ""}`);
		for (const p of ["Projects/Chess Robot.md", "Daily/2026-10-14.md", "Recipes/Pasta.md"]) console.log(`  ${p}: ${gists.get(p)}`);
	}

	const cfg: AgentConfig = {
		model: MODEL,
		numCtx: 32768,
		temperature: 0.3,
		think: process.env.THINK === "on" ? true : process.env.THINK === "off" ? false : undefined,
		keepAlive: "10m",
		maxIterations: 40,
		maxToolResultChars: 12000,
		autoApprove: true,
		autoContinue: true,
		extraSystemPrompt: "",
	};
	const undo = new UndoStack();
	const agent = new Agent({
		client,
		vault,
		tools: ALL_TOOLS,
		search: async (q, limit) => fuseRankings([await index.search(q, limit * 2), await keywordSearch(vault, q, limit * 2)], limit),
		searchPassages: (q, limit) => index.searchPassages(q, limit),
		approve: async () => "approve",
		getConfig: () => cfg,
		undo,
		readConventions: async () => (vault.exists("AGENT.md") ? vault.read("AGENT.md") : null),
		gist: GISTS ? (p) => gists.get(p) : undefined,
	});

	const sys = buildSystemPrompt(vault, cfg, new Date(), await vault.read("AGENT.md"), GISTS ? (p) => gists.get(p) : undefined);
	console.log(`System prompt: ${sys.length} chars (~${Math.round(sys.length / 3.2)} tokens of ${cfg.numCtx})`);

	interface Row {
		id: string;
		ms: number;
		calls: number;
		prompt: number;
		pass: number;
		fail: number;
	}
	const rows: Row[] = [];
	let failures = 0;

	async function scenario(id: string, title: string, prompt: string, checks: (answer: string, tools: string[]) => [string, boolean][], opts: { attach?: boolean } = {}) {
		if (ONLY && !ONLY.split(",").includes(id)) return;
		console.log(`\n=== [${id}] ${title}\n> ${prompt.slice(0, 160)}`);
		const start = Date.now();
		const tools: string[] = [];
		let answer = "";
		let maxPrompt = 0;
		let message = prompt;
		if (opts.attach) message = (await attachMentions(prompt, vault, 24000)).message;
		try {
			await agent.run(newConversation(), message, {
				onToolStart: (c) => console.log(`  [tool] ${c.function.name} ${JSON.stringify(c.function.arguments).slice(0, 110)}`),
				onToolDone: (c, r, ok) => {
					tools.push(c.function.name);
					if (!ok) console.log(`  [tool error] ${r.slice(0, 160)}`);
				},
				onAssistantDone: (m) => {
					answer = m.content || answer;
					if (m.content.trim() && m.tool_calls?.length) console.log(`  [said] ${m.content.trim().replace(/\s+/g, " ").slice(0, 160)}`);
				},
				onAutoContinue: (n) => console.log(`  [auto-continue] ${n.slice(0, 50)}…`),
				onUsage: (u) => (maxPrompt = Math.max(maxPrompt, u.promptTokens)),
			});
		} catch (err) {
			console.log(`  [error] ${(err as Error).message}`);
		}
		const ms = Date.now() - start;
		console.log(`--- ${(ms / 1000).toFixed(1)} s, ${tools.length} calls, max prompt ${maxPrompt} tok:\n${answer.trim().slice(0, 900)}\n`);
		let pass = 0;
		let fail = 0;
		for (const [label, ok] of [...checks(answer, tools), ["did not end on a permission question", !looksLikePermissionQuestion(answer)] as [string, boolean]]) {
			console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
			if (ok) pass++;
			else {
				fail++;
				failures++;
			}
		}
		rows.push({ id, ms, calls: tools.length, prompt: maxPrompt, pass, fail });
	}

	const iso = facts.lectures.find((l) => l.term.includes("isolation forest"))!;
	await scenario("qa-lecture", "Find a lecture by concept", "Which lecture covered isolation forests, and on what date?", (a, tools) => [
		["names the ML course or note", /CSCI 470|Machine Learning/i.test(a)],
		[`gives the date ${iso.date}`, a.includes(iso.date)],
		["cites with a wikilink", /\[\[/.test(a)],
		["used ≤ 4 tool calls", tools.length <= 4],
	]);

	await scenario("qa-decision", "Cross-note decision", "What did I decide about the chess robot's power supply, and when?", (a, tools) => [
		["says 24V", /24 ?V/i.test(a)],
		["gives 2026-10-14", a.includes("2026-10-14")],
		["used ≤ 5 tool calls", tools.length <= 5],
	]);

	await scenario("qa-person", "Person lookup", "Who helped me build the chess robot frame?", (a) => [
		["names Marcus Vale", /Marcus Vale/.test(a)],
	]);

	await scenario("qa-daily", "Daily note recall", "What did I get done on 2026-10-21?", (a) => [
		["mentions re-homing", /re-?hom/i.test(a)],
	]);

	const noSummary = facts.recordings.withoutSummary;
	await scenario("list-nosummary", "Enumerate across notes", "List every note section that embeds a recording but has no Summary under it. Give the note and the section heading for each.", (a) => {
		const notes = new Set(noSummary.map((r) => r.note.replace(/\.md$/, "")));
		const hit = Array.from(notes).filter((n) => a.includes(n) || a.includes(n.split("/").pop()!));
		return [[`mentions ≥ 60% of the ${notes.size} notes with unsummarised recordings (${hit.length})`, hit.length >= Math.ceil(notes.size * 0.6)]];
	});

	await scenario("mention", "Attached note, no tools needed", "[[Projects/Kirin Engine]] What NNUE net is in use and what was its validation loss?", (a, tools) => [
		["names the net", /kirin-2026-10/.test(a)],
		["gives val loss 0.071 or finds it", /0\.071/.test(a)],
		["used ≤ 2 tool calls", tools.length <= 2],
	], { attach: true });

	await scenario("cleanup", "Multi-note clean-up", "Go through every lecture and meeting note. Wherever a section embeds a recording (a line like ![[Recording ….m4a]]) AND already has a ### Summary, delete the recording embed line. Do not touch sections that have no Summary. Do all of them now and list what you changed.", () => []);
	{
		// Check after the fact (the scenario helper's checks are synchronous; evaluate here).
		const withS = facts.recordings.withSummary;
		let removed = 0;
		for (const r of withS) if (!(await vault.read(r.note)).includes(r.rec)) removed++;
		let kept = 0;
		for (const r of noSummary) if ((await vault.read(r.note)).includes(r.rec)) kept++;
		const row = rows[rows.length - 1];
		const checks: [string, boolean][] = [
			[`removed ≥ 90% of the ${withS.length} summarised recordings (${removed})`, removed >= Math.ceil(withS.length * 0.9)],
			[`kept all ${noSummary.length} unsummarised recordings (${kept})`, kept === noSummary.length],
		];
		for (const [label, ok] of checks) {
			console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
			if (ok) row.pass++;
			else {
				row.fail++;
				failures++;
			}
		}
	}

	await scenario("organise", "Move finished projects", "Move every project note whose frontmatter says status: done into Archive/2025/ (keep the file names).", () => []);
	{
		const done = ["Line Follower Bot", "Weather Station", "Portfolio Site", "Raytracer", "Sudoku Solver"];
		const moved = done.filter((n) => vault.exists(`Archive/2025/${n}.md`) && !vault.exists(`Projects/${n}.md`));
		const row = rows[rows.length - 1];
		const ok = moved.length === done.length;
		const active = vault.exists("Projects/Chess Robot.md") && vault.exists("Projects/Kirin Engine.md");
		for (const [label, pass] of [[`moved all 5 done projects (${moved.length})`, ok], ["left active projects alone", active]] as [string, boolean][]) {
			console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}`);
			if (pass) row.pass++;
			else {
				row.fail++;
				failures++;
			}
		}
	}

	await scenario("conventions", "Follow AGENT.md", "Add 'Tested the vault agent' to today's daily note, Daily/2026-10-30 (create it from the usual structure if it does not exist).", () => []);
	{
		const row = rows[rows.length - 1];
		const exists = vault.exists("Daily/2026-10-30.md");
		const body = exists ? await vault.read("Daily/2026-10-30.md") : "";
		const inDone = /## Done[\s\S]*Tested the vault agent/.test(body);
		const noFm = !body.startsWith("---");
		for (const [label, pass] of [["note exists with the text", exists && body.includes("Tested the vault agent")], ["put it under ## Done (per AGENT.md)", inDone], ["no frontmatter added", noFm]] as [string, boolean][]) {
			console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}`);
			if (pass) row.pass++;
			else {
				row.fail++;
				failures++;
			}
		}
	}

	// Undo everything, newest first, and compare with the original snapshot.
	{
		console.log(`\n=== [undo] revert all ${undo.size} recorded changes`);
		const list = undo.list().slice().reverse();
		let reverted = 0;
		for (const change of list) {
			try {
				const plan = await planRevert(change, vault);
				await plan.apply();
				undo.remove(change.id);
				reverted++;
			} catch (err) {
				console.log(`  [undo error] ${change.tool} ${change.path}: ${(err as Error).message}`);
			}
		}
		let same = 0;
		let diff: string[] = [];
		for (const [path, content] of original) {
			if (vault.exists(path) && (await vault.read(path)) === content) same++;
			else diff.push(path);
		}
		const extra = vault.listNotes().filter((n) => !original.has(n.path)).map((n) => n.path);
		const ok = diff.length === 0 && extra.length === 0;
		console.log(`  ${ok ? "PASS" : "FAIL"}  vault restored exactly (${reverted} reverts; ${same}/${original.size} identical${diff.length ? `; differs: ${diff.slice(0, 5).join(", ")}` : ""}${extra.length ? `; extra: ${extra.join(", ")}` : ""})`);
		if (!ok) failures++;
	}

	console.log("\n=== metrics");
	console.log("scenario        seconds  calls  maxPromptTok  pass/fail");
	for (const r of rows) console.log(`${r.id.padEnd(15)} ${(r.ms / 1000).toFixed(1).padStart(7)}  ${String(r.calls).padStart(5)}  ${String(r.prompt).padStart(12)}  ${r.pass}/${r.fail}`);
	const total = rows.reduce((n, r) => n + r.ms, 0);
	console.log(`total ${(total / 1000).toFixed(0)} s, ${rows.reduce((n, r) => n + r.calls, 0)} tool calls`);
	console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
	process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
