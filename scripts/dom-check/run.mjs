/**
 * Runs the chat view's DOM code in a headless Chromium (Chrome or Edge, whichever is installed)
 * against a scripted agent and a stand-in for Obsidian:
 *
 *   npm run e2e:dom
 *
 * Prints every check, writes a screenshot of the panels to .e2e/dom-check/panels.png, and exits
 * with 1 when a check fails. Without a browser it says so and exits with 0: it complements the unit
 * tests, it does not replace opening the plugin in Obsidian.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const out = join(root, ".e2e", "dom-check");

function findBrowser() {
	const candidates = [
		process.env.CHROME_PATH,
		"C:/Program Files/Google/Chrome/Application/chrome.exe",
		"C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
		"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
		"C:/Program Files/Microsoft/Edge/Application/msedge.exe",
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
		"/usr/bin/google-chrome",
		"/usr/bin/chromium",
		"/usr/bin/chromium-browser",
	];
	return candidates.find((p) => p && existsSync(p)) ?? null;
}

/** The few Obsidian theme variables the plugin's stylesheet uses, with light-theme values. */
const THEME = `
:root {
	--background-primary: #ffffff; --background-secondary: #f6f6f6; --background-modifier-border: #e0e0e0;
	--background-modifier-hover: #ececec; --background-modifier-error: #e93147;
	--interactive-accent: #7c5cff; --text-on-accent: #ffffff; --text-accent: #6a4cf0;
	--text-normal: #222222; --text-muted: #5c5c5c; --text-faint: #9a9a9a; --text-warning: #c47a00; --text-success: #08a045;
	--font-ui-small: 13px; --font-ui-smaller: 12px; --radius-s: 4px; --radius-m: 8px; --shadow-s: 0 1px 4px rgba(0,0,0,.2);
	--size-4-1: 4px; --size-4-2: 8px; --p-spacing: 1rem;
}
body { margin: 0; font: 14px/1.4 system-ui, sans-serif; color: var(--text-normal); background: #d9d9de; }
#gallery { display: flex; flex-wrap: wrap; gap: 16px; padding: 16px; align-items: flex-start; }
.cell-title { font-size: 12px; margin-bottom: 4px; color: #333; }
.panel { width: 420px; height: 560px; background: var(--background-primary); border: 1px solid #bbb; }
.view-content { height: 100%; }
button { font: inherit; border: 1px solid var(--background-modifier-border); border-radius: var(--radius-s); background: var(--background-primary); }
button.mod-cta { background: var(--interactive-accent); color: var(--text-on-accent); border-color: transparent; }
.clickable-icon { border: none; background: transparent; padding: 4px 6px; }
textarea { font: inherit; border: 1px solid var(--background-modifier-border); border-radius: var(--radius-s); padding: 6px 8px; }
pre { background: var(--background-secondary); padding: 6px; border-radius: var(--radius-s); }
table { border-collapse: collapse; } td { border: 1px solid var(--background-modifier-border); padding: 2px 6px; }
`;

async function build() {
	const result = await esbuild.build({
		entryPoints: [join(here, "harness.ts")],
		bundle: true,
		format: "iife",
		platform: "browser",
		target: "es2022",
		write: false,
		logLevel: "warning",
		alias: { obsidian: join(here, "obsidian-shim.ts") },
	});
	const js = result.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
	const css = readFileSync(join(root, "styles.css"), "utf8");
	mkdirSync(out, { recursive: true });
	const html = `<!doctype html><html><head><meta charset="utf-8"><title>Local Vault Agent: DOM check</title><style>${THEME}</style><style>${css}</style></head><body><div id="gallery"></div><script>${js}</script></body></html>`;
	const file = join(out, "index.html");
	writeFileSync(file, html);
	return file;
}

/** A minimal Chrome DevTools Protocol client over the page's WebSocket. */
function connect(url) {
	return new Promise((resolveSocket, reject) => {
		const ws = new WebSocket(url);
		let next = 1;
		const waiting = new Map();
		/** Errors the page threw outside of what was evaluated (a script that failed to load, say). */
		const thrown = [];
		ws.addEventListener("open", () =>
			resolveSocket({
				send(method, params = {}) {
					const id = next++;
					ws.send(JSON.stringify({ id, method, params }));
					return new Promise((res, rej) => waiting.set(id, { res, rej }));
				},
				close: () => ws.close(),
				thrown,
			}),
		);
		ws.addEventListener("message", (e) => {
			const msg = JSON.parse(typeof e.data === "string" ? e.data : "{}");
			if (msg.method === "Runtime.exceptionThrown") thrown.push(msg.params?.exceptionDetails?.exception?.description ?? msg.params?.exceptionDetails?.text ?? "unknown error");
			const w = waiting.get(msg.id);
			if (!w) return;
			waiting.delete(msg.id);
			if (msg.error) w.rej(new Error(msg.error.message));
			else w.res(msg.result);
		});
		ws.addEventListener("error", () => reject(new Error("could not connect to the browser")));
	});
}

async function main() {
	const browser = findBrowser();
	if (!browser) {
		console.log("DOM check skipped: no Chrome or Edge found (set CHROME_PATH to run it).");
		return 0;
	}
	const page = await build();
	const profile = join(out, "profile");
	rmSync(profile, { recursive: true, force: true });
	const port = 9300 + Math.floor(Math.random() * 500);
	// --disable-gpu: frames are drawn in software, so they keep coming when the graphics card is busy
	// (running a model, say); with the GPU compositor the page then gets no animation frames at all,
	// and scroll events come with frames.
	const child = spawn(
		browser,
		["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-gpu", "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--window-size=1340,1240", pathToFileURL(page).href],
		{ stdio: "ignore" },
	);
	let code = 1;
	try {
		let target = null;
		for (let i = 0; i < 100 && !target; i++) {
			await new Promise((r) => setTimeout(r, 200));
			try {
				const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
				target = list.find((t) => t.type === "page" && t.url.startsWith("file:")) ?? null;
			} catch {
				// not up yet
			}
		}
		if (!target) throw new Error("the browser did not open the page");
		const cdp = await connect(target.webSocketDebuggerUrl);
		await cdp.send("Runtime.enable");
		// The page must count as visible and focused: a hidden page does not paint, and scroll events come with painting.
		await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
		// The page's script may still be loading.
		let ready = false;
		for (let i = 0; i < 100 && !ready; i++) {
			ready = (await cdp.send("Runtime.evaluate", { expression: "typeof window.__run === 'function'", returnByValue: true })).result.value === true;
			if (!ready) await new Promise((r) => setTimeout(r, 100));
		}
		if (!ready) throw new Error(`the page did not load its script${cdp.thrown.length ? `: ${cdp.thrown.join("; ")}` : ""}`);
		const started = Date.now();
		const evaluated = await cdp.send("Runtime.evaluate", { expression: "window.__run()", awaitPromise: true, returnByValue: true });
		if (evaluated.exceptionDetails) throw new Error(`the page threw: ${evaluated.exceptionDetails.exception?.description ?? evaluated.exceptionDetails.text}`);
		const { results, numbers, error } = evaluated.result.value;
		let current = "";
		for (const r of results) {
			if (r.scenario !== current) console.log(`\n${(current = r.scenario)}`);
			console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.check}${r.ok || !r.detail ? "" : `\n        ${r.detail}`}`);
		}
		console.log("");
		for (const [k, v] of Object.entries(numbers)) console.log(`${k}: ${v}`);
		if (error) console.log(`\nSTOPPED EARLY: ${error}`);
		const shot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
		writeFileSync(join(out, "panels.png"), Buffer.from(shot.data, "base64"));
		const failed = results.filter((r) => !r.ok).length;
		console.log(`\n${results.length - failed} of ${results.length} checks passed in ${((Date.now() - started) / 1000).toFixed(1)} s (${browser.split(/[\\/]/).pop()}). Screenshot: ${join(out, "panels.png")}`);
		code = failed === 0 && !error ? 0 : 1;
		cdp.close();
	} finally {
		child.kill();
	}
	return code;
}

main().then(
	(code) => process.exit(code),
	(err) => {
		console.error(`DOM check failed to run: ${err?.message ?? err}`);
		process.exit(1);
	},
);
