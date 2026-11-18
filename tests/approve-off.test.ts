import { describe, expect, it } from "vitest";
import { Agent, newConversation, type AgentConfig } from "../src/agent";
import LocalVaultAgentPlugin from "../src/main";
import { keywordSearch } from "../src/search";
import { DEFAULT_SETTINGS } from "../src/settings";
import { ALL_TOOLS } from "../src/tools";
import { FakeOllama, FakeVault, type Scripted } from "./fakes";

/**
 * "Turn off" in the chat's bar while a turn is running: the very next write of that turn has to show
 * its diff again, whether what was on is this chat's "approve all" or the global setting. Run on the
 * real agent loop, with the configuration the plugin really hands it.
 */

/** The plugin's agentConfig() over a settings object the test can change, as the "Turn off" button does. */
function pluginConfig(autoApproveEdits: boolean) {
	const settings = { ...DEFAULT_SETTINGS, autoApproveEdits };
	const client = new FakeOllama([]).asClient();
	const getConfig = (): AgentConfig => LocalVaultAgentPlugin.prototype.agentConfig.call({ settings, client } as unknown as LocalVaultAgentPlugin);
	return { settings, getConfig };
}

const TWO_WRITES: Scripted[] = [
	{ tool: "edit_note", args: { path: "Ideas/Sensors", old_text: "cheap", new_text: "pricey" } },
	{ tool: "append_to_note", args: { path: "Ideas/Sensors", content: "More." } },
	{ content: "ok" },
];

function setup(getConfig: () => AgentConfig, decision: "approve" | "approve-all" | "reject") {
	const vault = new FakeVault({ "Ideas/Sensors.md": "Hall sensors are cheap." });
	const asked: string[] = [];
	const agent = new Agent({
		client: new FakeOllama(TWO_WRITES).asClient(),
		vault,
		tools: ALL_TOOLS,
		search: (q, l) => keywordSearch(vault, q, l),
		approve: async (req) => {
			asked.push(req.summary);
			return decision;
		},
		getConfig,
		now: () => new Date("2026-11-05T12:00:00Z"),
	});
	return { vault, agent, asked };
}

describe("turning 'approve all' off in the middle of a turn", () => {
	it("shows the diff of the next write when the global setting is switched off", async () => {
		const { settings, getConfig } = pluginConfig(true);
		const { agent, asked, vault } = setup(getConfig, "reject");
		let done = 0;
		await agent.run(newConversation(), "x", {
			onToolDone: () => {
				// After the first write went through unasked, the user clicks "Turn off".
				if (++done === 1) settings.autoApproveEdits = false;
			},
		});
		expect(asked).toEqual(["Append to Ideas/Sensors.md"]);
		// The first write was made without a diff, the second was shown and rejected.
		expect(await vault.read("Ideas/Sensors.md")).toBe("Hall sensors are pricey.");
	});

	it("keeps writing unasked while the setting stays on", async () => {
		const { getConfig } = pluginConfig(true);
		const { agent, asked, vault } = setup(getConfig, "reject");
		await agent.run(newConversation(), "x", {});
		expect(asked).toEqual([]);
		expect(await vault.read("Ideas/Sensors.md")).toBe("Hall sensors are pricey.\n\nMore.\n");
	});

	it("shows the diff of the next write when this chat's approve-all is switched off", async () => {
		const { getConfig } = pluginConfig(false);
		const { agent, asked } = setup(getConfig, "approve");
		const conv = newConversation();
		conv.approveAll = true;
		let done = 0;
		await agent.run(conv, "x", {
			onToolDone: () => {
				if (++done === 1) conv.approveAll = false;
			},
		});
		expect(asked).toHaveLength(1);
		expect(asked[0]).toContain("Ideas/Sensors.md");
		// Approving that one change does not switch it back on.
		expect(conv.approveAll).toBe(false);
	});
});
