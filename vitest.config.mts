import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
	test: {
		include: ["tests/**/*.test.ts"],
		environment: "node",
		setupFiles: ["tests/setup.ts"],
	},
	resolve: {
		alias: {
			obsidian: path.resolve(__dirname, "tests/obsidian-mock.ts"),
		},
	},
});
