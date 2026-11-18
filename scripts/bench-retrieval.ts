/**
 * Retrieval-only benchmark: how often the search the agent relies on puts the right passage or
 * note in front of the model. No chat model is involved, so a configuration is scored in
 * seconds, not minutes, and the result does not vary from run to run.
 *
 *   node scripts/make-vault.mjs && npm run bench:retrieval
 *   TAG=name   → bench/retrieval-<version>-<name>.json
 *   EMBED=…    → another embedding model
 *   K=6        → how many results count (the search tools' default)
 *   SYSTEMS=passages,notes-hybrid → only these
 *
 * Questions and their answers come from the facts the vault generator recorded
 * (scripts/large-facts.json) plus a few written by hand against the hand-written notes.
 * A passage counts as a hit when it lies inside the section that holds the answer; a note
 * counts when it is the note that holds it.
 */
import "../tests/setup";
import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { basename, join, relative, resolve } from "path";
import { SemanticIndex, type IndexData } from "../src/index";
import { OllamaClient } from "../src/ollama";
import { fuseRankings, keywordSearch } from "../src/search";
import { FakeVault } from "../tests/fakes";

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const EMBED = process.env.EMBED ?? "nomic-embed-text";
const TAG = process.env.TAG ?? "";
const K = Number(process.env.K ?? 6);
const VAULT_DIR = process.env.VAULT_DIR ?? "test-vault-large";
/** "Today" for questions that name a day; fixed so results do not depend on when the benchmark runs. */
const NOW = new Date(2026, 10, 17, 12);
const ONLY_SYSTEMS = process.env.SYSTEMS?.split(",").map((s) => s.trim()).filter(Boolean);

interface Facts {
	lectures: { course: string; date: string; topic: string; term: string; note: string; transcript?: { said: string; at: string } }[];
	decisions: { q: string; answer: string; date: string; note: string }[];
	people: string[];
	daily: {
		messy: { note: string; date: string; topic: string; phrase: string }[];
		snippets: { note: string; date: string; lang: string; key: string }[];
	};
}

/** Where an answer lives: a note, and optionally the character span of the section inside it. */
interface Gold {
	path: string;
	span?: [number, number];
}

interface Query {
	set: string;
	q: string;
	gold: Gold[];
}

/** One ranked result from any system: a note, and for passage systems the passage text. */
export interface Ranked {
	path: string;
	text?: string;
	score?: number;
}

type System = (query: string, k: number) => Promise<Ranked[]>;

function loadVault(dir: string): FakeVault {
	const vault = new FakeVault();
	const walk = (d: string) => {
		for (const name of readdirSync(d).sort()) {
			const p = join(d, name);
			if (statSync(p).isDirectory()) walk(p);
			else if (name.endsWith(".md")) vault.seed(relative(dir, p).replace(/\\/g, "/"), readFileSync(p, "utf8"));
		}
	};
	walk(dir);
	return vault;
}

/** The span of the `## <heading>` section in a note: from its heading line to the next heading of the same or a higher level. */
function sectionSpan(content: string, heading: string, level = 2): [number, number] | undefined {
	const marker = `${"#".repeat(level)} ${heading}`;
	let start = content.indexOf(`\n${marker}\n`);
	if (start < 0 && content.startsWith(`${marker}\n`)) start = -1;
	else if (start < 0) return undefined;
	start += 1;
	const rest = content.slice(start + marker.length);
	const next = rest.search(new RegExp(`\\n#{1,${level}} `));
	return [start, next < 0 ? content.length : start + marker.length + next];
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
function spokenDate(iso: string): string {
	const [, m, d] = iso.split("-").map(Number);
	return `${MONTHS[m - 1]} ${d}`;
}

async function buildQueries(vault: FakeVault, facts: Facts): Promise<Query[]> {
	const out: Query[] = [];
	const content = new Map<string, string>();
	const read = async (p: string) => content.get(p) ?? (content.set(p, await vault.read(p)), content.get(p)!);

	for (const l of facts.lectures) {
		const span = sectionSpan(await read(l.note), l.date);
		if (!span) continue;
		const gold = [{ path: l.note, span }];
		out.push({ set: "lecture-term", q: `What did the lecture say about ${l.term}?`, gold });
		out.push({ set: "lecture-topic", q: `lecture notes on ${l.topic.toLowerCase()}`, gold });
		out.push({ set: "lecture-date", q: `What was covered in ${l.course} on ${spokenDate(l.date)}?`, gold });
	}
	const said: Record<string, string> = {
		"2026-10-08": "how fast is Dijkstra with a binary heap according to the professor",
		"2026-11-06": "what contamination value did the anomaly detection demo use",
	};
	for (const l of facts.lectures.filter((x) => x.transcript)) {
		const span = sectionSpan(await read(l.note), l.date);
		if (span && said[l.date]) out.push({ set: "transcript", q: said[l.date], gold: [{ path: l.note, span }] });
	}
	for (const m of facts.daily.messy) {
		out.push({ set: "daily-topic", q: `my notes about ${m.topic}`, gold: [{ path: m.note }] });
		out.push({ set: "exact-phrase", q: m.phrase, gold: [{ path: m.note }] });
	}
	for (const s of facts.daily.snippets) out.push({ set: "exact-code", q: `the ${s.lang} snippet with ${s.key}`, gold: [{ path: s.note }] });
	for (const p of facts.people) if (vault.exists(`People/${p}.md`)) out.push({ set: "person", q: `Who is ${p}?`, gold: [{ path: `People/${p}.md` }] });

	// Written by hand against the vault's hand-written notes: the wording avoids the notes' own words where it can.
	const concept: [string, string[]][] = [
		["why did the chess robot move to a higher supply voltage", ["Projects/Chess Robot.md", "Daily/2026-10-14.md"]],
		["how fast are the board sensors polled and why not faster", ["Projects/Hall Sensors.md"]],
		["ideas to stop the electromagnet pulling the pieces next to it", ["Ideas/Magnet shielding.md", "Projects/Chess Robot.md"]],
		["what network does my chess engine use to evaluate positions", ["Projects/Kirin Engine.md", "Projects/NNUE Training.md"]],
		["how much stronger did the engine get in October", ["Projects/Kirin Engine.md"]],
		["pruning techniques used in the engine's search", ["Projects/Kirin Engine.md", "Research/Late move reductions.md"]],
		["which chips detect where the pieces are", ["Projects/Hall Sensors.md", "Projects/Chess Robot.md", "Research/A3144 datasheet notes.md"]],
		["how often does the gantry recalibrate its position", ["Projects/Chess Robot.md"]],
		["who helped me put the robot frame together", ["Projects/Chess Robot.md", "People/Marcus Vale.md"]],
		["what is left to do on the chess engine", ["Projects/Kirin Engine.md"]],
		["avoiding false readings from the square sensors", ["Projects/Hall Sensors.md"]],
		["resistor value on the shift register inputs", ["Projects/Hall Sensors.md"]],
	];
	for (const [q, paths] of concept) {
		const gold = paths.filter((p) => vault.exists(p)).map((path) => ({ path }));
		if (gold.length) out.push({ set: "concept", q, gold });
	}
	return out;
}

/** Questions the vault has no answer to: a good search gives these a visibly lower score. */
const UNANSWERABLE = [
	"how do I renew my driver's license",
	"notes on the French Revolution",
	"my marathon training plan",
	"what did I write about scuba diving",
	"kubernetes cluster upgrade procedure",
	"tax deduction for a home office",
	"how to tune a guitar",
	"symptoms of altitude sickness",
	"my dentist's phone number",
	"notes on Roman architecture",
	"mortgage interest rate comparison",
	"visa requirements for Japan",
	"how volcanoes form",
	"horse riding lesson schedule",
	"stock portfolio allocation",
];

function isHit(r: Ranked, gold: Gold[], note: (p: string) => string, passageLevel: boolean): boolean {
	for (const g of gold) {
		if (r.path !== g.path) continue;
		if (!passageLevel || !g.span || r.text === undefined) return true;
		const content = note(r.path);
		const needle = content.includes(r.text) ? r.text : r.text.split("\n\n")[0];
		for (let i = content.indexOf(needle); i >= 0; i = content.indexOf(needle, i + 1)) {
			if (i >= g.span[0] && i < g.span[1]) return true;
		}
	}
	return false;
}

/** The best similarity among the results: what a search can show the model as "how relevant is the best of these". */
function topScore(ranked: Ranked[]): number | undefined {
	const scores = ranked.map((r) => r.score).filter((s): s is number => s !== undefined);
	return scores.length ? Math.max(...scores) : undefined;
}

interface Separation {
	auc: number;
	answerableMedian: number;
	unanswerableMedian: number;
	cut: number;
	answerableAboveCut: number;
	unanswerableBelowCut: number;
	unanswerableMax: number;
	answerableMin: number;
}

interface Score {
	n: number;
	hit1: number;
	hit3: number;
	hitK: number;
	mrr: number;
	/** Passage systems only: the right note is among the results, wherever in it the passage is. */
	noteHitK: number;
}

function pct(n: number, d: number): number {
	return d ? Math.round((1000 * n) / d) / 10 : 0;
}

async function main() {
	const root = resolve(process.cwd(), VAULT_DIR);
	const factsFile = process.env.FACTS ?? join(process.cwd(), "scripts", basename(root) === "test-vault-large" ? "large-facts.json" : `large-facts-${basename(root)}.json`);
	const facts = JSON.parse(readFileSync(factsFile, "utf8")) as Facts;
	const vault = loadVault(root);
	const client = new OllamaClient(() => OLLAMA_URL);
	const notes = new Map<string, string>();
	for (const n of vault.listNotes()) notes.set(n.path, await vault.read(n.path));
	const noteText = (p: string) => notes.get(p) ?? "";

	// The index is kept between runs while the vault, the embedding model and the code that
	// decides what is embedded are unchanged, so trying another ranking costs no re-embedding.
	const h = createHash("sha1");
	h.update(EMBED);
	h.update(readFileSync(__filename)); // the bundle: any change to the code builds the index again
	for (const [p, c] of notes) h.update(p).update(c);
	const cacheFile = join(process.cwd(), ".e2e", `retrieval-index-${h.digest("hex").slice(0, 16)}.json`);
	let saved: IndexData | null = existsSync(cacheFile) ? (JSON.parse(readFileSync(cacheFile, "utf8")) as IndexData) : null;
	const cached = saved !== null;
	const index = new SemanticIndex(client, vault, { load: async () => saved, save: async (d) => void (saved = d) }, {
		getModel: () => EMBED,
		isEnabled: () => true,
		shouldIndex: (p) => !p.startsWith("Templates/"),
		now: () => NOW,
	});
	let t = Date.now();
	await index.load();
	await index.syncAll();
	const st = index.status();
	if (st.lastError || st.indexedFiles === 0) throw new Error(`index not built: ${st.lastError ?? "0 notes indexed"} (is Ollama running with ${EMBED}?)`);
	const indexSeconds = (Date.now() - t) / 1000;
	if (!cached) {
		await index.flush();
		mkdirSync(join(process.cwd(), ".e2e"), { recursive: true });
		if (saved) writeFileSync(cacheFile, JSON.stringify(saved));
	}
	console.log(`Index: ${st.indexedFiles} notes, ${st.totalChunks} chunks in ${indexSeconds.toFixed(1)} s${cached ? " (cached vectors)" : ""}; embedding model ${EMBED}`);

	const systems: Record<string, { passages: boolean; run: System }> = {
		// Embeddings only: what search_passages gave the model before 0.9.0.
		"passages-nodates": { passages: true, run: async (q, k) => index.searchPassages(q, k, 3, undefined, { dates: false }) },
		"passages-dense": { passages: true, run: async (q, k) => index.searchPassages(q, k, 3, undefined, { lexical: false }) },
		// What search_passages gives the model today: embeddings and word matching, fused.
		passages: { passages: true, run: async (q, k) => index.searchPassages(q, k) },
		// The semantic half of search_notes.
		"notes-semantic": { passages: false, run: async (q, k) => index.search(q, k) },
		"notes-keyword": { passages: false, run: async (q, k) => keywordSearch(vault, q, k) },
		// What search_notes gives the model today (main.ts hybridSearch).
		"notes-hybrid": {
			passages: false,
			run: async (q, k) => fuseRankings([await index.search(q, k * 2), await keywordSearch(vault, q, k * 2)], k),
		},
	};
	// Variants for tuning: VARIANTS="rrf,blend0.2,blend0.6,rrf2" (fusion and the say of word matching).
	for (const v of (process.env.VARIANTS ?? "").split(",").map((x) => x.trim()).filter(Boolean)) {
		const m = /^(rrf|blend)([0-9.]*)(?:\+c([0-9.]+))?$/.exec(v);
		if (!m) throw new Error(`unknown variant ${v}`);
		const fusion = m[1] as "rrf" | "blend";
		const lexWeight = m[2] ? Number(m[2]) : undefined;
		systems[`passages ${v}`] = { passages: true, run: async (q, k) => index.searchPassages(q, k, 3, undefined, { fusion, lexWeight, coverBonus: m[3] ? Number(m[3]) : undefined }) };
	}

	if (process.env.DEBUG_Q) {
		// One question through every system, to see what each returns.
		for (const [name, sys] of Object.entries(systems)) {
			if (ONLY_SYSTEMS && !ONLY_SYSTEMS.includes(name)) continue;
			console.log(`\n== ${name}`);
			for (const r of await sys.run(process.env.DEBUG_Q, K)) console.log(`  ${(r.score ?? 0).toFixed(3)} ${r.path} :: ${(r.text ?? "").slice(0, 70).replace(/\s+/g, " ")}`);
		}
		return;
	}
	const queries = await buildQueries(vault, facts);
	const sets = Array.from(new Set(queries.map((q) => q.set)));
	console.log(`${queries.length} questions in ${sets.length} sets (${sets.map((s) => `${s} ${queries.filter((q) => q.set === s).length}`).join(", ")}), ${UNANSWERABLE.length} with no answer; top ${K}`);

	const results: Record<string, { sets: Record<string, Score>; all: Score; msPerQuery: number; separation?: Separation }> = {};
	const misses: Record<string, { set: string; q: string; got: string[] }[]> = {};
	for (const [name, sys] of Object.entries(systems)) {
		if (ONLY_SYSTEMS && !ONLY_SYSTEMS.includes(name)) continue;
		const bySet: Record<string, Score> = {};
		const all: Score = { n: 0, hit1: 0, hit3: 0, hitK: 0, mrr: 0, noteHitK: 0 };
		const answerableTop: number[] = [];
		misses[name] = [];
		t = Date.now();
		for (const query of queries) {
			const ranked = await sys.run(query.q, K);
			const rank = ranked.findIndex((r) => isHit(r, query.gold, noteText, sys.passages));
			const noteRank = ranked.findIndex((r) => isHit(r, query.gold, noteText, false));
			const s = (bySet[query.set] ??= { n: 0, hit1: 0, hit3: 0, hitK: 0, mrr: 0, noteHitK: 0 });
			for (const acc of [s, all]) {
				acc.n++;
				if (rank === 0) acc.hit1++;
				if (rank >= 0 && rank < 3) acc.hit3++;
				if (rank >= 0) acc.hitK++;
				if (rank >= 0) acc.mrr += 1 / (rank + 1);
				if (noteRank >= 0) acc.noteHitK++;
			}
			if (rank < 0) misses[name].push({ set: query.set, q: query.q, got: ranked.slice(0, 3).map((r) => r.path) });
			const best = topScore(ranked);
			if (best !== undefined) answerableTop.push(best);
		}
		const msPerQuery = (Date.now() - t) / queries.length;
		// Can the top score tell an answerable question from one the vault cannot answer?
		let separation: Separation | undefined;
		if (answerableTop.length === queries.length) {
			const none: number[] = [];
			for (const q of UNANSWERABLE) {
				const top = topScore(await sys.run(q, K));
				if (top !== undefined) none.push(top);
			}
			if (none.length === UNANSWERABLE.length) {
				let wins = 0;
				for (const a of answerableTop) for (const u of none) wins += a > u ? 1 : a === u ? 0.5 : 0;
				const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
				// The score below which "nothing relevant" is the better call: the cut that is right most often, both kinds weighted equally.
				let cut = 0;
				let bestAcc = 0;
				for (const c of [...answerableTop, ...none]) {
					const acc = (answerableTop.filter((a) => a >= c).length / answerableTop.length + none.filter((u) => u < c).length / none.length) / 2;
					if (acc > bestAcc) [bestAcc, cut] = [acc, c];
				}
				separation = {
					auc: Math.round((1000 * wins) / (answerableTop.length * none.length)) / 1000,
					answerableMedian: Number(median(answerableTop).toFixed(3)),
					unanswerableMedian: Number(median(none).toFixed(3)),
					cut: Number(cut.toFixed(3)),
					answerableAboveCut: pct(answerableTop.filter((a) => a >= cut).length, answerableTop.length),
					unanswerableBelowCut: pct(none.filter((u) => u < cut).length, none.length),
					unanswerableMax: Number(Math.max(...none).toFixed(3)),
					answerableMin: Number(Math.min(...answerableTop).toFixed(3)),
				};
			}
		}
		results[name] = { sets: bySet, all, msPerQuery: Math.round(msPerQuery * 10) / 10, separation };
	}

	const names = Object.keys(results);
	console.log(`\n| System | Hit@1 | Hit@3 | Hit@${K} | MRR | Note in top ${K} | ms/query | Answerable vs not (AUC) |`);
	console.log("|---|---:|---:|---:|---:|---:|---:|---:|");
	for (const n of names) {
		const a = results[n].all;
		console.log(`| ${n} | ${pct(a.hit1, a.n)}% | ${pct(a.hit3, a.n)}% | ${pct(a.hitK, a.n)}% | ${(a.mrr / a.n).toFixed(3)} | ${pct(a.noteHitK, a.n)}% | ${results[n].msPerQuery} | ${results[n].separation?.auc ?? ""} |`);
	}
	console.log(`\nHit@${K} by question set:\n`);
	console.log(`| System | ${sets.join(" | ")} |`);
	console.log(`|---|${sets.map(() => "---:").join("|")}|`);
	for (const n of names) console.log(`| ${n} | ${sets.map((s) => `${pct(results[n].sets[s]?.hitK ?? 0, results[n].sets[s]?.n ?? 0)}%`).join(" | ")} |`);
	console.log(`\nHit@1 by question set:\n`);
	console.log(`| System | ${sets.join(" | ")} |`);
	console.log(`|---|${sets.map(() => "---:").join("|")}|`);
	for (const n of names) console.log(`| ${n} | ${sets.map((s) => `${pct(results[n].sets[s]?.hit1 ?? 0, results[n].sets[s]?.n ?? 0)}%`).join(" | ")} |`);

	const version = (JSON.parse(readFileSync(join(process.cwd(), "manifest.json"), "utf8")) as { version: string }).version;
	mkdirSync(join(process.cwd(), "bench"), { recursive: true });
	const file = join(process.cwd(), "bench", `retrieval-${version}${TAG ? `-${TAG}` : ""}.json`);
	writeFileSync(
		file,
		JSON.stringify({ version, tag: TAG, embed: EMBED, k: K, vault: { dir: VAULT_DIR, notes: st.indexedFiles, chunks: st.totalChunks }, questions: queries.length, unanswerable: UNANSWERABLE.length, results, misses }, null, 2) + "\n",
	);
	console.log(`\nsaved ${relative(process.cwd(), file)}`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
