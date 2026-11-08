// Runs the benchmark for several configurations one after another and prints one table.
//
//   npm run bench-matrix                      # the default matrix below
//   npm run bench-matrix -- base,temp03       # only the named configs
//   RUNS=2 npm run bench-matrix               # each config twice (variance)
//
// Each run writes bench/<version>-<tag>[-<n>].json; the table reads those files back, so a
// matrix can be re-rendered later with the file names as arguments:
//   node scripts/bench-matrix.mjs --table bench/0.5.0-base-1.json bench/0.5.0-temp03-1.json
import { execFileSync, spawnSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

const MATRIX = {
	base: {}, // the plugin defaults (thinking off since 0.5.0)
	think: { THINK: "on" },
	temp03: { TEMPERATURE: "0.3", PRESENCE: "0" },
	ctx16: { NUM_CTX: "16384" },
	ctx64: { NUM_CTX: "65536" },
	gists: { GISTS: "1" },
	q4b: { MODEL: "qwen3.5:4b" },
	q14: { MODEL: "qwen3:14b" },
	big: { MODEL: "qwen3.5:35b-a3b" },
};

const args = process.argv.slice(2);
if (args[0] === "--table") {
	printTable(args.slice(1).map(load));
	process.exit(0);
}
const names = args[0] ? args[0].split(",") : Object.keys(MATRIX);
const runs = Number(process.env.RUNS ?? 1);
const version = JSON.parse(readFileSync("manifest.json", "utf8")).version;

execFileSync("npx", ["esbuild", "scripts/e2e-large.ts", "--bundle", "--platform=node", "--format=cjs", "--outfile=.e2e/e2e-large.cjs", "--log-level=warning"], { stdio: "inherit", shell: true });
if (!existsSync("test-vault-large")) execFileSync("node", ["scripts/make-vault.mjs"], { stdio: "inherit" });

const files = [];
for (const name of names) {
	const env = MATRIX[name];
	if (!env) {
		console.error(`unknown config "${name}"; known: ${Object.keys(MATRIX).join(", ")}`);
		process.exit(1);
	}
	for (let n = 1; n <= runs; n++) {
		const tag = runs > 1 ? `${name}-${n}` : name;
		console.log(`\n##### ${tag} ${JSON.stringify(env)}\n`);
		const t0 = Date.now();
		const r = spawnSync("node", [".e2e/e2e-large.cjs"], { stdio: "inherit", env: { ...process.env, ...env, TAG: tag } });
		console.log(`##### ${tag} finished in ${Math.round((Date.now() - t0) / 1000)} s (exit ${r.status})`);
		const file = join("bench", `${version}-${tag}.json`);
		if (existsSync(file)) files.push(file);
	}
}
printTable(files.map(load));

function load(file) {
	return { file, ...JSON.parse(readFileSync(file, "utf8")) };
}

function printTable(results) {
	console.log("\n| Config | Model | Think | Temp | Presence | Checks | Seconds | Model s | Steps | Calls | Errors | Guessed | Repeats |");
	console.log("|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
	for (const r of results) {
		const t = r.totals;
		console.log(
			`| ${r.tag || r.file} | ${r.model} | ${r.think} | ${r.temperature ?? ""} | ${r.presencePenalty ?? ""} | ${t.passed}/${t.checks} | ${t.seconds} | ${t.modelSeconds ?? ""} | ${t.steps ?? ""} | ${t.calls} | ${t.errors} | ${t.misses} | ${t.repeats} |`,
		);
	}
}
