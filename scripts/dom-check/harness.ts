/**
 * The chat view's real DOM code, run in a Chromium page against a scripted agent (see run.mjs).
 * Checks what unit tests without a DOM cannot: that a reply streams block by block and a selection
 * in it survives, that the list follows only at the bottom, the status line, the queue, pictures.
 */
import "./obsidian-shim";
import { BusyGate } from "../../src/busy";
import { AgentView } from "../../src/view";
import type { AgentCallbacks, ChatMessage, ToolCall, UsageInfo } from "../../src/types";
import type { Conversation } from "../../src/agent";
import { FakeVault } from "../../tests/fakes";
import { sampleAnswer, standInRender } from "../bench-render";
import { Notice, renderLog } from "./obsidian-shim";

/* eslint-disable */
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const frame = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
async function until(what: string, test: () => boolean, timeoutMs = 8000, detail?: () => unknown): Promise<void> {
	const t0 = performance.now();
	while (!test()) {
		if (performance.now() - t0 > timeoutMs) throw new Error(`timed out waiting for: ${what}${detail ? ` (${JSON.stringify(detail())})` : ""}`);
		await sleep(15);
	}
}

/** One model call of the scripted agent. */
interface Step {
	/** Time before the first piece (the server loads the model or reads the prompt). */
	waitMs?: number;
	thinking?: string;
	content?: string;
	/** What the agent makes of the content afterwards (links, a sources line); defaults to the content. */
	final?: string;
	pieceMs?: number;
	tool?: { name: string; args: Record<string, unknown>; result: string };
	usage?: Partial<UsageInfo>;
}

class ScriptedAgent {
	/** The message of every turn, as the agent received it. */
	calls: string[] = [];
	turns: Step[][] = [];
	running = 0;

	async run(conversation: Conversation, message: string, cb: AgentCallbacks, signal?: AbortSignal): Promise<void> {
		this.calls.push(message);
		this.running++;
		try {
			conversation.messages.push({ role: "user", content: message });
			const steps = this.turns.shift() ?? [{ content: "Done." }];
			for (const step of steps) {
				cb.onStatus?.("");
				cb.onAssistantStart?.();
				await sleep(step.waitMs ?? 30);
				if (signal?.aborted) return;
				const pieces = (text: string) => text.match(/[\s\S]{1,4}/g) ?? [];
				for (const p of pieces(step.thinking ?? "")) {
					cb.onThinkingDelta?.(p);
					await sleep(step.pieceMs ?? 3);
					if (signal?.aborted) return;
				}
				const content = step.content ?? "";
				for (const p of pieces(content)) {
					cb.onAssistantDelta?.(p);
					await sleep(step.pieceMs ?? 3);
					if (signal?.aborted) return;
				}
				const call: ToolCall | null = step.tool ? { function: { name: step.tool.name, arguments: step.tool.args } } : null;
				const message: ChatMessage = { role: "assistant", content: step.final ?? content, ...(call ? { tool_calls: [call] } : {}) };
				conversation.messages.push(message);
				cb.onAssistantDone?.(message);
				cb.onUsage?.({ promptTokens: 9000, completionTokens: Math.max(1, pieces(content).length), numCtx: 32768, promptEvalMs: 300, evalMs: Math.max(1, pieces(content).length * 25), loadMs: 0, ...step.usage });
				if (call && step.tool) {
					cb.onToolStart?.(call);
					await sleep(40);
					if (signal?.aborted) return;
					conversation.messages.push({ role: "tool", content: step.tool.result, tool_name: step.tool.name });
					cb.onToolDone?.(call, step.tool.result, true);
				}
			}
		} finally {
			this.running--;
		}
	}
}

interface Mounted {
	view: AgentView;
	agent: ScriptedAgent;
	plugin: any;
	box: HTMLElement;
	messages: HTMLElement;
	input: HTMLTextAreaElement;
	send: HTMLButtonElement;
	status: HTMLElement;
	/** The first part of the status line (what the turn is doing), each time it changed. */
	statusSeen: string[];
	/** Every text the status line had. */
	statusLines: string[];
	type(text: string): Promise<void>;
}

/** A chat view in a 420 x 560 px panel, on a plugin that is all fakes except the gate. */
async function mount(title: string): Promise<Mounted> {
	const gallery = document.getElementById("gallery")!;
	const cell = (gallery as any).createDiv({ cls: "cell" });
	cell.createDiv({ cls: "cell-title", text: title });
	const box: HTMLElement = cell.createDiv({ cls: "panel" });
	const agent = new ScriptedAgent();
	const vault = new FakeVault({ "Ideas/Plan.md": "# Plan\nThree steps." });
	const saved = new Map<string, ArrayBuffer>();
	const plugin: any = {
		settings: { model: "qwen3.5:9b", autoApproveEdits: false, maxToolResultChars: 12000, setupShown: true, showThinking: true, quizQuestions: 5, quizReviewFolder: "Review" },
		busy: new BusyGate(),
		agent,
		vault,
		client: { provider: "ollama", psAnswers: [] as string[][], async ps() { const a = this.psAnswers.length > 1 ? this.psAnswers.shift() : this.psAnswers[0]; return (a ?? ["qwen3.5:9b"]).map((name: string) => ({ name, size: 1, sizeVram: 1 })); }, async listModels() { return [{ name: "qwen3.5:9b", size: 6.6e9, capabilities: ["completion", "tools", "vision"] }]; } },
		index: { status: () => ({ enabled: true, building: false, indexedFiles: 12, totalChunks: 40, pending: 0, lastError: null }), syncAll: async () => undefined },
		gists: { status: () => ({ enabled: false }), syncAll: async () => undefined },
		onIndexStatus: () => () => undefined,
		onGistStatus: () => () => undefined,
		loadChat: async () => null,
		saveChat: () => undefined,
		clearChat: async () => undefined,
		lastChatId: null,
		lastChatUsage: null,
		undo: { byId: () => undefined },
		lectureCompanion: () => null,
		checkOllamaOnce: async () => undefined,
		checkPlacementOnce: async () => undefined,
		countAnswer: async () => false,
		refreshVision: async () => undefined,
		saveSettings: async () => undefined,
		openSetup: () => undefined,
		stopJob: () => undefined,
		reportProblem: () => undefined,
		revert: async () => true,
		activeEditorView: () => null,
		showHistory: () => undefined,
		visionAvailable: true,
		described: [] as string[],
		vision: { describe: async (path: string) => (plugin.described.push(path), sleep(60).then(() => "Text: 47\nDescription: a number on a whiteboard.")) },
		saved,
		saveAttachment: async (name: string, data: ArrayBuffer) => {
			// As Obsidian does: a name that is taken gets a number.
			let path = `Attachments/${name}`;
			for (let i = 1; saved.has(path); i++) path = `Attachments/${name.replace(/(\.[a-z]+)$/, ` ${i}$1`)}`;
			saved.set(path, data);
			return path;
		},
		attachmentPreview: (path: string) => (saved.has(path) ? URL.createObjectURL(new Blob([saved.get(path)!], { type: "image/png" })) : null),
	};
	const leaf = { app: { workspace: { openLinkText: async () => undefined } }, containerEl: box };
	const view = new AgentView(leaf as any, plugin);
	await view.onOpen();
	const q = <T extends Element>(sel: string) => box.querySelector(sel) as unknown as T;
	const m: Mounted = {
		view,
		agent,
		plugin,
		box,
		messages: q<HTMLElement>(".lva-messages"),
		input: q<HTMLTextAreaElement>(".lva-input"),
		send: q<HTMLButtonElement>(".lva-send"),
		status: q<HTMLElement>(".lva-status"),
		statusSeen: [],
		statusLines: [],
		async type(text: string) {
			m.input.value = text;
			m.input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
			await sleep(0);
		},
	};
	new MutationObserver(() => {
		const text = m.status.textContent ?? "";
		m.statusLines.push(text);
		const phase = text.split(" · ")[0];
		if (m.statusSeen[m.statusSeen.length - 1] !== phase) m.statusSeen.push(phase);
	}).observe(m.status, { childList: true, characterData: true, subtree: true });
	return m;
}

interface Result {
	scenario: string;
	check: string;
	ok: boolean;
	detail?: string;
}
const results: Result[] = [];
const numbers: Record<string, number | string> = {};
let scenario = "";
function check(name: string, ok: boolean, detail?: unknown): void {
	results.push({ scenario, check: name, ok, ...(ok || detail === undefined ? {} : { detail: typeof detail === "string" ? detail : JSON.stringify(detail) }) });
}
const distanceFromBottom = (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight;
const shown = (el: Element | null) => !!el && (el as HTMLElement).style.display !== "none" && (el as HTMLElement).getClientRects().length > 0;

/** 1. A reply is drawn block by block; text selected in a finished paragraph stays selected; the reply is announced once. */
async function streaming(): Promise<void> {
	scenario = "streaming";
	const m = await mount("Streaming: selection kept, announced once");
	const answer = sampleAnswer(500);
	const final = `${answer}\n\nSources: [[Ideas/Plan]]`;
	m.agent.turns.push([{ content: answer, final, pieceMs: 3 }]);
	const announcer = m.box.querySelector(".lva-sr-only") as HTMLElement;
	let announcements = 0;
	new MutationObserver(() => announcements++).observe(announcer, { childList: true, characterData: true, subtree: true });
	renderLog.calls = 0;
	renderLog.chars = 0;
	await m.type("What do my notes say?");
	const bubble = () => m.box.querySelector(".lva-assistant .lva-bubble") as HTMLElement | null;
	await until("three blocks on screen", () => (bubble()?.children.length ?? 0) >= 4);
	check("the bubble being written is kept out of the live region", bubble()!.getAttribute("aria-live") === "off");
	check("the bubble shows the writing cursor", bubble()!.classList.contains("lva-streaming"));
	// Select the first paragraph while the reply is still being written.
	const para = bubble()!.querySelector("p") as HTMLElement;
	const range = document.createRange();
	range.selectNodeContents(para);
	const selection = window.getSelection()!;
	selection.removeAllRanges();
	selection.addRange(range);
	const selected = selection.toString();
	check("a paragraph can be selected while the reply streams", selected.length > 40);
	const heading = bubble()!.firstElementChild;
	await sleep(400);
	check("the selection is still there 400 ms of streaming later", window.getSelection()!.toString() === selected && para.isConnected, window.getSelection()!.toString().slice(0, 60));
	check("the first block is the same node as before", bubble()!.firstElementChild === heading);
	await until("the turn to end", () => m.agent.running === 0 && !m.send.classList.contains("lva-stop"), 15000);
	await until("the finished reply to be drawn", () => !!m.box.querySelector(".lva-actions"));
	check("the selection survives the finished reply being drawn", window.getSelection()!.toString() === selected && para.isConnected);
	check("the writing cursor is gone", !bubble()!.classList.contains("lva-streaming"));
	// What is on screen is exactly what one render of the finished text gives.
	const whole = document.createElement("div");
	whole.insertAdjacentHTML("beforeend", standInRender(final).map((n) => n.html).join(""));
	check("the bubble is exactly one render of the finished text", bubble()!.innerHTML === whole.innerHTML, { got: bubble()!.innerHTML.length, want: whole.innerHTML.length });
	check("the sources line the agent added is there", /Sources:/.test(bubble()!.lastElementChild?.textContent ?? ""));
	check("the finished reply is announced once, one block per line", announcements === 1 && announcer.textContent === bubble()!.innerText && /\S\n+\S/.test(announcer.textContent ?? ""), { announcements });
	numbers["streaming: renderer calls"] = renderLog.calls;
	numbers["streaming: characters handed to the renderer"] = renderLog.chars;
	numbers["streaming: characters of the reply"] = final.length;
	// What the old every-120-ms redraw would have handed over for the same number of draws.
	check("far fewer characters were rendered than the whole reply once per draw", renderLog.chars < (renderLog.calls * final.length) / 4, { chars: renderLog.chars, calls: renderLog.calls });
	window.getSelection()!.removeAllRanges();
}

/** 2. The list follows the text at the bottom, stays put when the reader scrolls up, and the button jumps to the latest. */
async function scrolling(): Promise<void> {
	scenario = "scrolling";
	const m = await mount("Scrolled up while text arrives");
	m.agent.turns.push([{ content: sampleAnswer(900), pieceMs: 3 }]);
	const jump = m.box.querySelector(".lva-jump") as HTMLElement;
	await m.type("Write a long answer.");
	await until("the reply to be taller than the panel", () => m.messages.scrollHeight > m.messages.clientHeight + 300);
	await frame();
	check("the list follows the text while the reader is at the bottom", distanceFromBottom(m.messages) < 30, distanceFromBottom(m.messages));
	check("no jump button while following", !shown(jump));
	// The reader scrolls up.
	m.messages.scrollTop -= 200;
	await frame();
	const at = m.messages.scrollTop;
	check("the jump button appears when the reader scrolls up", shown(jump));
	const height = m.messages.scrollHeight;
	await until("more text to arrive", () => m.messages.scrollHeight > height + 150, 8000, () => ({ height, now: m.messages.scrollHeight, client: m.messages.clientHeight, top: m.messages.scrollTop, running: m.agent.running, chars: m.box.querySelector(".lva-assistant .lva-bubble")?.textContent?.length }));
	await frame();
	check("the list stays where the reader put it", Math.abs(m.messages.scrollTop - at) <= 1, { at, now: m.messages.scrollTop });
	check("the button says there is new text below", jump.classList.contains("lva-jump-new") && /new text/.test(jump.getAttribute("aria-label") ?? ""));
	jump.click();
	await frame();
	check("the button goes to the latest and hides", distanceFromBottom(m.messages) < 30 && !shown(jump), distanceFromBottom(m.messages));
	// A slow scroll: a few pixels at a time, as a trackpad sends them, each announced by a wheel event.
	for (let i = 0; i < 12; i++) {
		m.messages.dispatchEvent(new WheelEvent("wheel", { deltaY: -4, bubbles: true }));
		m.messages.scrollTop -= 4;
		await sleep(16);
	}
	await frame();
	check("a slow upward scroll gets away from the stream", shown(jump) && distanceFromBottom(m.messages) >= 30, distanceFromBottom(m.messages));
	await until("the turn to end", () => m.agent.running === 0 && !m.send.classList.contains("lva-stop"), 20000);
	await frame();
	check("still not pulled down when the reply is finished", distanceFromBottom(m.messages) > 100 && shown(jump));
	// The reader's own next message is always shown.
	m.agent.turns.push([{ content: "Short." }]);
	await m.type("And now?");
	await until("the second turn to end", () => m.agent.calls.length === 2 && m.agent.running === 0 && !m.send.classList.contains("lva-stop"));
	await frame();
	check("sending a message goes to the bottom again", distanceFromBottom(m.messages) < 30 && !shown(jump), distanceFromBottom(m.messages));
	// Left scrolled up for the screenshot.
	m.messages.scrollTop -= 260;
	await frame();
}

/** 3. The status line says what the turn is doing, and a line under the reply says how it went. */
async function progress(): Promise<void> {
	scenario = "progress";
	const m = await mount("Progress: loading, reading, writing, summary");
	// Not in memory for the first two answers of /api/ps, then loaded.
	m.plugin.client.psAnswers = [[], [], ["qwen3.5:9b"]];
	m.agent.turns.push([
		{ waitMs: 2600, tool: { name: "search_notes", args: { query: "plan" }, result: "x".repeat(3200) }, usage: { promptTokens: 9100, completionTokens: 24, evalMs: 600, loadMs: 2300 } },
		{ waitMs: 300, thinking: "Let me think about the plan. ".repeat(6), content: sampleAnswer(260), pieceMs: 5, usage: { promptTokens: 10100, completionTokens: 300, evalMs: 7500, loadMs: 0 } },
	]);
	await m.type("What is the plan?");
	await until("the turn to end", () => m.agent.running === 0 && !m.send.classList.contains("lva-stop"), 20000);
	await until("the summary line", () => !!m.box.querySelector(".lva-stats"));
	const seen = m.statusSeen;
	numbers["progress: status line, first turn"] = seen.join(" | ");
	check("says the model is loading while /api/ps does not list it", seen.includes("Loading the model…"), seen);
	check("says so as soon as the server has answered, not a second later", seen.indexOf("Loading the model…") <= 1, seen);
	check("then that the prompt is being read", seen.lastIndexOf("Reading the prompt…") > seen.indexOf("Loading the model…"), seen);
	check("says working while the tool runs", seen.includes("Working…"), seen);
	check("guesses the second call's prompt from the first call's counts", seen.some((s) => /^Reading about 10k tokens…$/.test(s)), seen);
	const thought = m.box.querySelector(".lva-thinking-body")?.textContent ?? "";
	check("all of the thinking is shown in the end, though it is drawn a few times a second and not per token", thought === "Let me think about the plan. ".repeat(6), thought.length);
	check("says thinking, then writing with a rate", seen.some((s) => s.startsWith("Thinking…")) && seen.some((s) => /^Writing… about \d+(\.\d)? tokens\/s$/.test(s)), seen);
	const stats = m.box.querySelector(".lva-stats")!.textContent ?? "";
	numbers["progress: summary line"] = stats;
	// 324 tokens in 8.1 s by the scripted server's own timings.
	check("the summary has the time to the first words, the server's rate, the prompt and the load time", /^\d+(\.\d)? s · first words after \d+(\.\d)? s · 40 tokens\/s · 10k prompt tokens · model loaded in 2\.3 s$/.test(stats), stats);
	check("the summary is not read out after the reply", m.box.querySelector(".lva-stats")!.getAttribute("aria-live") === "off");
	check("the line counts the tool call and the seconds", m.statusLines.some((l) => /^Reading about 10k tokens… · 1 tool call\(s\) · \d+ s · Index/.test(l)), m.statusLines.slice(-12));
	const after = m.status.textContent ?? "";
	check("after the turn the line is back to the index and the context", /Index: 12 notes/.test(after) && /Context 10k \/ 33k/.test(after), after);

	// A notice for a long turn that ends while the user is elsewhere.
	const hasFocus = document.hasFocus;
	const before = Notice.shown.length;
	document.hasFocus = () => true;
	(m.view as any).notifyIfAway(45_000, false);
	check("no notice when Obsidian has the focus", Notice.shown.length === before);
	document.hasFocus = () => false;
	(m.view as any).notifyIfAway(12_000, false);
	check("no notice for a turn under 30 s", Notice.shown.length === before);
	(m.view as any).notifyIfAway(45_000, false);
	const notice = Notice.shown[Notice.shown.length - 1];
	check("a notice that stays for a 45 s turn that ended unfocused", Notice.shown.length === before + 1 && notice.timeout === 0 && /reply is ready \(it took 45 s\)/.test(notice.message), notice?.message);
	(m.view as any).notifyIfAway(95_000, true);
	check("a failed turn says so", /reply failed after 1 min 35 s/.test(Notice.shown[Notice.shown.length - 1].message));
	document.hasFocus = hasFocus;
}

/** 4. Messages sent while a turn runs wait in a visible queue; Stop gives them back. */
async function queueing(): Promise<void> {
	scenario = "queue";
	const m = await mount("Queue: sent while a reply is written");
	m.agent.turns.push([{ content: sampleAnswer(120), pieceMs: 6 }], [{ content: sampleAnswer(200), pieceMs: 8 }]);
	const queue = m.box.querySelector(".lva-queue") as HTMLElement;
	const rows = () => Array.from(queue.querySelectorAll(".lva-queued-text")).map((e) => e.textContent);
	check("no queue to begin with", !shown(queue));
	await m.type("first question");
	await until("the first turn to start", () => m.agent.running === 1);
	await m.type("second question");
	check("a message sent during a turn is queued, visibly", shown(queue) && rows().join("|") === "second question", rows());
	check("the message box is free again", m.input.value === "");
	check("the agent has not been given it yet", m.agent.calls.length === 1);
	check("the queue says when it will be sent", /sent when this reply is finished/.test(queue.textContent ?? ""));
	await m.type("third question");
	check("a second one queues behind it", rows().join("|") === "second question|third question", rows());
	// Take the third back.
	(queue.querySelectorAll(".lva-queued button")[1] as HTMLElement).click();
	check("taking one back puts it in the message box", rows().join("|") === "second question" && m.input.value === "third question", { rows: rows(), input: m.input.value });
	m.input.value = "";
	await until("the queued message to be sent when the turn ends", () => m.agent.calls.length === 2, 15000);
	check("it is sent as typed", m.agent.calls[1] === "second question", m.agent.calls[1]);
	check("the queue is empty and hidden", !shown(queue) && rows().length === 0);
	check("its bubble is in the chat", Array.from(m.box.querySelectorAll(".lva-user .lva-bubble")).map((e) => e.textContent).join("|") === "first question|second question");
	// Stop: what is waiting is not sent.
	await until("the second turn to be running", () => m.send.classList.contains("lva-stop"));
	await m.type("fourth question");
	m.input.value = "half a thought";
	check("queued again", rows().join("|") === "fourth question");
	m.send.click();
	check("Stop empties the queue into the message box, before what was typed", !shown(queue) && m.input.value === "fourth question\n\nhalf a thought", m.input.value);
	await until("the stopped turn to unwind", () => m.agent.running === 0 && !m.send.classList.contains("lva-stop"));
	await sleep(250);
	check("nothing more is sent after Stop", m.agent.calls.length === 2 && m.agent.running === 0);
	check("the chat says it was stopped", /Stopped\./.test(m.messages.textContent ?? ""));
	// Queued again for the screenshot: a job has the model.
	m.input.value = "";
	const job = m.plugin.busy.acquire("job", "Weekly digest");
	await m.type("What changed this week?");
	check("a message sent while a scheduled job runs is queued too", rows().join("|") === "What changed this week?" && /sent when Weekly digest has finished/.test(queue.textContent ?? ""), queue.textContent);
	await frame();
	check("the list is still at its end though the bars under it took room", distanceFromBottom(m.messages) < 30, distanceFromBottom(m.messages));
	numbers["queue: job lease held for the screenshot"] = job ? "yes" : "no";
}

function pngFile(name = "image.png"): File {
	// A valid 1x1 PNG.
	const b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
	const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
	return new File([bytes], name, { type: "image/png" });
}

/** 5. A picture pasted or dropped into the message box is saved, shown, read and sent with the message. */
async function pictures(): Promise<void> {
	scenario = "pictures";
	const m = await mount("Pictures: pasted into the message box");
	const pending = m.box.querySelector(".lva-pending") as HTMLElement;
	const composer = m.box.querySelector(".lva-composer") as HTMLElement;
	const paste = (files: File[], text = "") => {
		const data = new DataTransfer();
		for (const f of files) data.items.add(f);
		if (text) data.setData("text/plain", text);
		const e = new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true });
		m.input.dispatchEvent(e);
		return e;
	};
	// Text that comes with a picture of itself is pasted as text.
	const textPaste = paste([pngFile()], "copied words");
	await sleep(30);
	check("a paste that has text is left to the message box", !textPaste.defaultPrevented && m.plugin.saved.size === 0);
	// Without a vision model: a notice, nothing saved.
	m.plugin.visionAvailable = false;
	const notices = Notice.shown.length;
	paste([pngFile()]);
	await sleep(30);
	check("without a vision model nothing is saved and a notice says what to set", m.plugin.saved.size === 0 && /vision model/i.test(Notice.shown[Notice.shown.length - 1]?.message ?? "") && Notice.shown.length === notices + 1);
	m.plugin.visionAvailable = true;
	const e = paste([pngFile()]);
	await until("the picture to be saved", () => m.plugin.saved.size === 1);
	await sleep(30);
	const path = Array.from(m.plugin.saved.keys())[0] as string;
	check("the paste is taken", e.defaultPrevented);
	check("saved as an attachment under Obsidian's name for a pasted image", /^Attachments\/Pasted image \d{14}\.png$/.test(path), path);
	check("shown above the message box with its name and a thumbnail", shown(pending) && pending.querySelectorAll(".lva-pending-image").length === 1 && !!pending.querySelector("img") && (pending.textContent ?? "").includes(path.split("/")[1]), pending.textContent);
	// A file that is not a picture, dropped on the composer.
	const dropData = new DataTransfer();
	dropData.items.add(new File(["%PDF"], "report.pdf", { type: "application/pdf" }));
	const drop = new DragEvent("drop", { dataTransfer: dropData, bubbles: true, cancelable: true });
	composer.dispatchEvent(drop);
	await sleep(30);
	check("a dropped file that is not a picture is refused with a notice", drop.defaultPrevented && /report\.pdf is not a picture/.test(Notice.shown[Notice.shown.length - 1]?.message ?? "") && m.plugin.saved.size === 1);
	// A second picture, dropped.
	const dropPng = new DataTransfer();
	dropPng.items.add(pngFile("Whiteboard after meeting.png"));
	composer.dispatchEvent(new DragEvent("drop", { dataTransfer: dropPng, bubbles: true, cancelable: true }));
	await until("the dropped picture to be saved", () => m.plugin.saved.size === 2);
	await sleep(30);
	check("a dropped picture keeps its name", m.plugin.saved.has("Attachments/Whiteboard after meeting.png") && pending.querySelectorAll(".lva-pending-image").length === 2);
	// Leave the second out again.
	(pending.querySelectorAll(".lva-pending-image button")[1] as HTMLElement).click();
	check("a picture can be left out of the message; its file stays", pending.querySelectorAll(".lva-pending-image").length === 1 && m.plugin.saved.size === 2);
	m.agent.turns.push([{ content: "The picture shows the number **47** on a whiteboard." }]);
	await m.type("What number is this?");
	await until("the turn to end", () => m.agent.calls.length === 1 && m.agent.running === 0 && !m.send.classList.contains("lva-stop"));
	check("the picture was read with the vision model before the turn", m.plugin.described.join("|") === path, m.plugin.described);
	check("the status line said so", m.statusSeen.includes("Reading image 1 of 1…"), m.statusSeen);
	const sent = m.agent.calls[0];
	check("the agent got the user's words first", sent.startsWith("What number is this?\n\n(The user attached the following image"), sent.slice(0, 90));
	check("and what was read in the picture, with its path", sent.includes(`--- Attached image: ${path} ---\nText: 47`), sent.slice(-140));
	const user = m.box.querySelector(".lva-user") as HTMLElement;
	check("the chat shows the words and the picture, not the reading", user.querySelector(".lva-bubble")!.textContent === "What number is this?" && !!user.querySelector(".lva-attached-images img"));
	check("nothing is left above the message box", !shown(pending) && pending.children.length === 0);
	// For the screenshot: one more picture waiting.
	paste([pngFile()]);
	await until("the third picture to be saved", () => m.plugin.saved.size === 3);
	await sleep(30);
	m.input.value = "And this one?";
}

async function run(): Promise<{ results: Result[]; numbers: Record<string, number | string>; error?: string }> {
	try {
		for (const s of [streaming, scrolling, progress, queueing, pictures]) await s();
	} catch (err) {
		return { results, numbers, error: `${scenario}: ${(err as Error).stack ?? String(err)}` };
	}
	return { results, numbers };
}

(window as any).__run = run;
