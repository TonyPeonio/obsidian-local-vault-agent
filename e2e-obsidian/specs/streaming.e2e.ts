import { browser, expect } from "@wdio/globals";
import { SlowOllama } from "./slow-ollama";

/**
 * What the chat does while a reply is being written, in a real Obsidian and with Obsidian's own
 * markdown renderer: the reply is drawn block by block and ends up exactly as one render of the
 * finished text; a message sent meanwhile waits in the queue; Stop hands the queue back; the list
 * stays where the reader scrolled; a pasted picture is saved as an attachment, read and sent.
 *
 * Nothing here needs a real click or keystroke: messages are sent through the view, buttons are
 * pressed with `element.click()` in the page, and the chat is read from the DOM. So the spec also
 * runs on a desktop whose test window draws no animation frames.
 */

const mock = new SlowOllama();

const ANSWER = [
	"## Hall sensors",
	"",
	"Hall sensors measure a magnetic field and turn it into a voltage. They are cheap, robust and need no contact with the moving part.",
	"",
	"The three properties that matter for the robot:",
	"",
	"- **Range**: a few millimetres from the magnet.",
	"- **Speed**: fast enough for a motor at full speed.",
	"- **Cost**: well under a dollar each.",
	"",
	"```ts",
	"const reading = sensor.read();",
	"",
	"if (reading > threshold) stop();",
	"```",
	"",
	"A second paragraph follows the code so that there is text after it. It says nothing new, it only makes the reply long enough to still be arriving while the test looks at the chat.",
	"",
	"The last paragraph ends the reply.",
].join("\n");

const LONG = Array.from({ length: 14 }, (_, i) => `Paragraph ${i + 1} of a long reply, long enough to fill the panel several times over so that the list has to scroll.`).join("\n\n");

interface ChatView {
	send(text: string, attach?: boolean): Promise<void>;
}

/** What the spec reads from the chat panel, in one round trip. */
interface ChatState {
	running: boolean;
	queued: string[];
	input: string;
	userBubbles: string[];
	notes: string[];
	stats: string[];
	status: string;
	jumpShown: boolean;
	pending: string[];
	distanceFromBottom: number;
}

function state(): Promise<ChatState> {
	return browser.execute(() => {
		const texts = (sel: string) => Array.from(document.querySelectorAll(sel)).map((e) => (e.textContent ?? "").trim());
		const messages = document.querySelector(".lva-messages") as HTMLElement;
		const jump = document.querySelector(".lva-jump") as HTMLElement | null;
		return {
			running: document.querySelector(".lva-send.lva-stop") !== null,
			queued: texts(".lva-queued-text"),
			input: (document.querySelector(".lva-input") as HTMLTextAreaElement).value,
			userBubbles: texts(".lva-user .lva-bubble"),
			notes: texts(".lva-note"),
			stats: texts(".lva-stats"),
			status: (document.querySelector(".lva-status")?.textContent ?? "").trim(),
			jumpShown: jump !== null && jump.style.display !== "none",
			pending: texts(".lva-pending-name"),
			distanceFromBottom: messages.scrollHeight - messages.scrollTop - messages.clientHeight,
		};
	});
}

/** Sends a message through the view, as a command does; does not wait for the turn. */
async function send(text: string): Promise<void> {
	await browser.executeObsidian(({ app }, text) => {
		const view = app.workspace.getLeavesOfType("local-vault-agent-view")[0]?.view as unknown as ChatView;
		void view.send(text);
	}, text);
}

async function idle(timeout = 60000): Promise<void> {
	await browser.waitUntil(async () => !(await state()).running, { timeout, timeoutMsg: "the turn did not end" });
}

describe("Streaming and progress in the chat", function () {
	before(async function () {
		const url = await mock.start();
		await browser.executeObsidian(
			async ({ app }, url) => {
				const plugin = (app as unknown as { plugins: { plugins: Record<string, unknown> } }).plugins.plugins["local-vault-agent"] as { settings: Record<string, unknown>; saveSettings(): Promise<void>; refreshVision(): Promise<void> };
				Object.assign(plugin.settings, { ollamaUrl: url, model: "mock-model", visionModel: "", semanticSearch: false, setupShown: true, survey: "done", citations: "off", autoApproveEdits: false, thinking: "auto" });
				await plugin.saveSettings();
				await plugin.refreshVision();
			},
			url,
		);
		await browser.executeObsidianCommand("local-vault-agent:open-chat");
		await browser.$(".lva-input").waitForExist({ timeout: 20000 });
	});

	after(async function () {
		await mock.stop();
	});

	it("draws a streamed reply block by block, and ends with exactly one render of the finished text", async function () {
		mock.script([{ content: ANSWER, pieceMs: 40 }]);
		await send("Tell me about hall sensors.");
		// While the reply is arriving: several blocks are on screen already, in a bubble that is not announced piece by piece.
		await browser.waitUntil(
			() => browser.execute(() => (document.querySelector(".lva-assistant .lva-bubble.lva-streaming")?.children.length ?? 0) >= 3),
			{ timeout: 30000, timeoutMsg: "three blocks of the reply were not on screen while it was streaming" },
		);
		const during = await browser.execute(() => {
			const bubble = document.querySelector(".lva-assistant .lva-bubble.lva-streaming") as HTMLElement;
			// Every block but the last is finished; the last is the one being written.
			const settled = Array.from(bubble.children).slice(0, -1);
			// The reader selects the second block while the reply is still arriving.
			const range = document.createRange();
			range.selectNodeContents(settled[1]);
			const selection = window.getSelection()!;
			selection.removeAllRanges();
			selection.addRange(range);
			Object.assign(window as unknown as Record<string, unknown>, { lvaSettled: settled, lvaSelected: selection.toString() });
			return { live: bubble.getAttribute("aria-live"), first: settled[0].textContent ?? "", settled: settled.length, selected: selection.toString(), running: document.querySelector(".lva-send.lva-stop") !== null };
		});
		expect(during.live).toBe("off");
		expect(during.first).toContain("Hall sensors");
		expect(during.settled).toBeGreaterThanOrEqual(2);
		expect(during.selected).toContain("Hall sensors measure a magnetic field");
		expect(during.running).toBe(true);
		const status = (await state()).status;
		expect(status).toMatch(/^(Writing…|Thinking…|Reading|Working…|Loading)/);

		await idle();
		await browser.$(".lva-actions").waitForExist({ timeout: 20000 });
		// The same text rendered once, as a whole, by Obsidian: what is on screen must be that.
		const result = await browser.executeObsidian(async ({ app, obsidian }, markdown) => {
			const view = app.workspace.getLeavesOfType("local-vault-agent-view")[0].view;
			const bubbles = document.querySelectorAll(".lva-assistant .lva-bubble");
			const bubble = bubbles[bubbles.length - 1] as HTMLElement;
			const whole = document.createElement("div");
			await obsidian.MarkdownRenderer.render(app, markdown, whole, "", view);
			// Block by block: Obsidian puts a line break between the blocks of one render, the chat does not keep it.
			const blocks = (el: Element) => Array.from(el.children).map((c) => `${c.tagName}: ${c.textContent ?? ""}`);
			const w = window as unknown as { lvaSettled: Element[]; lvaSelected: string };
			return {
				streaming: bubble.classList.contains("lva-streaming"),
				blocks: blocks(bubble),
				wantBlocks: blocks(whole),
				strayText: Array.from(bubble.childNodes).filter((n) => n.nodeType === 3 && (n.textContent ?? "").trim() !== "").length,
				settled: w.lvaSettled.length,
				settledKept: w.lvaSettled.filter((n) => n.parentElement === bubble).length,
				selectionKept: window.getSelection()!.toString() === w.lvaSelected,
				announced: document.querySelector(".lva-sr-only")?.textContent ?? "",
			};
		}, ANSWER);
		expect(result.streaming).toBe(false);
		expect(result.blocks).toEqual(result.wantBlocks);
		expect(result.strayText).toBe(0);
		// The blocks that were finished while the reply streamed were drawn once and never replaced,
		// not even when the finished reply was drawn; so the reader's selection is still there.
		expect(result.settledKept).toBe(result.settled);
		expect(result.selectionKept).toBe(true);
		// A screen reader is given the finished reply, one block per line.
		expect(result.announced).toContain("Hall sensors measure a magnetic field");
		expect(result.announced).toContain("The last paragraph ends the reply.");
		expect(result.announced).not.toContain("moving part.The three");
		await browser.execute(() => window.getSelection()!.removeAllRanges());
		// How the turn went, from the server's own counts.
		const after = await state();
		expect(after.stats.length).toBe(1);
		expect(after.stats[0]).toMatch(/first words after [\d.]+ s · [\d.]+ tokens\/s · 1\.2k prompt tokens/);
	});

	it("queues a message sent while a reply is written, and sends it when the turn has ended", async function () {
		mock.script([{ content: LONG, pieceMs: 15 }, { content: "The second answer." }]);
		const before = mock.chats.length;
		await send("First question, with a long answer.");
		await browser.waitUntil(async () => (await state()).running, { timeout: 20000, timeoutMsg: "the first turn did not start" });
		await send("Second question, sent meanwhile.");
		const waiting = await state();
		expect(waiting.queued).toEqual(["Second question, sent meanwhile."]);
		expect(waiting.userBubbles).not.toContain("Second question, sent meanwhile.");
		expect(mock.chats.slice(before).some((c) => JSON.stringify(c).includes("Second question"))).toBe(false);

		await browser.waitUntil(() => Promise.resolve(mock.chats.slice(before).some((c) => JSON.stringify(c).includes("Second question"))), { timeout: 60000, timeoutMsg: "the queued message was never sent" });
		await idle();
		const done = await state();
		expect(done.queued).toEqual([]);
		expect(done.userBubbles.slice(-2)).toEqual(["First question, with a long answer.", "Second question, sent meanwhile."]);
		// It went out after the first reply, not into it.
		expect(mock.lastUserMessage()).toContain("Second question, sent meanwhile.");
	});

	it("gives the queue back to the message box on Stop, and sends nothing more", async function () {
		mock.script([{ content: LONG, pieceMs: 30 }]);
		await send("Third question, to be stopped.");
		await browser.waitUntil(async () => (await state()).running, { timeout: 20000, timeoutMsg: "the turn did not start" });
		await send("Fourth question, which must not be sent.");
		expect((await state()).queued).toEqual(["Fourth question, which must not be sent."]);
		// The send button is the Stop button while a turn runs.
		await browser.execute(() => (document.querySelector(".lva-send.lva-stop") as HTMLElement).click());
		const stopped = await state();
		expect(stopped.queued).toEqual([]);
		expect(stopped.input).toBe("Fourth question, which must not be sent.");
		await idle();
		const requests = mock.chats.length;
		await browser.pause(1000);
		expect(mock.chats.length).toBe(requests);
		expect(mock.chats.some((c) => JSON.stringify(c).includes("Fourth question"))).toBe(false);
		expect((await state()).notes).toContain("Stopped.");
		await browser.execute(() => {
			(document.querySelector(".lva-input") as HTMLTextAreaElement).value = "";
		});
	});

	it("leaves the list where the reader scrolled, with a button back to the latest", async function () {
		// The replies so far are taller than the panel.
		const scrollable = await browser.execute(() => {
			const messages = document.querySelector(".lva-messages") as HTMLElement;
			return messages.scrollHeight - messages.clientHeight;
		});
		expect(scrollable).toBeGreaterThan(300);
		const wheelUp = () =>
			browser.execute(() => {
				const messages = document.querySelector(".lva-messages") as HTMLElement;
				messages.dispatchEvent(new WheelEvent("wheel", { deltaY: -240, bubbles: true }));
				messages.scrollTop -= 240;
				return messages.scrollTop;
			});
		const pressJump = () => browser.execute(() => (document.querySelector(".lva-jump") as HTMLElement).click());
		// The reader scrolls up with the wheel: the button appears, and takes them back.
		await wheelUp();
		expect((await state()).jumpShown).toBe(true);
		await pressJump();
		const back = await state();
		expect(back.jumpShown).toBe(false);
		expect(back.distanceFromBottom).toBeLessThan(30);
		// Scrolled up again, something is added to the conversation: the list does not move.
		const top = await wheelUp();
		await browser.executeObsidian(({ app }) => {
			// The plugin's own "sample questions" line: a message in the chat without a model call.
			const view = app.workspace.getLeavesOfType("local-vault-agent-view")[0].view as unknown as { showSampleQuestions(): void };
			view.showSampleQuestions();
		});
		const held = await browser.execute(() => (document.querySelector(".lva-messages") as HTMLElement).scrollTop);
		expect(held).toBe(top);
		const away = await state();
		expect(away.jumpShown).toBe(true);
		expect(away.distanceFromBottom).toBeGreaterThan(200);
		await pressJump();
		const latest = await state();
		expect(latest.jumpShown).toBe(false);
		expect(latest.distanceFromBottom).toBeLessThan(30);
	});

	it("renders far less markdown than redrawing the whole reply every 120 ms, with Obsidian's own renderer", async function () {
		// About a thousand tokens: sections of a heading, two paragraphs, a list and a code block.
		const section = (n: number) =>
			[
				`## Section ${n}`,
				"",
				`Paragraph one of section ${n} says something about **sensors** and the notes that mention them, at the length of an ordinary paragraph in an answer.`,
				"",
				`Paragraph two of section ${n} adds a detail about the budget and the plan, so that the section is not just a heading and a list.`,
				"",
				...[1, 2, 3, 4].map((i) => `- Point ${i} of section ${n}, one sentence long.`),
				"",
				"```ts",
				`const total${n} = items.reduce((sum, item) => sum + item.cost, 0);`,
				"```",
			].join("\n");
		const big = Array.from({ length: 9 }, (_, i) => section(i + 1)).join("\n\n");
		// Record every call the chat makes to Obsidian's renderer while this reply streams.
		await browser.executeObsidian(({ obsidian }) => {
			type Render = (...args: unknown[]) => Promise<void>;
			const renderer = obsidian.MarkdownRenderer as unknown as { render: Render };
			const original = renderer.render;
			const log = { sources: [] as string[], ms: 0, original };
			(window as unknown as { lvaRenderLog: typeof log }).lvaRenderLog = log;
			renderer.render = async function (this: unknown, ...args: unknown[]) {
				const started = performance.now();
				try {
					return await original.apply(this, args);
				} finally {
					log.sources.push(String(args[1]));
					log.ms += performance.now() - started;
				}
			};
		});
		mock.script([{ content: big, pieceMs: 8 }]);
		const started = Date.now();
		await send("A long answer, please.");
		await browser.waitUntil(async () => (await state()).running, { timeout: 20000, timeoutMsg: "the turn did not start" });
		await idle();
		const streamMs = Date.now() - started;
		await browser.waitUntil(() => browser.execute(() => document.querySelectorAll(".lva-assistant .lva-bubble.lva-streaming").length === 0), { timeout: 20000 });
		const measured = await browser.executeObsidian(
			async ({ app, obsidian }, { text, streamMs }) => {
				type Render = (...args: unknown[]) => Promise<void>;
				const log = (window as unknown as { lvaRenderLog: { sources: string[]; ms: number; original: Render } }).lvaRenderLog;
				(obsidian.MarkdownRenderer as unknown as { render: Render }).render = log.original;
				const view = app.workspace.getLeavesOfType("local-vault-agent-view")[0].view;
				const render = (markdown: string, el: HTMLElement) => log.original.call(obsidian.MarkdownRenderer, app, markdown, el, "", view);
				const messages = document.querySelector(".lva-messages") as HTMLElement;
				const sum = (list: string[]) => list.reduce((n, s) => n + s.length, 0);

				// Before: everything that had arrived, drawn again every 120 ms and once at the end, into the
				// bubble on screen; the layout the browser then has to do is counted (it is forced here).
				const draws = Math.max(1, Math.floor(streamMs / 120));
				const parts = Array.from({ length: draws + 1 }, (_, i) => text.slice(0, Math.ceil((text.length * Math.min(i + 1, draws)) / draws)));
				const oldHost = messages.createDiv({ cls: "lva-bubble lva-markdown" });
				let t0 = performance.now();
				for (const part of parts) {
					oldHost.empty();
					await render(part, oldHost);
					void oldHost.offsetHeight;
				}
				const beforeMs = performance.now() - t0;
				oldHost.remove();

				// After: the renders the chat really made for this reply, replayed the same way (each
				// rendered off screen, then placed, then laid out). A render that continues the one before
				// it replaces it, as the block being written does; the finished text replaces everything.
				const newHost = messages.createDiv({ cls: "lva-bubble lva-markdown" });
				let previous = "";
				let previousNodes: ChildNode[] = [];
				t0 = performance.now();
				for (const source of log.sources) {
					const holder = document.createElement("div");
					await render(source, holder);
					const nodes = Array.from(holder.childNodes);
					if (source === text) newHost.empty();
					else if (source.startsWith(previous) || previous.startsWith(source)) for (const n of previousNodes) n.remove();
					newHost.append(...nodes);
					void newHost.offsetHeight;
					previous = source;
					previousNodes = nodes;
				}
				const afterMs = performance.now() - t0;
				newHost.remove();
				return {
					length: text.length,
					before: { renders: parts.length, chars: sum(parts), msWithLayout: Math.round(beforeMs) },
					after: { renders: log.sources.length, chars: sum(log.sources), msWithLayout: Math.round(afterMs), msInRendererWhileStreaming: Math.round(log.ms) },
				};
			},
			{ text: big, streamMs },
		);
		// The numbers, for the log of the run. They depend on the machine; the amount of text is what is checked.
		console.log(`render cost for a ${measured.length}-character reply streamed in ${streamMs} ms: before ${JSON.stringify(measured.before)}, after ${JSON.stringify(measured.after)}`);
		expect(measured.after.chars).toBeLessThan(measured.before.chars / 3);
	});

	it("saves a pasted picture as an attachment, reads it and sends what it says with the message", async function () {
		// The vision model's reading first, then the agent's answer.
		mock.script([{ content: "Text: 47\nDescription: the number 47 written on a whiteboard." }, { content: "The picture shows the number 47." }]);
		const before = mock.chats.length;
		await browser.execute(() => {
			// A valid 1x1 PNG, pasted from the clipboard.
			const b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
			const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
			const data = new DataTransfer();
			data.items.add(new File([bytes], "image.png", { type: "image/png" }));
			document.querySelector(".lva-input")!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
		});
		await browser.waitUntil(async () => (await state()).pending.length === 1, { timeout: 20000, timeoutMsg: "the pasted picture did not appear above the message box" });
		const name = (await state()).pending[0];
		expect(name).toMatch(/^Pasted image \d{14}( \d+)?\.png$/);
		// It is in the vault, where Obsidian puts attachments.
		const saved = await browser.executeObsidian(({ app }, name) => app.vault.getFiles().filter((f) => f.name === name).map((f) => ({ path: f.path, size: f.stat.size })), name);
		expect(saved.length).toBe(1);
		expect(saved[0].size).toBeGreaterThan(50);

		// Enter in the message box sends the message with the picture above it.
		await browser.execute(() => {
			const input = document.querySelector(".lva-input") as HTMLTextAreaElement;
			input.value = "What number is in this picture?";
			input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
		});
		const lastUser = (c: Record<string, unknown>) => ((c.messages as { role: string; content: string }[]) ?? []).filter((m) => m.role === "user").at(-1)?.content ?? "";
		await browser.waitUntil(() => Promise.resolve(mock.chats.slice(before).some((c) => lastUser(c).startsWith("What number is in this picture?"))), { timeout: 60000, timeoutMsg: "the message with the picture was not sent" });
		await idle();
		const requests = mock.chats.slice(before);
		// The vision model was sent the picture itself.
		expect(requests.some((c) => ((c.messages as { images?: string[] }[]) ?? []).some((m) => (m.images ?? []).length > 0))).toBe(true);
		// The agent was sent the user's words and what was read, with the path of the saved file.
		const withPicture = requests.map(lastUser).find((t) => t.startsWith("What number is in this picture?")) ?? "";
		expect(withPicture).toContain(`--- Attached image: ${saved[0].path} ---\nText: 47`);
		const end = await state();
		expect(end.pending).toEqual([]);
		expect(end.userBubbles.at(-1)).toBe("What number is in this picture?");
		// The pasted file is the test's own: remove it again.
		await browser.executeObsidian(async ({ app }, path) => {
			const file = app.vault.getFileByPath(path);
			if (file) await app.vault.delete(file);
		}, saved[0].path);
	});
});
