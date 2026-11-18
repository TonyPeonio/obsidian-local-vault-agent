import { describe, expect, it } from "vitest";
import { chatModelOptions, formatModelSize, unusableReason } from "../src/model-picker";
import type { ModelInfo, RunningModel } from "../src/ollama";

const GB = 1e9;
const model = (name: string, size = 0, capabilities?: string[]): ModelInfo => ({ name, size, capabilities });
const running = (name: string, size: number, sizeVram: number): RunningModel => ({ name, size, sizeVram });

describe("the chat model picker", () => {
	it("lists only models the agent can use, when the server says what they can do", () => {
		const models = [
			model("qwen3.5:9b", 6.6 * GB, ["completion", "tools", "thinking", "vision"]),
			model("nomic-embed-text:latest", 0.27 * GB, ["embedding"]),
			model("gemma3:4b", 3.3 * GB, ["completion", "vision"]),
			model("qwen3.5:4b", 3.4 * GB, ["completion", "tools"]),
		];
		const options = chatModelOptions(models, [], "qwen3.5:9b");
		expect(options.map((o) => o.value)).toEqual(["qwen3.5:9b", "qwen3.5:4b"]);
		expect(options.every((o) => o.usable)).toBe(true);
	});

	it("falls back to the name when the server does not report capabilities", () => {
		const options = chatModelOptions([model("llama3.1:8b", 4.9 * GB), model("mxbai-embed-large", 0.67 * GB), model("bge-m3", 1.2 * GB)], [], "llama3.1:8b");
		expect(options.map((o) => o.value)).toEqual(["llama3.1:8b"]);
	});

	it("shows the size and what is in memory now", () => {
		const models = [model("qwen3.5:9b", 6.6 * GB), model("qwen3.5:4b", 3.4 * GB), model("small", 640e6)];
		const options = chatModelOptions(models, [running("qwen3.5:9b", 8.1 * GB, 8.1 * GB)], "qwen3.5:9b");
		expect(options.map((o) => o.label)).toEqual(["qwen3.5:9b · 6.6 GB · loaded", "qwen3.5:4b · 3.4 GB", "small · 640 MB"]);
		expect(options.map((o) => o.loaded)).toEqual([true, false, false]);
	});

	it("says when the loaded model spills into system RAM", () => {
		const options = chatModelOptions([model("qwen3.5:35b-a3b", 22 * GB)], [running("qwen3.5:35b-a3b", 26 * GB, 11 * GB)], "qwen3.5:35b-a3b");
		expect(options[0].label).toBe("qwen3.5:35b-a3b · 22.0 GB · loaded, partly in RAM");
	});

	it("leaves the size out when the server gives none (OpenAI-compatible servers)", () => {
		expect(chatModelOptions([model("local-model")], [], "local-model")[0].label).toBe("local-model");
		expect(formatModelSize(0)).toBe("");
		expect(formatModelSize(Number.NaN)).toBe("");
		expect(formatModelSize(400_000)).toBe("1 MB");
	});

	it("marks exactly one option as the configured model, under either spelling of its name", () => {
		const models = [model("qwen3.5:4b", 3.4 * GB), model("mistral:latest", 4.1 * GB)];
		const options = chatModelOptions(models, [], "mistral");
		expect(options.filter((o) => o.current).map((o) => o.value)).toEqual(["mistral:latest"]);
		// The stored value is the server's own spelling, which is what the picker selects.
		expect(chatModelOptions(models, [], "MISTRAL:latest").find((o) => o.current)?.value).toBe("mistral:latest");
	});

	it("keeps the configured model in the list when it is not installed", () => {
		const options = chatModelOptions([model("qwen3.5:4b", 3.4 * GB)], [], "qwen3.5:9b");
		expect(options.map((o) => o.label)).toEqual(["qwen3.5:4b · 3.4 GB", "qwen3.5:9b (not installed)"]);
		expect(options[1]).toMatchObject({ value: "qwen3.5:9b", current: true, usable: false, loaded: false });
		// The server is up but has no models at all.
		expect(chatModelOptions([], [], "qwen3.5:9b").map((o) => o.label)).toEqual(["qwen3.5:9b (not installed)"]);
		expect(chatModelOptions([], [], " ")).toEqual([]);
	});

	it("keeps a configured model that cannot be used, and says why, instead of showing another as selected", () => {
		const models = [model("qwen3.5:4b", 3.4 * GB, ["completion", "tools"]), model("gemma3:4b", 3.3 * GB, ["completion", "vision"]), model("nomic-embed-text", 0.27 * GB, ["embedding"])];
		const noTools = chatModelOptions(models, [], "gemma3:4b");
		expect(noTools.map((o) => o.label)).toEqual(["qwen3.5:4b · 3.4 GB", "gemma3:4b · 3.3 GB (cannot call tools)"]);
		expect(noTools[1]).toMatchObject({ current: true, usable: false });
		const embed = chatModelOptions(models, [], "nomic-embed-text");
		expect(embed.find((o) => o.current)?.label).toBe("nomic-embed-text · 270 MB (embedding model)");
		expect(unusableReason(models[0])).toBeNull();
	});
});
