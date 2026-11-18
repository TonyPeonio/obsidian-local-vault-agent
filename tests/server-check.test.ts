import { describe, expect, it } from "vitest";
import LocalVaultAgentPlugin from "../src/main";
import type { ModelInfo } from "../src/ollama";
import { checksServerAtStartup, serverProblem, type ServerCheck } from "../src/setup";

const model = (name: string): ModelInfo => ({ name, size: 1 });
const base: ServerCheck = { provider: "ollama", baseUrl: "http://localhost:11434", models: [model("qwen3.5:9b"), model("nomic-embed-text:latest")], chatModel: "qwen3.5:9b", embeddingModel: "nomic-embed-text", semanticSearch: true };

describe("what is wrong with the server, in one sentence", () => {
	it("is nothing when the server answers and the chosen models are installed", () => {
		expect(serverProblem(base)).toBeNull();
		// The embedding model does not matter when semantic search is off.
		expect(serverProblem({ ...base, models: [model("qwen3.5:9b")], semanticSearch: false })).toBeNull();
	});

	it("names the server and its address when it does not answer", () => {
		const ollama = serverProblem({ ...base, models: null, serverError: "net::ERR_CONNECTION_REFUSED" })!;
		expect(ollama.message).toBe("Local Vault Agent cannot reach Ollama at http://localhost:11434 (net::ERR_CONNECTION_REFUSED). Start it or fix the URL in settings.");
		expect(ollama.log).toBe("Server unreachable at http://localhost:11434 (net::ERR_CONNECTION_REFUSED)");
		const other = serverProblem({ ...base, provider: "openai", baseUrl: "http://localhost:1234/v1", models: null })!;
		expect(other.message).toBe("Local Vault Agent cannot reach the model server at http://localhost:1234/v1. Start it or fix the URL in settings.");
	});

	it("names the models that are not installed", () => {
		expect(serverProblem({ ...base, models: [model("nomic-embed-text:latest")] })!.message).toBe("Local Vault Agent: model not installed: qwen3.5:9b. Open the setup checklist to download it, or pick another model in settings.");
		const both = serverProblem({ ...base, models: [] })!;
		expect(both.message).toContain("models not installed: qwen3.5:9b, nomic-embed-text.");
		expect(both.message).toContain("download them");
		expect(both.log).toBe("Models not installed: qwen3.5:9b, nomic-embed-text");
	});

	it("is looked at when Obsidian starts only if a scheduled job is switched on", () => {
		expect(checksServerAtStartup({ nightlyDaily: false, weeklyDigest: false })).toBe(false);
		expect(checksServerAtStartup({ nightlyDaily: true, weeklyDigest: false })).toBe(true);
		expect(checksServerAtStartup({ nightlyDaily: false, weeklyDigest: true })).toBe(true);
	});
});

/** checkOllamaOnce on a stand-in for the plugin: a server that is down, and the notices it would show. */
function plugin(listModels: () => Promise<ModelInfo[]>) {
	const p = {
		ollamaChecked: false,
		settings: { provider: "ollama" as const, model: "qwen3.5:9b", embeddingModel: "nomic-embed-text", semanticSearch: true },
		client: { baseUrl: "http://localhost:11434", listModels, requests: 0 },
		notices: [] as string[],
		notifyError: (message: string) => void p.notices.push(message),
	};
	const real = listModels;
	p.client.listModels = () => {
		p.client.requests++;
		return real();
	};
	return p;
}
const check = (p: ReturnType<typeof plugin>, quiet?: boolean) => LocalVaultAgentPlugin.prototype.checkOllamaOnce.call(p as unknown as LocalVaultAgentPlugin, quiet);
const down = async (): Promise<ModelInfo[]> => {
	throw new Error("connection refused");
};

describe("the server check", () => {
	it("shows nothing at start-up when the server is down, and keeps the one notice for when the user opens the chat", async () => {
		const p = plugin(down);
		// Start-up, with a scheduled job switched on: looked at, logged, not shown.
		await check(p, true);
		expect(p.client.requests).toBe(1);
		expect(p.notices).toEqual([]);
		// The user opens the chat: now it is said, once.
		await check(p);
		expect(p.notices.length).toBe(1);
		expect(p.notices[0]).toContain("cannot reach Ollama at http://localhost:11434 (connection refused)");
		// Every later command or message in the session: nothing more, not even a request.
		await check(p);
		await check(p, true);
		expect(p.notices.length).toBe(1);
		expect(p.client.requests).toBe(2);
	});

	it("says nothing when all is well", async () => {
		const p = plugin(async () => [model("qwen3.5:9b"), model("nomic-embed-text:latest")]);
		await check(p, true);
		await check(p);
		expect(p.notices).toEqual([]);
	});

	it("reports a missing model once", async () => {
		const p = plugin(async () => [model("nomic-embed-text:latest")]);
		await check(p);
		await check(p);
		expect(p.notices).toEqual(["Local Vault Agent: model not installed: qwen3.5:9b. Open the setup checklist to download it, or pick another model in settings."]);
	});
});
