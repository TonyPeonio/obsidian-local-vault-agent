import { execFileSync } from "child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = path.resolve(__dirname, "..", "version-bump.mjs");
const dirs: string[] = [];

/** Runs version-bump.mjs in a scratch folder holding a 0.8.0 release, as `npm version <target>` would. */
function bump(target: string) {
	const dir = mkdtempSync(path.join(tmpdir(), "lva-bump-"));
	dirs.push(dir);
	const manifest = JSON.stringify({ id: "local-vault-agent", version: "0.8.0", minAppVersion: "1.5.0" }, null, "\t") + "\n";
	writeFileSync(path.join(dir, "manifest.json"), manifest);
	writeFileSync(path.join(dir, "manifest-beta.json"), manifest);
	writeFileSync(path.join(dir, "versions.json"), JSON.stringify({ "0.8.0": "1.5.0" }, null, "\t") + "\n");
	copyFileSync(SCRIPT, path.join(dir, "version-bump.mjs"));
	// Windows environment names are case-insensitive, and npm sets this one for the test run itself.
	const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toLowerCase() !== "npm_package_version"));
	execFileSync(process.execPath, ["version-bump.mjs"], { cwd: dir, env: { ...env, npm_package_version: target } });
	const read = (name: string) => JSON.parse(readFileSync(path.join(dir, name), "utf8"));
	return { manifest: read("manifest.json"), beta: read("manifest-beta.json"), versions: read("versions.json") };
}

afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("version-bump.mjs", () => {
	it("writes a stable version to all three files", () => {
		const r = bump("0.9.0");
		expect(r.manifest.version).toBe("0.9.0");
		expect(r.beta.version).toBe("0.9.0");
		expect(r.versions).toEqual({ "0.8.0": "1.5.0", "0.9.0": "1.5.0" });
	});

	it("writes a beta version only to manifest-beta.json, never to what the community store reads", () => {
		const r = bump("0.9.0-beta.1");
		expect(r.beta.version).toBe("0.9.0-beta.1");
		expect(r.beta.minAppVersion).toBe("1.5.0");
		expect(r.manifest.version).toBe("0.8.0");
		expect(r.versions).toEqual({ "0.8.0": "1.5.0" });
	});
});
