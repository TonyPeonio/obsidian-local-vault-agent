// Renders bench/*.json (written by `npm run e2e:large`) as markdown for the README.
//
//   node scripts/bench-table.mjs bench/0.4.1-baseline.json bench/0.5.0.json
//
// One file: a per-scenario table. Two files: a before/after comparison of the totals and of
// every scenario that changed by more than a little.
import { readFileSync } from "fs";

const files = process.argv.slice(2);
if (files.length === 0) {
	console.error("usage: node scripts/bench-table.mjs <result.json> [previous.json]");
	process.exit(1);
}
const runs = files.map((f) => JSON.parse(readFileSync(f, "utf8")));
const fmtS = (s) => `${Math.round(s)} s`;

function scenarioTable(run) {
	const rows = ["| Scenario | Seconds | Calls | Errors | Guessed paths | Repeats | Checks |", "|---|---:|---:|---:|---:|---:|---:|"];
	for (const r of run.scenarios) rows.push(`| ${r.id} | ${r.seconds.toFixed(1)} | ${r.calls} | ${r.errors} | ${r.misses} | ${r.repeats} | ${r.pass}/${r.pass + r.fail} |`);
	const t = run.totals;
	rows.push(`| **total** | **${t.seconds}** | **${t.calls}** | **${t.errors}** | **${t.misses}** | **${t.repeats}** | **${t.passed}/${t.checks}** |`);
	return rows.join("\n");
}

function header(run) {
	return `Version ${run.version}, ${run.model}, ${Math.round(run.numCtx / 1024)}k context, thinking ${run.think}, ${run.notes} notes, ${run.date.slice(0, 10)}.`;
}

if (runs.length === 1) {
	console.log(header(runs[0]));
	console.log();
	console.log(scenarioTable(runs[0]));
} else {
	const [before, after] = runs;
	console.log(`Before: ${header(before)}\nAfter: ${header(after)}\n`);
	console.log("| | Before | After |", "\n|---|---:|---:|");
	console.log(`| Checks passed | ${before.totals.passed}/${before.totals.checks} | ${after.totals.passed}/${after.totals.checks} |`);
	console.log(`| Wall time | ${fmtS(before.totals.seconds)} | ${fmtS(after.totals.seconds)} |`);
	console.log(`| Tool calls | ${before.totals.calls} | ${after.totals.calls} |`);
	console.log(`| Tool errors | ${before.totals.errors} | ${after.totals.errors} |`);
	console.log(`| Guessed paths | ${before.totals.misses} | ${after.totals.misses} |`);
	console.log(`| Repeated calls | ${before.totals.repeats} | ${after.totals.repeats} |`);
	console.log();
	console.log("| Scenario | Seconds | Calls | Checks |", "\n|---|---:|---:|---:|");
	for (const a of after.scenarios) {
		const b = before.scenarios.find((s) => s.id === a.id);
		if (!b) {
			console.log(`| ${a.id} (new) | ${a.seconds.toFixed(0)} | ${a.calls} | ${a.pass}/${a.pass + a.fail} |`);
			continue;
		}
		console.log(`| ${a.id} | ${b.seconds.toFixed(0)} → ${a.seconds.toFixed(0)} | ${b.calls} → ${a.calls} | ${b.pass}/${b.pass + b.fail} → ${a.pass}/${a.pass + a.fail} |`);
	}
}
