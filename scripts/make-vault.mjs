// Generates a large, deterministic, purely synthetic vault for the live test harness:
// a CS student's notes with courses, lectures (recordings + summaries), daily notes,
// projects, clubs, reading, people, recipes and messy inbox notes. Nothing here is real.
//
//   node scripts/make-vault.mjs [outDir]      (default: test-vault-large)
//
// Also writes scripts/large-facts.json: the "landmark" facts the scenarios ask about.
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const here = dirname(fileURLToPath(import.meta.url));
const out = process.argv[2] ?? join(here, "..", "test-vault-large");

// Deterministic PRNG (mulberry32).
let seed = 20261105;
const rand = () => {
	seed |= 0;
	seed = (seed + 0x6d2b79f5) | 0;
	let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
	t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const chance = (p) => rand() < p;
const S1 = ["We spent most of the hour on", "The lecture opened with", "Half the class struggled with", "The key takeaway was", "A long tangent covered", "The worked example used"];
const S2 = ["which connects back to last week", "and the proof is on the slides", "but the notation was inconsistent", "so I need to redo the derivation", "and there is a homework problem on it", "which the TA explained again afterwards"];
const S3 = ["I should re-read the textbook section.", "Worth a flashcard.", "Probably on the exam.", "Ask in office hours.", "Compare with the Wikipedia derivation.", "Try it in code tonight."];
const prose = (topic, n = 3) => Array.from({ length: n }, () => `${pick(S1)} ${topic.toLowerCase()}, ${pick(S2)}. ${pick(S3)}`).join(" ");

const files = new Map();
const attachments = [];
const put = (path, content) => files.set(path, content.replace(/\n{3,}/g, "\n\n").trimEnd() + "\n");

const date = (y, m, d) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const recName = (d, hh, mm) => `Recording ${d.replace(/-/g, "")}${hh}${mm}${String(Math.floor(rand() * 60)).padStart(2, "0")}.m4a`;

// ---------------------------------------------------------------- courses
const courses = [
	{
		code: "CSCI 406", name: "Algorithms", folder: "School/CSCI 406 - Algorithms", day: 2,
		topics: ["Asymptotic notation and recurrences", "Divide and conquer: Strassen", "Dynamic programming: edit distance", "Greedy: interval scheduling", "Graph search: BFS and DFS", "Dijkstra with a binary heap", "Bellman-Ford and negative cycles", "Max flow: Ford-Fulkerson", "NP-completeness: reductions", "Approximation algorithms"],
		terms: [["master theorem", "T(n) = aT(n/b) + f(n)"], ["Strassen", "7 multiplications instead of 8"], ["edit distance", "Levenshtein"], ["exchange argument", "interval scheduling by earliest finish"], ["BFS", "shortest paths in unweighted graphs"], ["Dijkstra", "O((V+E) log V) with a binary heap"], ["Bellman-Ford", "detects negative cycles after V-1 rounds"], ["Ford-Fulkerson", "augmenting paths; Edmonds-Karp uses BFS"], ["3-SAT", "reduce to CLIQUE"], ["vertex cover", "2-approximation via maximal matching"]],
	},
	{
		code: "CSCI 470", name: "Machine Learning", folder: "School/CSCI 470 - Machine Learning", day: 3,
		topics: ["Linear regression and least squares", "Logistic regression", "Regularisation: ridge and lasso", "Decision trees", "Random forests and boosting", "SVMs and kernels", "k-means and GMMs", "PCA", "Neural networks and backprop", "Anomaly detection"],
		terms: [["normal equations", "(XᵀX)⁻¹Xᵀy"], ["sigmoid", "cross-entropy loss"], ["lasso", "L1 drives weights to zero"], ["Gini impurity", "information gain"], ["bagging", "AdaBoost reweights misclassified points"], ["kernel trick", "RBF kernel"], ["EM algorithm", "soft assignments"], ["eigenvectors of the covariance", "explained variance"], ["chain rule", "vanishing gradients"], ["isolation forest", "anomalies are isolated in fewer splits"]],
	},
	{
		code: "CSCI 478", name: "Bioinformatics", folder: "School/CSCI 478 - Bioinformatics", day: 4,
		topics: ["Sequence alignment: Needleman-Wunsch", "Smith-Waterman local alignment", "BLAST heuristics", "Hidden Markov models for gene finding", "Phylogenetic trees", "Protein structure levels", "Alanine scanning", "RNA folding: Nussinov", "Genome assembly: de Bruijn graphs", "Multiple sequence alignment"],
		terms: [["global alignment", "gap penalties"], ["local alignment", "zero floor in the DP"], ["k-mer seeds", "E-value"], ["Viterbi", "forward-backward"], ["UPGMA", "neighbour joining"], ["primary, secondary, tertiary, quaternary", "alpha helix and beta sheet"], ["alanine scanning", "mutate residues to alanine to find binding hot spots"], ["Nussinov", "maximise base pairs"], ["de Bruijn graph", "Eulerian path"], ["ClustalW", "progressive alignment"]],
	},
	{
		code: "CSCI 370", name: "Advanced Software Engineering", folder: "School/CSCI 370 - Advanced Software Engineering", day: 1,
		topics: ["Requirements and user stories", "Architecture decision records", "Testing pyramid", "CI/CD pipelines", "Code review practice", "Observability", "Technical debt", "Agile retrospectives", "Security basics", "Release management"],
		terms: [["INVEST", "acceptance criteria"], ["ADR", "context, decision, consequences"], ["unit, integration, e2e", "flaky tests"], ["pipeline stages", "artifact attestation"], ["small PRs", "review latency"], ["logs, metrics, traces", "SLOs"], ["interest on debt", "refactoring budget"], ["start/stop/continue", "action items"], ["OWASP top 10", "least privilege"], ["semantic versioning", "changelogs"]],
	},
	{
		code: "MATH 332", name: "Linear Algebra", folder: "School/MATH 332 - Linear Algebra", day: 2,
		topics: ["Vector spaces", "Linear maps and matrices", "Determinants", "Eigenvalues", "Diagonalisation", "Inner products", "Gram-Schmidt", "SVD", "Least squares", "Jordan form"],
		terms: [["span and basis", "dimension"], ["kernel and image", "rank-nullity"], ["cofactor expansion", "det(AB) = det(A)det(B)"], ["characteristic polynomial", "algebraic multiplicity"], ["diagonalisable iff", "n independent eigenvectors"], ["Cauchy-Schwarz", "orthogonal projection"], ["orthonormal basis", "QR"], ["singular values", "low-rank approximation"], ["normal equations", "projection onto the column space"], ["Jordan blocks", "generalised eigenvectors"]],
	},
	{
		code: "PHGN 200", name: "Physics II", folder: "School/PHGN 200 - Physics II", day: 5,
		topics: ["Coulomb's law", "Electric fields", "Gauss's law", "Electric potential", "Capacitors", "Current and resistance", "DC circuits", "Magnetic fields", "Faraday's law", "Inductance"],
		terms: [["inverse square", "superposition"], ["field lines", "dipoles"], ["flux", "symmetry"], ["equipotentials", "V = kq/r"], ["parallel plates", "dielectrics"], ["Ohm's law", "resistivity"], ["Kirchhoff", "RC time constant"], ["Lorentz force", "Biot-Savart"], ["induced EMF", "Lenz's law"], ["self-inductance", "LR circuits"]],
	},
];

const facts = { lectures: [], decisions: [], people: [], recordings: { withSummary: [], withoutSummary: [] }, counts: {} };

for (const c of courses) {
	const sections = [];
	for (let i = 0; i < c.topics.length; i++) {
		const week = i + 1;
		const d = date(2026, week <= 5 ? 9 : 10, week <= 5 ? 1 + c.day + (week - 1) * 7 : 1 + c.day + (week - 6) * 7);
		const [term, detail] = c.terms[i];
		const hasRecording = chance(0.6);
		const hasSummary = hasRecording ? chance(0.6) : chance(0.3);
		const rec = hasRecording ? recName(d, String(12 + (i % 4)), "30") : null;
		if (rec) {
			attachments.push({ path: rec, size: 20_000_000 + Math.floor(rand() * 30_000_000) });
			(hasSummary ? facts.recordings.withSummary : facts.recordings.withoutSummary).push({ note: `${c.folder}/Lectures - ${c.code}.md`, rec });
		}
		const lines = [`## ${d}`, "", `**Topic:** ${c.topics[i]}`, ""];
		if (rec) lines.push(`![[${rec}]]`, "");
		lines.push(prose(c.topics[i], 3 + Math.floor(rand() * 3)), "");
		lines.push(
			`- Key idea: ${term}.`,
			`- Definition: ${detail}; ${pick(["see the textbook", "derived on the board", "stated without proof", "proved by induction"])}.`,
			`- Example: ${pick(["n = 8", "a 3×3 matrix", "the toy graph with 5 nodes", "the sequence ACGTAC", "a two-class dataset", "a parallel-plate capacitor"])}.`,
			`- Detail: ${detail}.`,
			`- ${pick(["Worked example on the board", "Clicker question most people got wrong", "Short quiz at the start", "Guest explanation from the TA"])}.`,
		);
		if (chance(0.4)) lines.push(`- [ ] Activity: ${pick(["finish the worksheet", "read chapter " + (i + 2), "redo the proof at home", "try the code sample"])}`);
		if (hasSummary) lines.push("", "### Summary", "", `- ${c.topics[i]} boils down to ${term}; remember ${detail}.`, `- Likely on the ${week <= 5 ? "midterm" : "final"}.`);
		sections.push(lines.join("\n"));
		facts.lectures.push({ course: c.code, date: d, topic: c.topics[i], term, note: `${c.folder}/Lectures - ${c.code}.md` });
	}
	put(`${c.folder}/Lectures - ${c.code}.md`, `# ${c.name} lectures\n\nRunning notes for ${c.code}. Overview: [[${c.code}]].\n\n${sections.join("\n\n")}`);
	put(
		`${c.folder}/${c.code}.md`,
		[
			"---", `course: "${c.code}"`, `tags: [course, fall2026]`, "---",
			`# ${c.code} — ${c.name}`,
			"",
			`Instructor office hours ${pick(["Mon 2–3", "Tue 10–11", "Wed 1–2", "Thu 3–4"])}. Lectures: [[Lectures - ${c.code}]].`,
			"",
			"## Grading",
			"- Homework 30%",
			"- Midterm 25%",
			"- Final 35%",
			"- Participation 10%",
			"",
			"## To do",
			`- [ ] HW${Math.floor(rand() * 4) + 3} due ${date(2026, 11, 7 + Math.floor(rand() * 10))}`,
			"- [x] Set up the course repo",
			"",
			"## Links",
			`- [[People/${pick(["Dr. Beeler", "Prof. Okafor", "Dr. Lindqvist"])}]]`,
		].join("\n"),
	);
	for (let a = 1; a <= 3; a++) {
		put(`${c.folder}/HW${a} - ${c.code}.md`, `# HW${a} ${c.code}\n\nDue ${date(2026, 9 + Math.floor(a / 2), 10 * a)}.\n\n## Problems\n\n1. ${c.terms[a][0]} — ${c.terms[a][1]}.\n2. Prove or disprove: ${pick(["the greedy choice is optimal", "the bound is tight", "the matrix is invertible"])}.\n3. Implement and test.\n\n## Notes\n\n- Started ${pick(["late", "early", "on time"])}, ${pick(["stuck on 2", "finished 1 and 3", "need office hours"])}.\n- See [[Lectures - ${c.code}#${facts.lectures.find((l) => l.course === c.code).date}]].\n`);
	}
}

// ---------------------------------------------------------------- projects
put(
	"Projects/Chess Robot.md",
	`---
tags: [project, robotics, kirin]
status: active
---
# Chess Robot

An autonomous chess board: a gantry under the board moves pieces with an electromagnet; 64 hall sensors (plus 32 in the storage rails) read the position. Engine: [[Kirin Engine]].

## Status

Playing full games at 24V since mid-October. Knight routing through gaps works; capture-to-storage is 95% reliable.

## Decisions

- 2026-09-20 — Use A3144 hall sensors polled at 50 Hz over the shift-register chain (see [[Hall Sensors]]).
- 2026-10-14 — Switch the gantry supply from 12V to **24V** after repeated brownouts during fast diagonal moves ([[Daily/2026-10-14]]).
- 2026-10-21 — Re-home against the limit switches every 50 moves to kill the 1.5 mm drift.

## Open problems

- The magnet sometimes drags a neighbouring piece when it passes within ~8 mm. Tried lowering current near occupied squares and routing through square centres; a mu-metal shield is the next idea ([[Ideas/Magnet shielding]]).
- Knight moves need a path through the gaps between squares; corner cases near the board edge still fail.
- Pawn promotion needs a piece from storage; storage slot mapping is manual.

## Log

- 2026-09-02 Built the frame. [[People/Marcus Vale]] helped with the aluminium extrusions.
- 2026-09-18 First full move sequence.
- 2026-10-03 Brownout during e2e4 → queen fell over. Logged in [[Daily/2026-10-03]].
- 2026-10-14 24V conversion done.
- 2026-10-28 Demo for [[Clubs/Society of Quantum Engineers]].
`,
);
put(
	"Projects/Kirin Engine.md",
	`# Kirin Engine

C++ chess engine used by the [[Chess Robot]] and the lichess bot. Bitboards, magic bitboards, PVS, NNUE.

## Search

- Iterative deepening with aspiration windows.
- LMR after the first 3 moves at depth ≥ 3.
- Null move pruning with R=2+depth/6.

## Evaluation

- NNUE net \`kirin-2026-10.knnue\`, 768→256→1, trained on 40M positions ([[NNUE Training]]).
- Classical fallback with piece-square tables.

## Benchmarks

| Date | Nodes/s | Elo vs previous |
|---|---|---|
| 2026-09-10 | 1.2M | — |
| 2026-10-05 | 1.5M | +18 ± 9 |
| 2026-10-26 | 1.6M | +6 ± 8 |

## To do

- [ ] SPRT the new LMR formula at 200k nodes.
- [ ] Fix the time-management blunder when under 5 seconds.
`,
);
put("Projects/NNUE Training.md", `# NNUE Training\n\nPipeline: PGN → CSV → train_nnue.py → convert_nnue.py.\n\n## Runs\n\n- 2026-09-25: 20M positions, 12 epochs, val loss 0.082.\n- 2026-10-15: 40M positions, 15 epochs, val loss 0.071. **Best so far.** Used in [[Kirin Engine]].\n\n## Notes\n\n- Learning rate 1e-3 with cosine decay works; 3e-3 diverges.\n- Batch 16384 fits on the 5070 at 12 GB.\n`);
put(
	"Projects/Hall Sensors.md",
	`# Hall Sensors

A3144 digital hall sensors under each square, read through 74HC165 shift registers at 50 Hz.

## Lessons

- Magnets must all be oriented the same way or some pieces never trigger.
- 50 Hz polling is plenty; 200 Hz caused crosstalk on the long ribbon cable.
- Debounce for 3 samples before reporting a change.

## Wiring

- 12 registers in a chain, clock and latch shared, data daisy-chained.
- Pull-ups 10k.

Related: [[Chess Robot]], [[Ideas/Magnet shielding]].
`,
);
put("Projects/Lecture Companion.md", `# Lecture Companion\n\nAn Obsidian plugin that records lectures, transcribes live with whisper.cpp and pulls slides from Canvas.\n\n## Plan\n\n- whisper-server managed by the plugin, large-v3-turbo, 16 threads on the laptop.\n- Canvas token in settings; slides as PDF/PPTX into the lecture note.\n\n## Open questions\n\n- Attachment folder in the test vault is the root — set one.\n- Does the policy allow downloading the binary? (No — guided install.)\n`);
for (const [name, year] of [["Line Follower Bot", 2025], ["Weather Station", 2025], ["Portfolio Site", 2025], ["Raytracer", 2025], ["Sudoku Solver", 2025]]) {
	put(`Projects/${name}.md`, `---\ntags: [project, archived]\nstatus: done\n---\n# ${name} (${year})\n\nFinished in ${year}. ${pick(["Won second place at the club showcase.", "Shelved after the semester.", "Still used occasionally.", "Code on GitHub."])}\n\n## What I learned\n\n- ${pick(["Start the write-up early.", "Mock the hardware.", "Tests catch regressions.", "Document the wiring."])}\n- ${pick(["Power supplies matter.", "Keep a log.", "Name files consistently."])}\n`);
}
facts.decisions.push({ q: "power supply", answer: "24V", date: "2026-10-14", note: "Projects/Chess Robot.md" });

// ---------------------------------------------------------------- people
const people = [
	["Dr. Beeler", "Advisor for the chess robot. Meets every other Monday. Likes concrete demos; hates slide decks."],
	["Prof. Okafor", "Teaches Algorithms. Office hours Tue 10–11. Strict on proofs."],
	["Dr. Lindqvist", "Teaches ML. Recommends Bishop's book. Runs the anomaly-detection reading group."],
	["Marcus Vale", "Friend from the makerspace. Owns the big CNC. Helped with the robot frame."],
	["Priya Natarajan", "MEAL Club president. Organises the potlucks."],
	["Sam Delgado", "Lab partner in Physics II. Good at circuits."],
	["Ana Rocha", "Runs the quantum engineers society; pushing for the hackathon."],
	["Jordan Kim", "TA for Bioinformatics. Knows BLAST inside out."],
	["Lena Faber", "Internship recruiter contact. Follow up in November."],
	["Tomás Herrera", "Chess club. Rated 1900. Tested the robot and found the drag bug."],
];
for (const [name, blurb] of people) {
	put(`People/${name}.md`, `---\ntags: [person]\n---\n# ${name}\n\n${blurb}\n\n## Interactions\n\n- ${date(2026, 9, 1 + Math.floor(rand() * 28))} — ${pick(["coffee", "lab", "email", "office hours"])}: ${pick(["discussed the robot", "asked about the exam", "planned the hackathon", "fixed the wiring"])}.\n- ${date(2026, 10, 1 + Math.floor(rand() * 28))} — ${pick(["meeting", "call", "hallway"])}: ${pick(["follow up next week", "sent the slides", "agreed on dates"])}.\n`);
	facts.people.push(name);
}

// ---------------------------------------------------------------- clubs
put(
	"Clubs/MEAL Club.md",
	`# MEAL Club

Make Everything And Lunch. Weekly on Mondays. President: [[People/Priya Natarajan]].

## 2026-09-14 meeting

![[${(() => { const r = recName("2026-09-14", "13", "06"); attachments.push({ path: r, size: 18_000_000 }); facts.recordings.withSummary.push({ note: "Clubs/MEAL Club.md", rec: r }); return r; })()}]]

### Summary

- Potluck on the 30th; bring a dish and a recipe card.
- Budget request for a second 3D printer approved.

## 2026-09-21 meeting

![[${(() => { const r = recName("2026-09-21", "13", "06"); attachments.push({ path: r, size: 21_000_000 }); facts.recordings.withoutSummary.push({ note: "Clubs/MEAL Club.md", rec: r }); return r; })()}]]

- Talked about the showcase; nobody took notes.

## 2026-10-12 meeting

- Showcase date set: 2026-11-20.
- [[Projects/Chess Robot]] will be demoed.
`,
);
put(
	"Clubs/Society of Quantum Engineers.md",
	`# Society of Quantum Engineers

Run by [[People/Ana Rocha]].

## 2026-09-09

![[${(() => { const r = recName("2026-09-09", "14", "06"); attachments.push({ path: r, size: 25_000_000 }); facts.recordings.withoutSummary.push({ note: "Clubs/Society of Quantum Engineers.md", rec: r }); return r; })()}]]

- Take a look through the hackathon prompts.
- Qiskit tutorial next week.

## 2026-10-28

- Chess robot demo went well; the drag bug showed up once.
- Hackathon: 2026-11-15, teams of 3.
`,
);

// ---------------------------------------------------------------- daily notes
const dailyEvents = [
	"Worked on the robot path planner.", "Algorithms homework until late.", "Gym, then ML reading.", "Office hours with [[People/Prof. Okafor]].", "Lab with [[People/Sam Delgado]].",
	"Long call with [[People/Lena Faber]] about the internship.", "Fixed the shift-register wiring.", "Trained an NNUE run overnight.", "Potluck planning with [[People/Priya Natarajan]].",
	"Debugged the knight routing.", "Read two chapters of [[Reading/Designing Data-Intensive Applications]].", "Chess club; [[People/Tomás Herrera]] beat the robot twice.",
	"Cleaned the makerspace.", "Wrote the ADR for the 24V change.", "Quantum society meeting.", "Did nothing useful; tired.",
];
let n = 0;
for (let m = 6; m <= 10; m++) {
	for (let d = 1; d <= ([6, 9].includes(m) ? 30 : 31); d++) {
		if (chance(0.25)) continue;
		const ds = date(2026, m, d);
		const lines = [`# ${ds}`, "", `Mood: ${pick(["good", "ok", "tired", "focused", "scattered"])}. Sleep: ${5 + Math.floor(rand() * 4)}h.`, "", "## Done", ""];
		const k = 2 + Math.floor(rand() * 4);
		for (let i = 0; i < k; i++) lines.push(`- ${pick(dailyEvents)} ${chance(0.5) ? pick(["Took longer than planned.", "Went well.", "Blocked on parts.", "Need to follow up.", "Learned something."]) : ""}`.trim());
		if (chance(0.5)) lines.push("", "## Notes", "", prose(pick(["the robot", "the homework", "the internship search", "sleep", "the club", "the engine"]), 2));
		if (ds === "2026-10-03") lines.push("- Brownout during e2e4, the queen fell over. Logged on [[Projects/Chess Robot]]. Need a bigger supply.");
		if (ds === "2026-10-14") lines.push("- **Decided: the gantry moves to 24V.** Ordered the Mean Well LRS-350-24. [[Projects/Chess Robot]].", "", "![[" + (() => { const r = recName(ds, "13", "28"); attachments.push({ path: r, size: 9_000_000 }); facts.recordings.withoutSummary.push({ note: `Daily/${ds}.md`, rec: r }); return r; })() + "]]", "", "Meeting with [[People/Dr. Beeler]] about the supply change.");
		if (ds === "2026-10-21") lines.push("- Implemented re-homing every 50 moves; drift gone after 300-move test.");
		lines.push("", "## Tomorrow", "", `- [ ] ${pick(["HW", "Read", "Email Lena", "Robot test", "Gym", "Laundry"])}`);
		if (chance(0.3)) lines.push(`- [ ] ${pick(["Call home", "Return library book", "Fix bike", "Meal prep"])}`);
		put(`Daily/${ds}.md`, lines.join("\n"));
		n++;
	}
}
facts.counts.daily = n;

// ---------------------------------------------------------------- spring 2026 (archived courses)
const spring = [
	["CSCI 341", "Computer Organization", ["Two's complement", "Instruction set design", "Pipelining", "Hazards and forwarding", "Caches", "Virtual memory", "I/O and interrupts", "Assembly lab"]],
	["CSCI 358", "Discrete Math", ["Propositional logic", "Proof techniques", "Sets and functions", "Counting", "Relations", "Graphs", "Trees", "Probability"]],
	["MATH 213", "Calculus III", ["Vectors", "Partial derivatives", "Gradients", "Multiple integrals", "Line integrals", "Green's theorem", "Divergence", "Stokes"]],
	["HASS 200", "Technical Writing", ["Audience", "Structure", "Figures", "Citations", "Revision", "Abstracts", "Peer review", "Presentations"]],
];
for (const [code, name, topics] of spring) {
	const folder = `Archive/Spring 2026/${code} - ${name}`;
	const sections = topics.map((t, i) => `## ${date(2026, 1 + Math.floor(i / 4), 8 + (i % 4) * 7)}\n\n**Topic:** ${t}\n\n${prose(t, 2)}\n\n- ${pick(["quiz", "lab", "worksheet", "reading"])} on ${t.toLowerCase()}\n- ${pick(["grade: A-", "grade: B+", "grade: A", "missed it"])}`);
	put(`${folder}/Lectures - ${code}.md`, `# ${name} lectures (spring 2026)\n\n${sections.join("\n\n")}`);
	put(`${folder}/${code}.md`, `---\ntags: [course, spring2026, archived]\n---\n# ${code} — ${name}\n\nFinal grade ${pick(["A", "A-", "B+", "B"])}. Lectures: [[Lectures - ${code}]].\n`);
}

// ---------------------------------------------------------------- research notes
const papers = [
	["Efficiently Updatable Neural Networks for chess", "Nasu", "NNUE: incremental accumulator updates make a small net cheap to evaluate at every node."],
	["Isolation Forest", "Liu, Ting, Zhou", "Anomalies are few and different, so random splits isolate them in short paths."],
	["Attention Is All You Need", "Vaswani et al.", "Self-attention replaces recurrence; positional encodings carry order."],
	["BLAST: Basic Local Alignment Search Tool", "Altschul et al.", "Seed with k-mers, extend, score with E-values."],
	["Magic bitboards", "Kannan", "Perfect hashing of blocker configurations with multiply-shift."],
	["Hall-effect sensing for board games", "synthetic", "Digital hall sensors under squares with a multiplexer; magnet orientation matters."],
	["Lecture capture and learning outcomes", "synthetic", "Recorded lectures help review but reduce attendance by 10%."],
	["Whisper: robust speech recognition", "Radford et al.", "Weak supervision at scale; multilingual transcription."],
	["Retrieval-augmented generation", "Lewis et al.", "Retrieve passages, then generate; reduces hallucination."],
	["Late move reductions", "various", "Search later moves at reduced depth; re-search on fail-high."],
	["Dropout", "Srivastava et al.", "Randomly drop units during training; acts like an ensemble."],
	["A3144 datasheet notes", "Allegro", "Operate point 35 G, release 25 G at 25 °C; open-collector output."],
	["Mean Well LRS-350-24", "Mean Well", "24 V 14.6 A, needs 10% load for regulation; fan-less."],
	["Nussinov algorithm", "Nussinov & Jacobson", "Maximise base pairs with an O(n³) DP."],
	["Edmonds-Karp", "Edmonds & Karp", "BFS augmenting paths bound the number of augmentations by O(VE)."],
	["SVD and PCA", "various", "PCA is the SVD of the centred data matrix."],
	["Faraday's law experiments", "synthetic", "Moving a magnet through a coil; EMF proportional to dΦ/dt."],
	["Technical debt metaphor", "Cunningham", "Shipping fast is borrowing; interest is paid in slower changes."],
	["Flaky tests at Google", "synthetic", "1.5% of tests flaky; quarantine and retry policies."],
	["Spaced repetition", "synthetic", "Review at expanding intervals; Anki implements SM-2."],
];
papers.forEach(([title, author, abstract], i) => {
	put(`Research/${title}.md`, `---\ntags: [paper, ${pick(["ml", "chess", "bio", "hardware", "se"])}]\nauthor: "${author}"\n---\n# ${title}\n\n**Authors:** ${author}\n\n## Abstract (my words)\n\n${abstract}\n\n## Why it matters to me\n\n${prose(title, 2)}\n\n## Questions\n\n- ${pick(["Does this hold at small scale?", "How does it interact with caching?", "What is the failure mode?", "Can I reproduce it in a weekend?"])}\n- Related: [[${pick(["Projects/Chess Robot", "Projects/Kirin Engine", "Projects/NNUE Training", "Projects/Lecture Companion", "Projects/Hall Sensors"])}]]\n`);
});

// ---------------------------------------------------------------- meetings
for (let i = 0; i < 50; i++) {
	const d = date(2026, 6 + Math.floor(i / 10), 1 + ((i * 3) % 28));
	const who = pick(people)[0];
	const what = pick(["robot progress", "hackathon planning", "internship prep", "potluck logistics", "homework review", "engine benchmarks", "wiring review", "demo rehearsal"]);
	put(`Meetings/${d} ${who} - ${what}.md`, `---\ntags: [meeting]\nwith: "[[People/${who}]]"\n---\n# ${d} — ${who}: ${what}\n\n## Agenda\n\n- ${what}\n- ${pick(["next steps", "blockers", "dates", "budget"])}\n\n## Notes\n\n${prose(what, 3)}\n\n## Actions\n\n- [ ] ${pick(["send the summary", "order parts", "book the room", "write the ADR", "update the plan"])} — me\n- [ ] ${pick(["review the PR", "share the slides", "confirm the date"])} — ${who}\n`);
}

// ---------------------------------------------------------------- journal
for (let i = 0; i < 24; i++) {
	const d = date(2026, 6 + Math.floor(i / 5), 2 + (i % 5) * 6);
	const theme = pick(["the semester", "the robot", "friends", "money", "sleep", "the internship", "the club", "home"]);
	put(`Journal/${d}.md`, `# ${d}\n\n${prose(theme, 6)}\n\n${prose(pick(["what went well", "what I avoided", "what I want next month"]), 4)}\n\n#journal`);
}

// ---------------------------------------------------------------- reading
const books = [
	["Designing Data-Intensive Applications", "Kleppmann", ["Replication lag is the enemy.", "Log-structured storage: LSM trees vs B-trees.", "Consensus is expensive; avoid it where you can."]],
	["Chess Programming Wiki", "various", ["Magic bitboards: multiply, shift, index.", "Late move reductions assume good move ordering.", "Zobrist hashing for the transposition table."]],
	["Pattern Recognition and Machine Learning", "Bishop", ["Bayesian view of regularisation.", "EM for mixtures of Gaussians.", "Kernel methods chapter is dense."]],
	["Introduction to Algorithms", "CLRS", ["Master theorem cases.", "Amortised analysis: potential method.", "Max flow min cut."]],
	["The Pragmatic Programmer", "Hunt & Thomas", ["DRY.", "Tracer bullets.", "Don't live with broken windows."]],
	["Biological Sequence Analysis", "Durbin et al.", ["Pair HMMs for alignment.", "Profile HMMs for families.", "Phylogeny by maximum likelihood."]],
	["Deep Learning", "Goodfellow", ["Why depth helps.", "Dropout as ensembling.", "Optimisation is not convex; it still works."]],
	["Electricity and Magnetism", "Purcell", ["Gauss's law from symmetry.", "Magnetism as relativistic electricity.", "Faraday's law sign conventions."]],
	["Make: Electronics", "Platt", ["Always check polarity.", "Decoupling capacitors everywhere.", "Breadboards lie at high frequency."]],
	["Thinking, Fast and Slow", "Kahneman", ["System 1 vs System 2.", "Anchoring.", "Regression to the mean fools everyone."]],
	["Atomic Habits", "Clear", ["Make it obvious.", "Habit stacking.", "Two-minute rule."]],
	["Build a Large Language Model", "Raschka", ["Tokenisation first.", "Attention is a weighted average.", "Fine-tuning needs less data than you think."]],
];
for (const [title, author, notes] of books) {
	put(`Reading/${title}.md`, `---\ntags: [reading, ${pick(["cs", "ml", "bio", "physics", "life"])}]\nauthor: "${author}"\n---\n# ${title}\n\nBy ${author}. ${pick(["Reading for class.", "Recommended by [[People/Dr. Lindqvist]].", "Found in the library.", "Re-reading."])}\n\n## Notes\n\n${notes.map((x) => `- ${x}`).join("\n")}\n\n## Quotes\n\n> ${pick(["The best code is no code.", "Measure before you optimise.", "Nature is not obliged to be simple.", "Small steps, every day."])}\n`);
}

// ---------------------------------------------------------------- recipes, ideas, inbox, templates, archive
for (const [name, time] of [["Pasta", 20], ["Chili", 90], ["Overnight oats", 5], ["Pancakes", 25], ["Fried rice", 15], ["Lentil soup", 45], ["Banana bread", 70], ["Shakshuka", 30]]) {
	put(`Recipes/${name}.md`, `# ${name}\n\n${time} minutes. Serves ${2 + Math.floor(rand() * 4)}.\n\n## Ingredients\n\n- ${pick(["olive oil", "butter"])}\n- ${pick(["onion", "garlic", "both"])}\n- ${pick(["salt", "soy sauce", "paprika"])}\n\n## Steps\n\n1. Prep.\n2. Cook.\n3. Eat.\n\n#recipe\n`);
}
put("Ideas/Magnet shielding.md", `random thoughts on the magnet problem\nso the magnet drags neighbours sometimes. ideas:\n* lower current near occupied squares\n* mu-metal shield under the carriage? expensive\n*  route through square centres only when neighbours empty\nTODO test each and measure field strength at 10mm, 15mm, 20mm\nalso maybe a smaller magnet for pawns?? they are light\nsee [[Chess Robot]]\n`);
const ideaSeeds = ["app that reminds you to drink water", "self-watering plant with a hall sensor float", "lichess bot opening book from my own games", "study group scheduler", "cheap LIDAR from a laser pointer", "bike light that brightens when cars approach", "note gists for every note", "automatic lecture slide puller", "pomodoro on an e-ink display", "robot arm for sorting Lego", "sleep tracker from phone accelerometer", "kitchen inventory with barcodes", "a tiny chess engine in Zig", "campus bus predictor"];
ideaSeeds.forEach((s, i) => put(`Ideas/Idea ${i + 1} - ${s}.md`, `${s}\n\n${pick(["could be a weekend", "needs parts", "probably exists", "ask Marcus"])}. ${chance(0.5) ? "Related: [[Projects/Chess Robot]]" : ""}\n${chance(0.5) ? "* step one\n* step two" : "- step one\n- step two"}\n`));
for (let i = 1; i <= 10; i++) put(`Inbox/Quick note ${i}.md`, `${pick(["call the dentist", "exam room changed to 210", "buy ribbon cable 20-way", "ask Jordan about BLAST params", "Dr. Beeler wants a demo video", "renew parking", "backup the vault", "check Canvas for HW4", "Tomás: knight bug on h8", "mean well supply arrived"])}\n`);
put("Templates/Daily.md", `# {{date}}\n\nMood: \n\n## Done\n\n- \n\n## Tomorrow\n\n- [ ] \n`);
put("Templates/Lecture.md", `## {{date}}\n\n**Topic:** \n\n- \n\n### Summary\n\n- \n`);
put("Templates/Person.md", `---\ntags: [person]\n---\n# \n\n## Interactions\n\n- \n`);
for (let i = 1; i <= 8; i++) put(`Archive/2025/Old note ${i}.md`, `# Old note ${i}\n\nFrom 2025. ${pick(["Keep for reference.", "Can delete.", "Has the old wiring diagram."])}\n`);
put("Welcome.md", `# Welcome\n\nThis vault holds school notes (\`School/\`), daily notes (\`Daily/\`), projects, clubs, reading and people. Lecture notes keep one \`## YYYY-MM-DD\` section per class.\n`);
put("AGENT.md", `# Vault conventions for the agent\n\n## Folders\n- \`Daily/\` — one note per day named \`YYYY-MM-DD\`; new daily content goes under \`## Done\`.\n- \`School/<course>/Lectures - <code>.md\` — one \`## YYYY-MM-DD\` section per class; a \`### Summary\` under it when summarised.\n- \`Templates/\` — never edit or search.\n- \`Archive/\` — old notes; move finished projects to \`Archive/<year>/\`.\n\n## Style\n- \`-\` for bullets, sentence-case headings, wikilinks for every reference to a note or person.\n- Never add YAML frontmatter to a note that has none.\n\n## Never\n- Never delete a recording embed from a lecture section that has no Summary.\n`);

// PDFs and images as attachments.
for (const p of ["Attachments/sars_proteins.pdf", "Attachments/CSCI470-lecture10-slides.pdf", "Attachments/robot-frame.png", "Attachments/wiring-v2.png", "Attachments/syllabus-CSCI406.pdf"]) {
	attachments.push({ path: p, size: 300_000 + Math.floor(rand() * 4_000_000) });
}

// ---------------------------------------------------------------- write
rmSync(out, { recursive: true, force: true });
let chars = 0;
for (const [path, content] of files) {
	mkdirSync(join(out, dirname(path)), { recursive: true });
	writeFileSync(join(out, path), content);
	chars += content.length;
}
facts.counts.notes = files.size;
facts.counts.chars = chars;
facts.attachments = attachments;
writeFileSync(join(here, "large-facts.json"), JSON.stringify(facts, null, 2));
console.log(`wrote ${files.size} notes (${chars} chars) and ${attachments.length} attachment stubs to ${out}`);
