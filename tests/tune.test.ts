import { describe, expect, it } from "vitest";
import { OllamaClient } from "../src/ollama";
import { benchmarkPrompt, genTokPerSec, measure, recommend, spillFraction, type TuneMeasurement } from "../src/tune";

const base: TuneMeasurement = {
	model: "qwen3.5:9b",
	numCtx: 32768,
	promptTokens: 2000,
	promptSeconds: 1.0,
	genTokens: 48,
	genSeconds: 0.6,
	loadSeconds: 0.2,
	sizeBytes: 8.1e9,
	vramBytes: 8.1e9,
};
const installed = [
	{ name: "qwen3.5:9b", size: 6.6e9, capabilities: ["tools", "thinking"] },
	{ name: "qwen3.5:35b-a3b", size: 22e9, capabilities: ["tools", "thinking"] },
	{ name: "qwen3.5:4b", size: 3.3e9, capabilities: ["tools"] },
	{ name: "nomic-embed-text", size: 2.7e8, capabilities: ["embedding"] },
	{ name: "old-model:7b", size: 4e9, capabilities: ["completion"] },
];

describe("recommend", () => {
	it("suggests a larger context when everything is on the GPU with speed to spare", () => {
		const a = recommend(base, installed);
		expect(genTokPerSec(base)).toBe(80);
		expect(spillFraction(base)).toBe(0);
		expect(a.headline).toMatch(/speed to spare/);
		expect(a.suggestedNumCtx).toBe(65536);
		expect(a.suggestedModel).toBeUndefined();
		expect(a.lines[0]).toContain("writes 80 tokens/s, reads 2000 tokens/s");
		expect(a.lines.join("\n")).toContain("All 8.1 GB");
		expect(a.lines.join("\n")).toContain("qwen3.5:4b (3.3 GB), qwen3.5:9b (6.6 GB) ← current, qwen3.5:35b-a3b (22.0 GB)");
		expect(a.lines.join("\n")).not.toContain("nomic-embed-text");
		expect(a.lines.join("\n")).not.toContain("old-model");
	});

	it("halves the context and names a smaller model when spilling into RAM makes it too slow", () => {
		const m: TuneMeasurement = { ...base, model: "qwen3.5:35b-a3b", numCtx: 65536, genTokens: 48, genSeconds: 8, sizeBytes: 24e9, vramBytes: 10e9 };
		const a = recommend(m, installed);
		expect(a.headline).toMatch(/Too slow/);
		expect(a.suggestedNumCtx).toBe(32768);
		expect(a.suggestedModel).toBe("qwen3.5:9b");
		expect(a.lines.join("\n")).toContain("58% of the 24.0 GB");
	});

	it("is content with a spilled but fast model, and never goes below 16k", () => {
		const m: TuneMeasurement = { ...base, numCtx: 16384, genSeconds: 2, sizeBytes: 10e9, vramBytes: 9e9 };
		const a = recommend(m, installed);
		expect(a.headline).toMatch(/Usable but slow|Fast enough/);
		expect(a.suggestedNumCtx).toBeUndefined();
	});

	it("flags a model without tool support and picks the largest tools model", () => {
		const a = recommend({ ...base, model: "old-model:7b" }, installed);
		expect(a.noTools).toBe(true);
		expect(a.headline).toMatch(/does not support tool calling/);
		expect(a.suggestedModel).toBe("qwen3.5:35b-a3b");
	});

	it("copes without /api/ps data", () => {
		const a = recommend({ ...base, sizeBytes: undefined, vramBytes: undefined }, []);
		expect(a.headline).toBe("Fast enough for agent turns.");
		expect(a.suggestedNumCtx).toBeUndefined();
	});
});

describe("measure", () => {
	it("turns Ollama's durations and /api/ps into a measurement", async () => {
		const calls: string[] = [];
		const client = new OllamaClient(() => "http://x", ((url: string, init?: RequestInit) => {
			calls.push(url);
			if (url.endsWith("/api/chat")) {
				const body = JSON.parse(String(init?.body)) as { options: Record<string, number>; messages: { content: string }[] };
				expect(body.options.num_predict).toBe(48);
				expect(body.messages[0].content).toContain("quick brown fox");
				const line = JSON.stringify({ message: { role: "assistant", content: "OK" }, done: true, prompt_eval_count: 2000, prompt_eval_duration: 1e9, eval_count: 48, eval_duration: 6e8, load_duration: 2e8 });
				return Promise.resolve(new Response(line + "\n"));
			}
			if (url.endsWith("/api/ps")) return Promise.resolve(new Response(JSON.stringify({ models: [{ name: "m", size: 100, size_vram: 60, context_length: 32768 }] })));
			return Promise.resolve(new Response("{}", { status: 404 }));
		}) as typeof fetch);
		const m = await measure(client, "m", 32768);
		expect(m).toEqual({ model: "m", numCtx: 32768, promptTokens: 2000, promptSeconds: 1, genTokens: 48, genSeconds: 0.6, loadSeconds: 0.2, sizeBytes: 100, vramBytes: 60 });
		expect(benchmarkPrompt("1")).not.toBe(benchmarkPrompt("2"));
	});
});
