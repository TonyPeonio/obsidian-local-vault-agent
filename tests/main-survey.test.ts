import { describe, expect, it } from "vitest";
import LocalVaultAgentPlugin from "../src/main";

/** countAnswer only touches the settings and saves them, so it runs on a stand-in for the plugin. */
function plugin(survey: "ask" | "done", answeredTurns = 0) {
	const p = { settings: { survey, answeredTurns }, saves: 0, saveSettings: async () => void p.saves++ };
	return p;
}
const countAnswer = (p: ReturnType<typeof plugin>) => LocalVaultAgentPlugin.prototype.countAnswer.call(p as unknown as LocalVaultAgentPlugin);

describe("the feedback survey", () => {
	it("is offered once, after the fifth answer, even when the card is ignored", async () => {
		const p = plugin("ask");
		const asked: boolean[] = [];
		for (let i = 0; i < 9; i++) asked.push(await countAnswer(p));
		expect(asked).toEqual([false, false, false, false, true, false, false, false, false]);
		expect(p.settings.survey).toBe("done");
		// Nothing left to count after it was shown: no more writes of the settings file per answer.
		expect(p.saves).toBe(5);
	});

	it("is shown once to someone who already had more than five answers, and never when done", async () => {
		const late = plugin("ask", 12);
		expect(await countAnswer(late)).toBe(true);
		expect(await countAnswer(late)).toBe(false);
		const done = plugin("done", 2);
		expect(await countAnswer(done)).toBe(false);
		expect(done.saves).toBe(0);
	});

	it("shows one card when two chats finish an answer at the same moment", async () => {
		const p = plugin("ask", 4);
		expect(await Promise.all([countAnswer(p), countAnswer(p)])).toEqual([true, false]);
	});
});
