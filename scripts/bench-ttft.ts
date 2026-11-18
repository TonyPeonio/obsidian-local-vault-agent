/**
 * Time to first token: how long after a message is sent anything comes back, which is what a
 * person at the keyboard feels. Run against a live Ollama with the large generated vault.
 *
 *   node scripts/make-vault.mjs && npm run bench:ttft
 *   MODEL=qwen3.5:4b RUNS=5 TAG=name npm run bench:ttft
 *
 * Cases, each from a model that is not loaded unless it says otherwise:
 *   cold            the first message of a session
 *   after warm-up   the same, when the chat box was focused first (Agent.warm) and the warm-up finished
 *   follow-up       a second message in the same conversation
 *   new chat        a first message in a new conversation, model still loaded
 *   other note open a second message after another note was opened in the editor
 *   after a new note a later message after a note was created in the vault
 */
import "../tests/setup";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { join, relative, resolve } from "path";
import { Agent, newConversation, type AgentConfig } from "../src/agent";
import { OllamaClient } from "../src/ollama";
import { keywordSearch } from "../src/search";
import { DEFAULT_SETTINGS, SAMPLING } from "../src/settings";
import { ALL_TOOLS } from "../src/tools";
import { FakeVault } from "../tests/fakes";

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const MODEL = process.env.MODEL ?? "qwen3.5:9b";
const NUM_CTX = Number(process.env.NUM_CTX ?? 32768);
const RUNS = Number(process.env.RUNS ?? 3);
const TAG = process.env.TAG ?? "";
const VAULT_DIR = process.env.VAULT_DIR ?? "test-vault-large";

function loadVault(dir: string): FakeVault {
	const vault = new FakeVault();
	const walk = (d: string) => {
		for (const name of readdirSync(d).sort()) {
			const p = join(d, name);
			if (statSync(p).isDirectory()) walk(p);
			else if (name.endsWith(".md")) vault.seed(relative(dir, p).split("\\").join("/"), readFileSync(p, "utf8"));
		}
	};
	walk(dir);
	return vault;
}

async function unload(): Promise<void> {
	await fetch(`${OLLAMA_URL}/api/generate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: MODEL, keep_alive: 0 }) }).catch(() => undefined);
	for (let i = 0; i < 40; i++) {
		const ps = (await (await fetch(`${OLLAMA_URL}/api/ps`)).json()) as { models?: { name: string }[] };
		if (!(ps.models ?? []).some((m) => m.name === MODEL)) return;
		await new Promise((r) => setTimeout(r, 250));
	}
}

interface Timing {
	/** Seconds until the first text or tool call arrived. */
	first: number;
	/** Seconds until the answer was complete. */
	total: number;
	/** Of the first request: seconds Ollama spent loading the model and reading the prompt. */
	load: number;
	read: number;
	promptTokens: number;
	steps: number;
}

async function main() {
	const vault = loadVault(resolve(process.cwd(), VAULT_DIR));
	const client = new OllamaClient(() => OLLAMA_URL);
	const cfg: AgentConfig = {
		model: MODEL,
		numCtx: NUM_CTX,
		temperature: DEFAULT_SETTINGS.temperature,
		sampling: SAMPLING,
		think: DEFAULT_SETTINGS.thinking === "on" ? true : DEFAULT_SETTINGS.thinking === "off" ? false : undefined,
		keepAlive: "10m",
		maxIterations: 20,
		maxToolResultChars: 12000,
		autoApprove: true,
		autoContinue: true,
		extraSystemPrompt: "",
		citations: "off",
	};
	const agent = new Agent({
		client,
		vault,
		tools: ALL_TOOLS,
		search: (q, limit) => keywordSearch(vault, q, limit),
		approve: async () => "approve",
		getConfig: () => cfg,
		readConventions: async () => (vault.exists("AGENT.md") ? vault.read("AGENT.md") : null),
	});

	const ask = async (conversation: ReturnType<typeof newConversation>, text: string): Promise<Timing> => {
		const start = Date.now();
		let first = 0;
		let steps = 0;
		let load = 0;
		let read = 0;
		let promptTokens = 0;
		const mark = () => {
			if (!first) first = Date.now() - start;
		};
		await agent.run(conversation, text, {
			onAssistantDelta: mark,
			onThinkingDelta: mark,
			onToolStart: mark,
			onUsage: (u) => {
				if (steps++ === 0) {
					load = u.loadMs ?? 0;
					read = u.promptEvalMs ?? 0;
					promptTokens = u.promptTokens;
				}
			},
		});
		return { first: first / 1000, total: (Date.now() - start) / 1000, load: load / 1000, read: read / 1000, promptTokens, steps };
	};

	const Q1 = "What did I decide about the chess robot's power supply, and when?";
	const Q2 = "Why did I decide that?";
	const cases: Record<string, Timing[]> = { cold: [], "after warm-up": [], "follow-up": [], "new chat": [], "other note open": [], "after a new note": [] };
	const warmSeconds: number[] = [];
	console.log(`Ollama ${await client.version()}, ${MODEL}, ${NUM_CTX} context, ${vault.listNotes().length} notes, ${RUNS} runs per case`);
	for (let run = 0; run < RUNS; run++) {
		await unload();
		const a = newConversation();
		cases.cold.push(await ask(a, Q1));
		cases["follow-up"].push(await ask(a, Q2));
		cases["new chat"].push(await ask(newConversation(), Q1));
		vault.activePath = "Projects/Kirin Engine.md";
		cases["other note open"].push(await ask(a, "And what is still open on that project?"));
		vault.activePath = null;
		// A note appears between two messages (the agent's own create_note, or the user's): the vault
		// outline in the system prompt is no longer current.
		vault.seed(`Inbox/Scratch ${run}.md`, "# Scratch\n\nA note made between two messages.");
		cases["after a new note"].push(await ask(a, "Who helped me build the robot frame?"));

		await unload();
		const t = Date.now();
		await agent.warm();
		warmSeconds.push((Date.now() - t) / 1000);
		cases["after warm-up"].push(await ask(newConversation(), Q1));
		console.log(`run ${run + 1}: cold ${cases.cold[run].first.toFixed(1)} s, warm-up took ${warmSeconds[run].toFixed(1)} s, then ${cases["after warm-up"][run].first.toFixed(1)} s`);
	}

	const median = (xs: number[]) => [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)];
	const f = (n: number) => n.toFixed(1);
	console.log("\n| Case | First token, s | Whole answer, s | Model load, s | Prompt read, s | Prompt tokens |");
	console.log("|---|---:|---:|---:|---:|---:|");
	for (const [name, ts] of Object.entries(cases)) {
		console.log(`| ${name} | ${f(median(ts.map((x) => x.first)))} | ${f(median(ts.map((x) => x.total)))} | ${f(median(ts.map((x) => x.load)))} | ${f(median(ts.map((x) => x.read)))} | ${median(ts.map((x) => x.promptTokens))} |`);
	}
	console.log(`\nThe warm-up itself took ${f(median(warmSeconds))} s (median), while the message is being typed.`);

	const version = (JSON.parse(readFileSync(join(process.cwd(), "manifest.json"), "utf8")) as { version: string }).version;
	mkdirSync(join(process.cwd(), "bench"), { recursive: true });
	const file = join(process.cwd(), "bench", `ttft-${version}${TAG ? `-${TAG}` : ""}.json`);
	writeFileSync(file, JSON.stringify({ version, tag: TAG, date: new Date().toISOString(), model: MODEL, numCtx: NUM_CTX, runs: RUNS, warmSeconds, cases }, null, 2) + "\n");
	console.log(`saved ${relative(process.cwd(), file)}`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
