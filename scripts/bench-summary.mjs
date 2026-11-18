// Summarises repeated benchmark runs: one row per configuration with the median and the spread,
// which scenarios lose checks and how often, and which checks fail most. Identical runs differ
// (the model samples), so one run says little; five say what a change did.
//
//   node scripts/bench-summary.mjs bench/0.8.0-base-*.json bench/0.9.0-base-*.json
//   node scripts/bench-summary.mjs --scenarios bench/0.9.0-base-*.json     # per-scenario table too
//
// Runs are grouped by version and tag, with a trailing "-<n>" (the run number) removed.
import { readFileSync, readdirSync } from "fs";
import { basename, dirname, join } from "path";

const args = process.argv.slice(2);
const wantScenarios = args.includes("--scenarios");
const files = args.filter((a) => !a.startsWith("--")).flatMap(expand);
if (files.length === 0) {
	console.error("usage: node scripts/bench-summary.mjs [--scenarios] <result.json or pattern with *> ...");
	process.exit(1);
}

/** Shells on Windows do not expand `*`: do it here for the file name part. */
function expand(pattern) {
	if (!pattern.includes("*")) return [pattern];
	const dir = dirname(pattern);
	const re = new RegExp("^" + basename(pattern).split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
	return readdirSync(dir).filter((f) => re.test(f)).sort().map((f) => join(dir, f));
}

const median = (xs) => {
	const s = [...xs].sort((a, b) => a - b);
	return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const round = (n, d = 0) => Math.round(n * 10 ** d) / 10 ** d;
const spread = (xs, d = 0) => (xs.length === 1 ? `${round(xs[0], d)}` : `${round(median(xs), d)} (${round(Math.min(...xs), d)}–${round(Math.max(...xs), d)})`);

const groups = new Map();
for (const file of files) {
	const r = JSON.parse(readFileSync(file, "utf8"));
	if (!r.totals || !r.scenarios) continue; // not an accuracy run (a retrieval or scale result)
	const tag = String(r.tag ?? "").replace(/-\d+$/, "");
	const key = `${r.version}${tag ? ` ${tag}` : ""} · ${r.model}${r.numCtx && r.numCtx !== 32768 ? ` · ${Math.round(r.numCtx / 1024)}k` : ""}`;
	if (!groups.has(key)) groups.set(key, []);
	groups.get(key).push({ file, ...r });
}

// What the same run would cost on a laptop without a discrete GPU, from this run's own counts:
// the tokens the model had to read (the time Ollama spent reading prompts on this machine, at
// this machine's reading speed) and the tokens it wrote, at the README's laptop figures
// (Ryzen 7940HS / Radeon 780M, qwen3.5:9b: reads about 170 tokens/s, writes about 6.5).
// READ_TOKENS_PER_MS is this desktop's reading speed (RTX 5070: 12,977 tokens in 2,955 ms).
const READ_TOKENS_PER_MS = Number(process.env.READ_TOKENS_PER_MS ?? 4.39);
/** Characters per token of what the agent sends (measured: the benchmark's prompts run at about 3.0). */
const CHARS_PER_TOKEN = Number(process.env.CHARS_PER_TOKEN ?? 3.0);
/** Tokens the model had to read: counted by the harness when the result has it (free of the machine's load), else from the time spent reading. */
const readTokens = (r) => {
	const chars = r.scenarios.reduce((n, s) => n + (s.readChars ?? 0), 0);
	if (chars) return chars / CHARS_PER_TOKEN;
	return r.scenarios.reduce((n, s) => n + (s.promptMs ?? 0), 0) * READ_TOKENS_PER_MS;
};
const laptopSeconds = (r) => {
	const written = r.scenarios.reduce((n, s) => n + (s.completionTokens ?? 0), 0);
	return written ? readTokens(r) / 170 + written / 6.5 : undefined;
};

console.log("| Configuration | Runs | Checks passed | Seconds | Model s | Model calls | Tool calls | Tokens read | Tokens written | Laptop estimate, min | Errors | Repeats |");
console.log("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
for (const [key, runs] of groups) {
	const t = (f) => runs.map((r) => f(r.totals));
	const checks = runs[0].totals.checks;
	const sameChecks = runs.every((r) => r.totals.checks === checks);
	const out = runs.map((r) => r.scenarios.reduce((n, s) => n + (s.completionTokens ?? 0), 0));
	console.log(
		`| ${key} | ${runs.length} | ${spread(t((x) => x.passed), 1)} of ${sameChecks ? checks : "varying"} | ${spread(t((x) => x.seconds))} | ${spread(t((x) => x.modelSeconds ?? 0))} | ${spread(t((x) => x.steps ?? 0))} | ${spread(t((x) => x.calls))} | ${runs.every((r) => r.scenarios.some((s) => s.readChars)) ? spread(runs.map(readTokens)) : ""} | ${out.some(Boolean) ? spread(out) : ""} | ${runs.every((r) => laptopSeconds(r)) ? spread(runs.map((r) => laptopSeconds(r) / 60), 1) : ""} | ${spread(t((x) => x.errors), 1)} | ${spread(t((x) => x.repeats), 1)} |`,
	);
}

for (const [key, runs] of groups) {
	// Which checks fail, and in how many of the runs. Older result files have no labels.
	const labelled = runs.filter((r) => Array.isArray(r.failed));
	if (labelled.length) {
		const count = new Map();
		for (const r of labelled) for (const f of new Set(r.failed.map((l) => l.replace(/\s*\([^)]*\)\s*$/, "")))) count.set(f, (count.get(f) ?? 0) + 1);
		const rows = [...count.entries()].sort((a, b) => b[1] - a[1]);
		console.log(`\n**${key}**: checks that failed, of ${labelled.length} run${labelled.length === 1 ? "" : "s"}${rows.length ? "" : ": none"}`);
		for (const [label, n] of rows) console.log(`- ${n}× ${label}`);
	}
	if (!wantScenarios) continue;
	const ids = runs[0].scenarios.map((s) => s.id);
	console.log(`\n**${key}**: by scenario\n`);
	console.log("| Scenario | Checks | Runs with a miss | Seconds | Model calls | Tool calls | Largest prompt |");
	console.log("|---|---:|---:|---:|---:|---:|---:|");
	for (const id of ids) {
		const ss = runs.map((r) => r.scenarios.find((s) => s.id === id)).filter((s) => s && !s.skipped);
		if (ss.length === 0) continue;
		const total = ss[0].pass + ss[0].fail;
		console.log(
			`| ${id} | ${spread(ss.map((s) => s.pass), 1)} of ${total} | ${ss.filter((s) => s.fail > 0).length} of ${ss.length} | ${spread(ss.map((s) => s.seconds ?? s.ms / 1000), 1)} | ${spread(ss.map((s) => s.steps ?? 0))} | ${spread(ss.map((s) => s.calls))} | ${spread(ss.map((s) => s.prompt))} |`,
		);
	}
}
