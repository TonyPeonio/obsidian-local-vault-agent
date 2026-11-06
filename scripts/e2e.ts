/**
 * End-to-end check against a live Ollama server, outside Obsidian.
 * Loads ./test-vault into an in-memory vault, builds a real embedding index, and runs
 * the agent through the three headline use cases. Usage:
 *
 *   OLLAMA_URL=http://localhost:11434 MODEL=qwen3.5:9b npm run e2e
 */
import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";
import { Agent, looksLikePermissionQuestion, newConversation, type AgentConfig } from "../src/agent";
import { SemanticIndex, type IndexData } from "../src/index";
import { OllamaClient } from "../src/ollama";
import { fuseRankings, keywordSearch } from "../src/search";
import { reformatPrompt } from "../src/prompts";
import { ALL_TOOLS } from "../src/tools";
import { FakeVault } from "../tests/fakes";

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const MODEL = process.env.MODEL ?? "qwen3.5:9b";
const EMBED = process.env.EMBED ?? "nomic-embed-text";
const THINK = process.env.THINK; // "on" | "off" | undefined

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
	const vault = loadVault(join(process.cwd(), "test-vault"));
	const client = new OllamaClient(() => OLLAMA_URL);
	console.log(`Ollama ${await client.version()} at ${OLLAMA_URL}, model ${MODEL}, ${vault.listNotes().length} notes`);

	let saved: IndexData | null = null;
	const index = new SemanticIndex(
		client,
		vault,
		{ load: async () => saved, save: async (d) => void (saved = d) },
		{ getModel: () => EMBED, isEnabled: () => true, shouldIndex: (p) => !p.startsWith("Templates/") },
	);
	const t0 = Date.now();
	await index.syncAll();
	console.log(`Index: ${JSON.stringify(index.status())} in ${Date.now() - t0} ms`);
	const sem = await index.search("magnet dragging neighbouring pieces", 3);
	console.log("Semantic top-3:", sem.map((h) => `${h.path} (${h.score.toFixed(3)})`).join(", "));

	const cfg: AgentConfig = {
		model: MODEL,
		numCtx: 16384,
		temperature: 0.3,
		think: THINK === "on" ? true : THINK === "off" ? false : undefined,
		keepAlive: "10m",
		maxIterations: 12,
		maxToolResultChars: 12000,
		autoApprove: true,
		autoContinue: true,
		extraSystemPrompt: "",
	};
	const agent = new Agent({
		client,
		vault,
		tools: ALL_TOOLS,
		search: async (q, limit) => {
			const kw = await keywordSearch(vault, q, limit * 2);
			const se = await index.search(q, limit * 2);
			return fuseRankings([se, kw], limit);
		},
		approve: async () => "approve",
		getConfig: () => cfg,
	});

	let failures = 0;
	let autoContinues = 0;
	const check = (label: string, ok: boolean) => {
		console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
		if (!ok) failures++;
	};

	async function ask(title: string, prompt: string, conv = newConversation()) {
		console.log(`\n=== ${title}\n> ${prompt}`);
		const start = Date.now();
		let answer = "";
		const tools: string[] = [];
		await agent.run(conv, prompt, {
			onToolStart: (c) => console.log(`  [tool] ${c.function.name} ${JSON.stringify(c.function.arguments).slice(0, 120)}`),
			onToolDone: (c, r, ok) => {
				tools.push(c.function.name);
				if (!ok) console.log(`  [tool error] ${r.slice(0, 200)}`);
			},
			onAssistantDone: (m) => (answer = m.content || answer),
			onAutoContinue: () => {
				autoContinues++;
				console.log("  [auto-continue] the model asked for permission; answered yes");
			},
		});
		console.log(`--- answer (${Date.now() - start} ms, tools: ${tools.join(" → ") || "none"}):\n${answer.trim()}\n`);
		return { answer, tools, conv };
	}

	// 1. Question answering grounded in notes.
	{
		const r = await ask("Q&A", "What problems have I had with the chess robot's magnet, and what did I try?");
		check("used search or read tools", r.tools.some((t) => t === "search_notes" || t === "read_note"));
		check("mentions dragging neighbours", /drag|neighbo/i.test(r.answer));
		check("cites a note with a wikilink", /\[\[/.test(r.answer));
	}

	// 2. Compile a topic into a new note.
	{
		const r = await ask(
			"Compile",
			"Compile everything I know about hall sensors into a new note at Summaries/Sensor Summary.md. Cite the source notes.",
		);
		const created = vault.exists("Summaries/Sensor Summary.md");
		check("create_note was called", r.tools.includes("create_note"));
		check("note exists", created);
		if (created) {
			const body = await vault.read("Summaries/Sensor Summary.md");
			check("summary mentions A3144 or 50 Hz", /A3144|50 ?Hz/i.test(body));
			check("summary cites a source note", /\[\[/.test(body));
			console.log("--- created note:\n" + body.trim().split("\n").slice(0, 25).join("\n"));
		}
	}

	// 3. Reformat the active note.
	{
		vault.activePath = "Ideas/Messy Note.md";
		const before = await vault.read("Ideas/Messy Note.md");
		const r = await ask(
			"Reformat",
			reformatPrompt("Ideas/Messy Note.md", before),
		);
		const after = await vault.read("Ideas/Messy Note.md");
		check("replace_note or edit_note was used", r.tools.includes("replace_note") || r.tools.includes("edit_note"));
		check("note changed", after !== before);
		check("kept the wikilink", after.includes("[[Chess Robot]]"));
		check("kept the mu-metal idea", /mu-metal/i.test(after));
		check("kept the TODO", /TODO|to-do|measure field strength/i.test(after));
		check("has a proper list", /^\s*[-*] /m.test(after));
		check("did not invent frontmatter", !after.startsWith("---"));
		console.log("--- reformatted note:\n" + after.trim());
	}

	// 4. Follow-up in the same conversation (history handling).
	{
		const r = await ask("Follow-up", "Which daily note says the drift problem was fixed, and how was it fixed?");
		check("mentions re-homing", /hom(e|ing)/i.test(r.answer));
		check("mentions 2026-02-03", /2026-02-03/.test(r.answer));
	}

	// 5. Autonomy: a multi-note clean-up must run to the end without stopping to ask.
	{
		vault.seed(
			"School/Algorithms/Lectures.md",
			"# Algorithms lectures\n\n## 2026-09-17\n\n![[Recording 20260917135752.m4a]]\n\n### Summary\n\n- Dijkstra with a binary heap is O((V+E) log V).\n- Negative edges break it; use Bellman-Ford instead.\n",
		);
		vault.seed(
			"School/Machine Learning/Lectures.md",
			"# ML lectures\n\n## 2026-10-22\n\n![[Recording 20261022150637.m4a]]\n\n- [ ] Activity: anomaly detection\n",
		);
		vault.seed(
			"Clubs/MEAL Club.md",
			"# MEAL Club\n\n## 2026-09-21 meeting\n\n![[Recording 20260921130651.m4a]]\n\n### Summary\n\n- Potluck on the 30th; bring a dish and a recipe card.\n",
		);
		vault.activePath = null;
		autoContinues = 0;
		const r = await ask(
			"Autonomy",
			"Every lecture or meeting note that embeds an audio recording (a line like ![[Recording ….m4a]]) and already has a Summary section no longer needs the recording. Find all such notes and remove the audio embed line from each of them. Leave notes that have no summary untouched. Do all of them now.",
		);
		const algo = await vault.read("School/Algorithms/Lectures.md");
		const meal = await vault.read("Clubs/MEAL Club.md");
		const ml = await vault.read("School/Machine Learning/Lectures.md");
		check("removed the embed from Algorithms (has summary)", !/Recording/.test(algo));
		check("removed the embed from MEAL Club (has summary)", !/Recording/.test(meal));
		check("kept the embed in ML (no summary)", /Recording 20261022150637/.test(ml));
		check("kept the Algorithms summary", /Bellman-Ford/.test(algo));
		check("did not end on a permission question", !looksLikePermissionQuestion(r.answer));
		console.log(`  auto-continues used: ${autoContinues}`);
	}

	// 6. Attachments: find and delete recordings that are not notes.
	{
		vault.seedFile("CSCI578 2026-11-05 1717.webm", 3_200_000);
		vault.seedFile("Fall 2026 BIOINFORMATICS 2026-11-05 1718.webm", 2_900_000);
		vault.seedFile("Attachments/sars_proteins.pdf", 400_000);
		const r = await ask("Attachments", "Get rid of the WEBM recording files sitting in the root of the vault. Leave the PDF alone.");
		const left = vault.listAttachments().map((f) => f.path);
		check("list_files or delete_file was used", r.tools.includes("list_files") || r.tools.includes("delete_file"));
		check("both webm files are gone", !left.some((p) => p.endsWith(".webm")));
		check("the PDF survived", left.includes("Attachments/sars_proteins.pdf"));
		check("did not claim it cannot delete non-markdown files", !/only work with .*\.md|cannot delete non-markdown/i.test(r.answer));
	}

	console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
	process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
