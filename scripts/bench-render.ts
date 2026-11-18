/**
 * Micro benchmark for drawing an answer while it streams.
 *
 *   npm run bench:render
 *
 * Replays one answer arriving at a fixed speed against two policies:
 *   before: every 120 ms the whole answer so far is rendered again (what the chat did up to 0.8.0);
 *   after:  StreamRenderer: complete blocks once, only the block being written again, and a wait
 *           between renders that grows with the cost of the last one.
 * It counts what is handed to the markdown renderer (the figure that does not depend on the
 * machine) and times a stand-in renderer. Obsidian's own renderer is not available outside the
 * app, so the milliseconds are those of the stand-in below: they show the proportion, not what a
 * user's machine spends.
 */
import { StreamRenderer, nextRenderDelay, type BlockHost } from "../src/stream-blocks";

/** A deterministic answer of roughly `tokens` tokens: headings, paragraphs, lists, a table, code. */
export function sampleAnswer(tokens: number): string {
	const words = "the vault note links project sensor meeting plan budget review draft summary idea source daily topic folder answer question result".split(" ");
	let seed = 7;
	const word = () => {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff;
		return words[seed % words.length];
	};
	const sentence = (n: number) => {
		const w = Array.from({ length: n }, word);
		w[2] = `**${w[2]}**`;
		w[5] = `[[${w[5]}]]`;
		return `${w.join(" ")}.`;
	};
	const parts: string[] = [];
	let size = 0;
	let i = 0;
	while (size < tokens * 4) {
		const kind = i++ % 6;
		let part: string;
		if (kind === 0) part = `## ${sentence(5).replace(/[*[\].]/g, "")}`;
		else if (kind === 1 || kind === 4) part = [sentence(18), sentence(22), sentence(14)].join(" ");
		else if (kind === 2) part = Array.from({ length: 5 }, () => `- ${sentence(9)}`).join("\n");
		else if (kind === 3) part = ["```ts", "const total = items.reduce((sum, item) => sum + item.cost, 0);", "", "if (total > budget) warn(total);", "```"].join("\n");
		else part = ["| Note | Status | Owner |", "| --- | --- | --- |", ...Array.from({ length: 4 }, () => `| ${word()} | ${word()} | ${word()} |`)].join("\n");
		parts.push(part);
		size += part.length + 2;
	}
	return parts.join("\n\n");
}

/** A small markdown-to-tree renderer: enough work per character to time, nothing more. */
interface StandInNode {
	html: string;
}

function inline(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/\[\[([^\]]+)\]\]/g, '<a class="internal-link" data-href="$1">$1</a>')
		.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
		.replace(/`([^`]+)`/g, "<code>$1</code>")
		.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
}

export function standInRender(markdown: string): StandInNode[] {
	const out: StandInNode[] = [];
	const lines = markdown.split("\n");
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		if (!line.trim()) {
			i++;
		} else if (/^```/.test(line)) {
			const body: string[] = [];
			i++;
			while (i < lines.length && !/^```/.test(lines[i])) body.push(lines[i++]);
			i++;
			out.push({ html: `<pre><code>${body.join("\n").replace(/</g, "&lt;")}</code></pre>` });
		} else if (/^#{1,6} /.test(line)) {
			const level = /^#+/.exec(line)![0].length;
			out.push({ html: `<h${level}>${inline(line.replace(/^#+ /, ""))}</h${level}>` });
			i++;
		} else if (/^[-*+] |^\d+[.)] /.test(line)) {
			const items: string[] = [];
			while (i < lines.length && (/^[-*+] |^\d+[.)] /.test(lines[i]) || /^\s+\S/.test(lines[i]) || (!lines[i].trim() && /^(?:[-*+] |\d+[.)] |\s+\S)/.test(lines[i + 1] ?? "")))) {
				if (lines[i].trim()) items.push(`<li>${inline(lines[i].replace(/^(?:[-*+]|\d+[.)]) /, ""))}</li>`);
				i++;
			}
			out.push({ html: `<ul>${items.join("")}</ul>` });
		} else if (/^\|/.test(line)) {
			const rows: string[] = [];
			while (i < lines.length && /^\|/.test(lines[i])) {
				rows.push(`<tr>${lines[i].split("|").slice(1, -1).map((c) => `<td>${inline(c.trim())}</td>`).join("")}</tr>`);
				i++;
			}
			out.push({ html: `<table>${rows.join("")}</table>` });
		} else {
			const para: string[] = [];
			while (i < lines.length && lines[i].trim() && !/^(?:```|#{1,6} |[-*+] |\d+[.)] |\|)/.test(lines[i])) para.push(lines[i++]);
			out.push({ html: `<p>${inline(para.join("\n"))}</p>` });
		}
	}
	return out;
}

class TimedHost implements BlockHost<StandInNode> {
	screen: StandInNode[] = [];
	ms = 0;
	/** When set, a render is charged this many microseconds per character instead of what the stand-in took. */
	constructor(private modelledUsPerChar: number | null = null) {}
	lastMs = 0;
	async render(markdown: string): Promise<StandInNode[]> {
		const t0 = performance.now();
		const nodes = standInRender(markdown);
		this.lastMs = this.modelledUsPerChar === null ? performance.now() - t0 : (markdown.length * this.modelledUsPerChar) / 1000;
		this.ms += this.lastMs;
		return nodes;
	}
	append(nodes: StandInNode[]): void {
		this.screen.push(...nodes);
	}
	remove(nodes: StandInNode[]): void {
		const gone = new Set(nodes);
		this.screen = this.screen.filter((n) => !gone.has(n));
	}
	same(a: StandInNode, b: StandInNode): boolean {
		return a.html === b.html;
	}
}

export interface RunResult {
	policy: "before" | "after";
	renders: number;
	chars: number;
	renderMs: number;
	/** The longest single render, in characters. */
	maxChars: number;
	screenMatches: boolean;
}

/**
 * Replays `text` arriving as one four-character piece every `1000 / tokensPerSec` ms of simulated
 * time. `usPerChar` charges renders by size instead of timing the stand-in (to show the throttle).
 */
export async function replay(text: string, tokensPerSec: number, policy: "before" | "after", usPerChar: number | null = null): Promise<RunResult> {
	const host = new TimedHost(usPerChar);
	const renderer = new StreamRenderer(host);
	const pieceMs = 1000 / tokensPerSec;
	let renders = 0;
	let chars = 0;
	let maxChars = 0;
	/** Simulated time at which the pending render timer fires. */
	let timerAt: number | null = null;
	/** Simulated time at which the last render of the "after" policy ended, and what it cost. */
	let renderEnd = 0;
	let lastCost = 0;
	let content = "";
	let now = 0;
	for (let n = 0; n < text.length; n += 4, now += pieceMs) {
		// A timer that came due before this piece arrived draws what had arrived by then.
		if (timerAt !== null && timerAt <= now) {
			const fired = timerAt;
			timerAt = null;
			if (policy === "before") {
				await host.render(content);
				renders++;
				chars += content.length;
				maxChars = Math.max(maxChars, content.length);
			} else {
				const charsBefore = renderer.stats.chars;
				const msBefore = host.ms;
				await renderer.update(content);
				lastCost = host.ms - msBefore;
				renderEnd = fired + lastCost;
				maxChars = Math.max(maxChars, renderer.stats.chars - charsBefore);
			}
		}
		content = text.slice(0, n + 4);
		if (timerAt === null) timerAt = policy === "before" ? now + 120 : Math.max(now, renderEnd) + nextRenderDelay(lastCost);
	}
	// The finished answer: the pending timer is dropped and the whole text is drawn.
	if (policy === "before") {
		host.screen = await host.render(text);
		renders++;
		chars += text.length;
		maxChars = Math.max(maxChars, text.length);
	} else {
		await renderer.finish(text);
		renders = renderer.stats.renders;
		chars = renderer.stats.chars;
		maxChars = Math.max(maxChars, text.length);
	}
	const want = standInRender(text).map((n) => n.html).join("");
	return { policy, renders, chars, renderMs: host.ms, maxChars, screenMatches: host.screen.map((n) => n.html).join("") === want };
}

async function main(): Promise<void> {
	const rows: string[] = [];
	const out = (s: string) => {
		rows.push(s);
		process.stdout.write(`${s}\n`);
	};
	out("answer tokens | tok/s | policy | renders | chars rendered | stand-in ms | screen ok");
	out("--- | --- | --- | --- | --- | --- | ---");
	for (const tokens of [300, 1000, 4000]) {
		const text = sampleAnswer(tokens);
		for (const rate of [6.5, 40]) {
			// Warm up the JIT, then take the median of five timings; the counts are the same every time.
			await replay(text, rate, "before");
			await replay(text, rate, "after");
			for (const policy of ["before", "after"] as const) {
				const runs: RunResult[] = [];
				for (let i = 0; i < 5; i++) runs.push(await replay(text, rate, policy));
				const ms = runs.map((r) => r.renderMs).sort((a, b) => a - b)[2];
				const r = runs[0];
				out(`${tokens} (${text.length} chars) | ${rate} | ${policy} | ${r.renders} | ${r.chars} | ${ms.toFixed(2)} | ${r.screenMatches ? "yes" : "NO"}`);
			}
		}
	}
	out("");
	out("Modelled renderer at 50 µs per character (an assumption, to show the throttle), 4000-token answer at 40 tok/s:");
	const text = sampleAnswer(4000);
	for (const policy of ["before", "after"] as const) {
		const r = await replay(text, 40, policy, 50);
		const streamMs = (text.length / 4 / 40) * 1000;
		out(`${policy}: ${r.renders} renders, ${r.chars} chars, ${Math.round(r.renderMs)} ms of rendering in a ${Math.round(streamMs)} ms stream (${((r.renderMs / streamMs) * 100).toFixed(1)}%)`);
	}
}

// Run as a script; imported by the tests and by the DOM check (in a browser, where there is no process), it only exports.
if (typeof process !== "undefined" && process.argv?.[1] && /bench-render/.test(process.argv[1])) void main();
