import { describe, expect, it } from "vitest";
import { canonicalModelName, placementWarning, sameModel } from "../src/ollama";

describe("placementWarning", () => {
	it("warns when the chat model is partly in system RAM and names the fix", () => {
		const running = [
			{ name: "qwen3.5:9b", size: 12.6e9, sizeVram: 9.1e9, contextLength: 98304 },
			{ name: "nomic-embed-text:latest", size: 0.3e9, sizeVram: 0.3e9 },
		];
		expect(placementWarning(running, "qwen3.5:9b")).toMatch(/only partly on the GPU \(9\.1 of 12\.6 GB at a 96k context\).*Lower the context window/);
		expect(placementWarning(running, "nomic-embed-text")).toBeUndefined();
		expect(placementWarning([{ name: "qwen3.5:9b", size: 8e9, sizeVram: 8e9 }], "qwen3.5:9b")).toBeUndefined();
		expect(placementWarning([], "qwen3.5:9b")).toBeUndefined();
	});
});

describe("model names", () => {
	it("treats an untagged name and its :latest form as the same model, case-insensitively", () => {
		expect(sameModel("nomic-embed-text", "nomic-embed-text:latest")).toBe(true);
		expect(sameModel("nomic-embed-text:latest", "nomic-embed-text")).toBe(true);
		expect(sameModel("Qwen3.5:9b", "qwen3.5:9b")).toBe(true);
		expect(sameModel(" qwen3.5:9b ", "qwen3.5:9b")).toBe(true);
	});

	it("keeps different tags and different names apart", () => {
		expect(sameModel("qwen3.5:9b", "qwen3.5:4b")).toBe(false);
		expect(sameModel("qwen3.5:9b", "qwen3.5")).toBe(false);
		expect(sameModel("nomic-embed-text", "mxbai-embed-large")).toBe(false);
		expect(sameModel("hf.co/OBLITERATUS/gemma-4-E4B-it-OBLITERATED:Q4_K_M", "hf.co/obliteratus/gemma-4-e4b-it-obliterated:q4_k_m")).toBe(true);
	});

	it("canonicalises the way ollama list reports names", () => {
		expect(canonicalModelName("nomic-embed-text:latest")).toBe("nomic-embed-text");
		expect(canonicalModelName("qwen3.5:9b")).toBe("qwen3.5:9b");
		expect(canonicalModelName("")).toBe("");
	});

	it("finds an installed model in a listing the way the startup check and the settings test do", () => {
		const listed = [{ name: "nomic-embed-text:latest" }, { name: "qwen3.5:9b" }];
		const missing = ["qwen3.5:9b", "nomic-embed-text", "phi4:14b"].filter((want) => !listed.some((m) => sameModel(m.name, want)));
		expect(missing).toEqual(["phi4:14b"]);
	});
});
