/**
 * Live scenarios against the large synthetic vault (scripts/make-vault.mjs). Measures what the
 * user feels: wall time, tool calls and context per task, plus correctness checks derived from
 * the generator's landmark facts. Undo is exercised for real at the end.
 *
 *   node scripts/make-vault.mjs && npm run e2e:large
 *   GISTS=1 → also generate note gists first (slow) and use them in the outline.
 */
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { join, relative } from "path";
import { Agent, buildSystemPrompt, looksLikePermissionQuestion, newConversation, type AgentConfig } from "../src/agent";
import { DEFAULT_SETTINGS, SAMPLING } from "../src/settings";
import { GistCache, type GistData } from "../src/gists";
import { SemanticIndex, type IndexData } from "../src/index";
import { attachMentions } from "../src/mentions";
import { OllamaClient } from "../src/ollama";
import { fuseRankings, keywordSearch } from "../src/search";
import { SUGGESTIONS_NOTE, gardenVault, renderGardenReport } from "../src/gardener";
import { editSelectionPrompt, processDailyNotesPrompt } from "../src/prompts";
import { ALL_TOOLS, extractSection } from "../src/tools";
import { UndoStack, planRevert } from "../src/undo";
import { FakeVault } from "../tests/fakes";

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const MODEL = process.env.MODEL ?? "qwen3.5:9b";
const EMBED = process.env.EMBED ?? "nomic-embed-text";
const GISTS = process.env.GISTS === "1";
const NUM_CTX = Number(process.env.NUM_CTX ?? 32768);
const ONLY = process.env.ONLY; // comma-separated scenario ids
/** Sampling overrides and a tag for the results file, for `npm run bench-matrix`. */
const TEMPERATURE = process.env.TEMPERATURE !== undefined ? Number(process.env.TEMPERATURE) : DEFAULT_SETTINGS.temperature;
const PRESENCE = process.env.PRESENCE !== undefined ? Number(process.env.PRESENCE) : SAMPLING.presence_penalty;
const TAG = process.env.TAG ?? "";
/** "auto" | "on" | "off"; the plugin default unless THINK is set. */
const THINK = process.env.THINK ?? DEFAULT_SETTINGS.thinking;

interface Facts {
	lectures: { course: string; date: string; topic: string; term: string; note: string }[];
	recordings: { withSummary: { note: string; rec: string }[]; withoutSummary: { note: string; rec: string }[] };
	attachments: { path: string; size: number }[];
	counts: { notes: number; chars: number; daily: number };
	daily: {
		messy: { note: string; date: string; topic: string; phrase: string }[];
		snippets: { note: string; date: string; lang: string; key: string }[];
		quoted: string[];
		captureCount: number;
	};
	garden: { brokenNote: string; brokenTarget: string };
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
	// The gardener's note, as the plugin's command would write it, so a scenario can act on it.
	vault.seed(SUGGESTIONS_NOTE, renderGardenReport(await gardenVault(vault, { dailyFolder: "Daily", exclude: (p) => p.startsWith("Templates/") })));
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
		numCtx: NUM_CTX,
		temperature: TEMPERATURE,
		sampling: { ...SAMPLING, presence_penalty: PRESENCE },
		think: THINK === "on" ? true : THINK === "off" ? false : undefined,
		keepAlive: "10m",
		maxIterations: 60,
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
		/** Tool calls that returned an error. */
		errors: number;
		/** "No note found" errors: the model guessed a path. */
		misses: number;
		/** Identical calls refused by the agent's repeated-call guard. */
		repeats: number;
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
		let errors = 0;
		let misses = 0;
		let repeats = 0;
		let message = prompt;
		if (opts.attach) message = (await attachMentions(prompt, vault, 24000)).message;
		try {
			await agent.run(newConversation(), message, {
				onToolStart: (c) => console.log(`  [tool] ${c.function.name} ${JSON.stringify(c.function.arguments).slice(0, 110)}`),
				onToolDone: (c, r, ok) => {
					tools.push(c.function.name);
					if (!ok) {
						errors++;
						if (/^Error: No note found/.test(r)) misses++;
						if (/^Not executed: you already called/.test(r)) repeats++;
						console.log(`  [tool error] ${r.slice(0, 160)}`);
					}
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
		const generic: [string, boolean][] = [
			["did not end on a permission question", !looksLikePermissionQuestion(answer)],
			[`no repeated tool calls (${repeats})`, repeats === 0],
			[`at most 2 guessed paths (${misses})`, misses <= 2],
		];
		for (const [label, ok] of [...checks(answer, tools), ...generic]) {
			console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
			if (ok) pass++;
			else {
				fail++;
				failures++;
			}
		}
		rows.push({ id, ms, calls: tools.length, prompt: maxPrompt, errors, misses, repeats, pass, fail });
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

	// The failure modes seen in a real vault: surveying 127 daily notes by guessing dates one
	// by one, a regex sent as literal text, a path that does not exist, a repeated grep.
	const messy = facts.daily.messy;
	await scenario("survey-daily", "Find the messy daily notes", "Which of my daily notes have a Capture section with real content that should be compiled into its own note? List each note and say what it contains in a few words. Most Capture sections are empty or a one-liner; I only want the substantial ones.", (a, tools) => {
		const hit = messy.filter((m) => a.includes(m.date));
		// Empty inboxes and one-liners must not be listed; the code-block days legitimately may be.
		const oneLiners = ["2026-10-08", "2026-10-19", "2026-09-04", "2026-09-11"].filter((d) => a.includes(d));
		return [
			[`names ≥ 5 of the ${messy.length} messy notes (${hit.length})`, hit.length >= 5],
			[`lists at most one one-liner day as substantial (${oneLiners.length})`, oneLiners.length <= 1],
			["used ≤ 12 tool calls", tools.length <= 12],
		];
	});

	await scenario("code-snippets", "Collect code blocks", "Find every code block in my daily notes and collect them into a new note Code Snippets.md, grouped by language, each snippet followed by a wikilink to the daily note it came from.", (a, tools) => [["used ≤ 10 tool calls", tools.length <= 10]]);
	{
		const row = rows[rows.length - 1];
		const exists = vault.exists("Code Snippets.md");
		const body = exists ? await vault.read("Code Snippets.md") : "";
		for (const [label, ok] of [
			["Code Snippets.md was created", exists],
			...facts.daily.snippets.map((s): [string, boolean] => [`contains the ${s.lang} snippet from ${s.date}`, body.includes(s.key)]),
			["cites both daily notes", facts.daily.snippets.every((s) => body.includes(s.date))],
		] as [string, boolean][]) {
			console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
			if (ok) row.pass++;
			else {
				row.fail++;
				failures++;
			}
		}
	}

	await scenario("quotes-regex", "Pattern search across notes", "Which daily notes contain a blockquote (a line starting with '>')? Just list the notes.", (a, tools) => {
		const hit = facts.daily.quoted.filter((p) => a.includes(p.replace(/\.md$/, "").split("/").pop()!));
		return [
			[`lists ≥ 80% of the ${facts.daily.quoted.length} quoted notes (${hit.length})`, hit.length >= Math.ceil(facts.daily.quoted.length * 0.8)],
			["used ≤ 4 tool calls", tools.length <= 4],
		];
	});

	await scenario("missing-path", "A note that does not exist", "What did I write in my daily note for 2026-09-31?", (a, tools) => [
		["says the note does not exist", /(no|not|isn't|is not|doesn't|does not|never)\b[^.]{0,80}\b(exist|found|note|entry|such|have|written)/i.test(a) || /september (only )?has 30 days|not a valid date|invalid date/i.test(a)],
		["used ≤ 3 tool calls", tools.length <= 3],
	]);

	// The "Process my daily notes" command: the same prompt the plugin sends.
	await scenario("distill", "Process my daily notes", processDailyNotesPrompt({ folder: "Daily", heading: "Capture", destination: "Topics", move: true }), (_a, tools) => [["used ≤ 30 tool calls", tools.length <= 30]]);
	{
		const row = rows[rows.length - 1];
		const topics = vault.listNotes().filter((n) => n.path.startsWith("Topics/"));
		const bodies = new Map<string, string>();
		for (const t of topics) bodies.set(t.path, await vault.read(t.path));
		// "Compiled" = some topic note cites the daily note; the prompt allows rewording, so the
		// landmark phrase surviving verbatim is a softer, separate check.
		const compiled = messy.filter((m) => Array.from(bodies.values()).some((b) => b.includes(m.date)));
		const phrased = messy.filter((m) => Array.from(bodies.values()).some((b) => b.toLowerCase().includes(m.phrase.toLowerCase())));
		const snippetNote = Array.from(bodies.values()).find((b) => facts.daily.snippets.every((s) => b.includes(s.key)));
		let moved = 0;
		let doneIntact = 0;
		for (const m of messy) {
			const now = await vault.read(m.note);
			const was = original.get(m.note) ?? "";
			if (/## Capture\n+- Moved to \[\[Topics\//.test(now)) moved++;
			const done = (s: string) => extractSection(s, "Done")?.text ?? "";
			if (done(now) === done(was)) doneIntact++;
		}
		let untouched = 0;
		const others = vault.listNotes().filter((n) => n.path.startsWith("Daily/") && !messy.some((m) => m.note === n.path) && !facts.daily.snippets.some((s) => s.note === n.path));
		for (const n of others) if ((await vault.read(n.path)) === original.get(n.path)) untouched++;
		for (const [label, ok] of [
			[`created topic notes in Topics/ (${topics.length})`, topics.length >= 4],
			[`compiled and cited ≥ 5 of the ${messy.length} messy inboxes (${compiled.length})`, compiled.length >= 5],
			[`kept the landmark fact of ≥ 4 inboxes word for word (${phrased.length})`, phrased.length >= 4],
			["collected both code snippets", snippetNote !== undefined],
			[`replaced ≥ 5 compiled inboxes with a link (${moved})`, moved >= 5],
			[`kept the Done timeline of all ${messy.length} daily notes (${doneIntact})`, doneIntact === messy.length],
			[`left all ${others.length} other daily notes untouched (${untouched})`, untouched === others.length],
		] as [string, boolean][]) {
			console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
			if (ok) row.pass++;
			else {
				row.fail++;
				failures++;
			}
		}
	}

	// Acting on the Vault Suggestions note the gardener wrote (seeded at start-up).
	await scenario("garden-act", "Fix the broken links from Vault Suggestions", "Work through the 'Broken links' section of [[Vault Suggestions]]: in each note listed there, replace the broken wikilink with its plain text (the name without the brackets). Do not create any notes. Then say what you changed.", (_a, tools) => [["used ≤ 6 tool calls", tools.length <= 6]]);
	{
		const row = rows[rows.length - 1];
		const body = await vault.read(facts.garden.brokenNote);
		for (const [label, ok] of [
			[`removed the broken link to ${facts.garden.brokenTarget}`, !body.includes(`[[${facts.garden.brokenTarget}]]`)],
			["kept the link text", body.includes(facts.garden.brokenTarget.split("/").pop()!)],
			["kept the note's other links", body.includes("[[Kirin Engine]]") && body.includes("[[People/Marcus Vale]]")],
		] as [string, boolean][]) {
			console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
			if (ok) row.pass++;
			else {
				row.fail++;
				failures++;
			}
		}
	}

	// "Edit the selected text" with the exact prompt the command sends.
	{
		const target = "Projects/Chess Robot.md";
		const before = await vault.read(target);
		const line = before.split("\n").find((l) => l.startsWith("- The magnet sometimes drags"))!;
		await scenario("edit-selection", "Edit the selected text", editSelectionPrompt(target, line, "ends with the tag #open-problem"), (_a, tools) => [["used ≤ 3 tool calls", tools.length <= 3]]);
		const row = rows[rows.length - 1];
		const after = await vault.read(target);
		const changed = after.split("\n").find((l) => l.startsWith("- The magnet sometimes drags")) ?? "";
		for (const [label, ok] of [
			["the selected line now ends with the tag", /#open-problem\s*$/.test(changed)],
			["the line's text is otherwise intact", changed.replace(/\s*#open-problem\s*$/, "") === line],
			["nothing else in the note changed", after.replace(changed, line) === before],
		] as [string, boolean][]) {
			console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
			if (ok) row.pass++;
			else {
				row.fail++;
				failures++;
			}
		}
	}

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
	console.log("scenario        seconds  calls  errors  misses  repeats  maxPromptTok  pass/fail");
	for (const r of rows) {
		console.log(`${r.id.padEnd(15)} ${(r.ms / 1000).toFixed(1).padStart(7)}  ${String(r.calls).padStart(5)}  ${String(r.errors).padStart(6)}  ${String(r.misses).padStart(6)}  ${String(r.repeats).padStart(7)}  ${String(r.prompt).padStart(12)}  ${r.pass}/${r.fail}`);
	}
	const total = rows.reduce((n, r) => n + r.ms, 0);
	const checks = rows.reduce((n, r) => n + r.pass + r.fail, 0);
	const passed = rows.reduce((n, r) => n + r.pass, 0);
	console.log(`total ${(total / 1000).toFixed(0)} s, ${rows.reduce((n, r) => n + r.calls, 0)} tool calls, ${passed}/${checks} checks passed`);

	// Persist the run so versions can be compared (bench/<version>.json, newest run wins).
	const version = (JSON.parse(readFileSync(join(process.cwd(), "manifest.json"), "utf8")) as { version: string }).version;
	const result = {
		version,
		date: new Date().toISOString(),
		model: MODEL,
		numCtx: NUM_CTX,
		gists: GISTS,
		think: THINK,
		temperature: TEMPERATURE,
		presencePenalty: PRESENCE,
		tag: TAG,
		notes: vault.listNotes().length,
		systemPromptChars: sys.length,
		totals: { seconds: Math.round(total / 1000), calls: rows.reduce((n, r) => n + r.calls, 0), errors: rows.reduce((n, r) => n + r.errors, 0), misses: rows.reduce((n, r) => n + r.misses, 0), repeats: rows.reduce((n, r) => n + r.repeats, 0), passed, checks, failures },
		scenarios: rows.map((r) => ({ ...r, seconds: Math.round(r.ms / 10) / 100 })),
	};
	if (!ONLY) {
		mkdirSync(join(process.cwd(), "bench"), { recursive: true });
		const file = join(process.cwd(), "bench", `${version}${TAG ? `-${TAG}` : ""}.json`);
		writeFileSync(file, JSON.stringify(result, null, 2) + "\n");
		console.log(`saved ${relative(process.cwd(), file)}`);
	}
	console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
	process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
