import * as path from "path";

/**
 * Runs the built plugin (../main.js, ../manifest.json, ../styles.css) inside a real Obsidian that
 * wdio-obsidian-service downloads and sandboxes. The model server is a scripted stand-in started
 * by the spec, so no Ollama and no GPU are needed. Meant for CI (GitHub Actions under xvfb); it
 * opens an Obsidian window, so it is not part of `npm test`.
 */
export const config: WebdriverIO.Config = {
	runner: "local",
	framework: "mocha",
	specs: ["./specs/**/*.e2e.ts"],
	maxInstances: 1,
	capabilities: [
		{
			browserName: "obsidian",
			browserVersion: process.env.OBSIDIAN_VERSION ?? "latest",
			// Frames are drawn in software. On a desktop whose graphics card is busy (running a model,
			// say) or whose display is asleep, the GPU compositor gives the test window no animation
			// frames at all: Obsidian's sidebars then never finish opening, and every click in the chat
			// fails with "element did not become interactable". Measured on such a desktop: 5 of 9
			// specs passed without this flag, 9 of 9 with it.
			"goog:chromeOptions": { args: ["--disable-gpu"] },
			"wdio:obsidianOptions": {
				installerVersion: process.env.OBSIDIAN_INSTALLER_VERSION ?? "latest",
				plugins: [".."],
				vault: "vault",
			},
		},
	],
	services: ["obsidian"],
	reporters: ["obsidian"],
	cacheDir: path.resolve(".obsidian-cache"),
	mochaOpts: { ui: "bdd", timeout: 120000 },
	logLevel: "warn",
};
