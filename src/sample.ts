/**
 * "Try it on sample notes": a small folder of notes that link to each other, with a decision, a
 * person, a lecture in Lecture Companion's shape and a daily note, so a new user gets a cited
 * answer to a real question within a minute of installing. Pure: just the notes and questions.
 */

export const SAMPLE_FOLDER = "Local Vault Agent sample";

export const SAMPLE_QUESTIONS = [
	"Why did I switch the garden lights to 18650 cells, and when?",
	"What did the professor say about the Calvin cycle, and at what time in the lecture?",
	"Who helped me with the soldering, and what did they suggest?",
];

export function sampleNotes(folder = SAMPLE_FOLDER): { path: string; content: string }[] {
	const f = folder.replace(/^\/+|\/+$/g, "");
	const p = (name: string) => `${f}/${name}.md`;
	const link = (name: string) => `[[${f}/${name}|${name.split("/").pop()}]]`;
	return [
		{
			path: p("Start here"),
			content: [
				"# Start here",
				"",
				"These notes are a small sample vault for trying Local Vault Agent. Ask the chat a question about them and the answer cites the notes, down to the paragraph.",
				"",
				`- ${link("Projects/Solar garden lights")} — a weekend project with a decision in it`,
				`- ${link("People/Priya Raman")} — who helped`,
				`- ${link("Lectures/BIO 101 2026-02-10")} — a recorded lecture with a timestamped transcript`,
				`- ${link("Daily/2026-03-04")} — a daily note`,
				"",
				"Delete this folder whenever you like; the agent never needs it.",
				"",
			].join("\n"),
		},
		{
			path: p("Projects/Solar garden lights"),
			content: [
				"# Solar garden lights",
				"",
				"Six path lights along the vegetable beds, each with a small panel and a battery.",
				"",
				"## Status",
				"",
				"Four lights installed, two waiting for a dry weekend.",
				"",
				"## Decisions",
				"",
				`- **2026-03-04: switched from AA NiMH to 18650 lithium cells.** The AA packs were flat by 22:00 in February; one 18650 (3000 mAh) keeps a light on all night, and the cells are reused from an old laptop battery. ${link("People/Priya Raman")} suggested adding a protection board per cell, so each light now has a TP4056 charger with protection.`,
				"- 2026-02-20: warm white LEDs (2700 K) instead of cold white, which looked harsh next to the beds.",
				"",
				"## Parts",
				"",
				"| Part | Count |",
				"|---|---|",
				"| 6 V 1 W panel | 6 |",
				"| 18650 cell | 6 |",
				"| TP4056 with protection | 6 |",
				"",
				"Log: " + link("Daily/2026-03-04"),
				"",
			].join("\n"),
		},
		{
			path: p("People/Priya Raman"),
			content: [
				"# Priya Raman",
				"",
				"Neighbour, electrical engineer, runs the repair café on the first Saturday of the month.",
				"",
				`- Helped me solder the battery holders for the ${link("Projects/Solar garden lights")} on 2026-03-04.`,
				"- Suggested a protection board per 18650 cell: an unprotected cell left in a hot enclosure all summer is the one thing that could start a fire.",
				"- Lent me her temperature-controlled iron; give it back with a new tip.",
				"",
			].join("\n"),
		},
		{
			path: p("Daily/2026-03-04"),
			content: [
				"# 2026-03-04",
				"",
				"## Done",
				"",
				`- Soldered the battery holders with ${link("People/Priya Raman")}; switched the lights to 18650 cells.`,
				"- Read chapter 3 of the biology reading.",
				"",
				"## Capture",
				"",
				"- Ask the hardware shop about weatherproof cable glands.",
				"",
			].join("\n"),
		},
		{
			path: p("Lectures/BIO 101 2026-02-10"),
			content: [
				"---",
				"course: BIO 101",
				"date: 2026-02-10",
				"---",
				"# BIO 101: Photosynthesis",
				"",
				"## Summary",
				"",
				"- Light reactions in the thylakoids make ATP and NADPH [3:15]",
				"- The Calvin cycle in the stroma fixes CO₂ with RuBisCO [12:40]",
				"- Exam: the two stages and where each happens [24:05]",
				"",
				"## Transcript",
				"",
				"**[0:05]** Good morning. Today is photosynthesis, which is really two processes glued together.",
				"",
				"**[3:15]** The light reactions happen in the thylakoid membranes. Light splits water, oxygen comes off as a by-product, and the energy ends up in ATP and NADPH.",
				"",
				"**[12:40]** The Calvin cycle runs in the stroma and does not need light directly. RuBisCO fixes carbon dioxide onto a five-carbon sugar, and it spends the ATP and NADPH from the light reactions. RuBisCO is slow and sometimes grabs oxygen instead, which is why plants make so much of it.",
				"",
				"**[24:05]** For the exam, know the two stages, where each happens, and what passes between them.",
				"",
			].join("\n"),
		},
	];
}
