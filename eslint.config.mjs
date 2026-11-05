import { defineConfig, globalIgnores } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
	globalIgnores(["node_modules", "main.js", ".e2e", "esbuild.config.mjs", "version-bump.mjs", "vitest.config.mts", "scripts", "tests", "test-vault"]),
	...obsidianmd.configs.recommended,
	{
		languageOptions: {
			parserOptions: {
				projectService: { allowDefaultProject: ["eslint.config.*", "vitest.config.*"] },
			},
		},
	},
]);
