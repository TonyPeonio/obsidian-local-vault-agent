import { execFileSync } from "child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join, relative } from "path";
import { afterAll, describe, expect, it } from "vitest";

// The benchmark vault generator must be deterministic (runs are only comparable when the vault
// is identical) and SCALE must only add notes, never change the ones the facts describe.
const script = join(__dirname, "..", "scripts", "make-vault.mjs");
const tmp = mkdtempSync(join(tmpdir(), "make-vault-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function generate(name: string, scale: number): Map<string, string> {
	const out = join(tmp, name);
	execFileSync(process.execPath, [script], { env: { ...process.env, OUT: out, SCALE: String(scale), FACTS: join(tmp, `${name}-facts.json`) }, stdio: "pipe" });
	const files = new Map<string, string>();
	const walk = (d: string) => {
		for (const f of readdirSync(d)) {
			const p = join(d, f);
			if (statSync(p).isDirectory()) walk(p);
			else files.set(relative(out, p).replace(/\\/g, "/"), readFileSync(p, "utf8"));
		}
	};
	walk(out);
	return files;
}

describe("make-vault.mjs", () => {
	it("is deterministic and SCALE only adds filler in its own folders", () => {
		const a = generate("a", 2);
		const b = generate("b", 2);
		expect(a.size).toBeGreaterThan(600);
		expect([...a.keys()].sort()).toEqual([...b.keys()].sort());
		for (const [p, c] of a) expect(b.get(p), p).toBe(c);

		const base = generate("base", 1);
		expect(a.size - base.size).toBe(330);
		for (const [p, c] of base) expect(a.get(p), p).toBe(c);
		const filler = [...a.keys()].filter((p) => !base.has(p));
		expect(filler.every((p) => /^(Zettel|Library|Archive\/2024)\//.test(p))).toBe(true);
		// Filler links resolve to other filler notes, so the gardener finds no new broken links.
		const names = new Set(filler.map((p) => p.split("/").pop()!.replace(/\.md$/, "")));
		for (const p of filler) {
			for (const m of a.get(p)!.matchAll(/\[\[([^\]|#]+)/g)) expect(names.has(m[1]), `${p} links to ${m[1]}`).toBe(true);
		}
		const facts = JSON.parse(readFileSync(join(tmp, "a-facts.json"), "utf8")) as { scale: number; counts: { filler: number } };
		expect(facts.scale).toBe(2);
		expect(facts.counts.filler).toBe(330);
	}, 60_000);
});
