import { describe, expect, it } from "vitest";
import { Agent, newConversation } from "../src/agent";
import type { ChatRequest, ChatResponse, OllamaClient } from "../src/ollama";
import { keywordSearch } from "../src/search";
import { DEFAULT_SETTINGS } from "../src/settings";
import { ALL_TOOLS } from "../src/tools";
import { TurnProgress, phaseText, summaryText } from "../src/turn-progress";
import LocalVaultAgentPlugin from "../src/main";
import { FakeOllama, FakeVault, type Scripted } from "./fakes";

/**
 * The progress line is fed by the agent's callbacks. This runs the real agent loop and wires the
 * callbacks the way the chat view does, so a change in the order the agent reports things (start,
 * pieces, done, counts) shows up here.
 */

/** A scripted server that also reports counts and timings, as Ollama's last chunk does. */
class CountingOllama extends FakeOllama {
	async chat(req: ChatRequest): Promise<ChatResponse> {
		const res = await super.chat(req);
		const first = this.requests.length === 1;
		return {
			...res,
			promptTokens: first ? 9000 : 9600,
			completionTokens: first ? 20 : 80,
			loadDuration: first ? 4_000_000_000 : 5_000_000,
			promptEvalDuration: 500_000_000,
			evalDuration: first ? 500_000_000 : 2_000_000_000,
		};
	}
}

describe("the progress line on the real agent loop", () => {
	it("goes from reading to working to writing, and sums the two model calls", async () => {
		const script: Scripted[] = [
			{ tool: "read_note", args: { path: "Ideas/Sensors" } },
			{ content: "Hall sensors are cheap and robust, according to your note." },
		];
		const vault = new FakeVault({ "Ideas/Sensors.md": "Hall sensors are cheap." });
		const settings = { ...DEFAULT_SETTINGS };
		const client = new CountingOllama(script).asClient() as OllamaClient;
		const agent = new Agent({
			client,
			vault,
			tools: ALL_TOOLS,
			search: (q, l) => keywordSearch(vault, q, l),
			approve: async () => "approve",
			getConfig: () => LocalVaultAgentPlugin.prototype.agentConfig.call({ settings, client } as unknown as LocalVaultAgentPlugin),
			now: () => new Date("2026-11-05T12:00:00Z"),
		});

		// A clock that moves 100 ms with every report from the agent.
		let now = 0;
		const tick = () => (now += 100);
		const tp = new TurnProgress(0, { loaded: false });
		const seen: string[] = [];
		const note = () => {
			const text = phaseText(tp.phase(now));
			if (seen[seen.length - 1] !== text) seen.push(text);
		};
		note();
		await agent.run(newConversation(), "What do my notes say about hall sensors?", {
			onAssistantStart: () => {
				tick();
				tp.stepStart();
				note();
			},
			onAssistantDelta: (d) => {
				tp.delta(tick(), "content", d.length);
				note();
			},
			onAssistantDone: () => {
				tp.stepDone(tick());
				note();
			},
			onToolDone: (_call, result) => {
				tick();
				tp.added(result.length);
			},
			onUsage: (u) => {
				tp.usage(u);
				note();
			},
		});

		expect(seen[0]).toBe("Loading the model…");
		// After the first call's counts the model is known to be loaded, and the prompt size is known.
		expect(seen).toContain("Working…");
		expect(seen.some((s) => /^Reading about 9\.\dk tokens…$/.test(s))).toBe(true);
		expect(seen.some((s) => s.startsWith("Writing…"))).toBe(true);
		expect(seen.indexOf("Working…")).toBeLessThan(seen.findIndex((s) => s.startsWith("Writing…")));

		const s = tp.summary(now);
		expect(s.steps).toBe(2);
		expect(s.promptTokens).toBe(9600);
		expect(s.completionTokens).toBe(100);
		expect(s.loadMs).toBe(4005);
		// 100 tokens in 2.5 s of generation, by the server's own timings.
		expect(s.tokensPerSec).toBeCloseTo(40, 5);
		expect(s.approximate).toBe(false);
		expect(s.firstTokenMs).not.toBeNull();
		expect(summaryText(s)).toMatch(/first words after .* · 40 tokens\/s · 9\.6k prompt tokens · model loaded in 4\.0 s$/);
	});
});
