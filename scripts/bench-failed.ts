/**
 * Which checks of a benchmark run failed, per scenario, read off the log lines as they are printed
 * (`=== [id] …` opens a scenario, `  FAIL  label` is a failed check), so every check site of
 * `e2e-large.ts` is covered without each one reporting itself. Pure: no model, no vault.
 *
 * A run limited with ONLY= prints no heading for a scenario it leaves out, but the checks that
 * follow such a scenario in the script (was the note created, is the link gone) are made all the
 * same, on a vault the scenario never touched, and print their lines. Until `skipped` was told
 * of a scenario left out, those lines were filed under the last scenario that did run:
 * `bench/0.9.0-cs4-1.json` lists eleven failed checks of `code-snippets`, which passed 8 of 8.
 */
export class FailedChecks {
	private by = new Map<string, string[]>();
	/** The scenario whose log lines are being printed; "" before the first one and after one that was left out. */
	current = "";

	/** Every line the benchmark prints goes through here. */
	line(text: string): void {
		const head = /^\n?=== \[([^\]]+)\]/.exec(text);
		if (head) this.current = head[1];
		const failed = /^ {2}FAIL {2}(.*)$/.exec(text);
		// A failed check printed while no scenario is open belongs to one that did not run: it is not a result.
		if (failed && this.current) this.by.set(this.current, [...(this.by.get(this.current) ?? []), failed[1]]);
	}

	/** ONLY left this scenario out: the checks printed from here to the next heading are not of a scenario that ran. */
	skipped(): void {
		this.current = "";
	}

	/** The labels of the failed checks of one scenario. */
	of(id: string): string[] {
		return this.by.get(id) ?? [];
	}

	/** `id: label` for every failed check of the scenarios given (those that ran), in their order. */
	list(ids: string[]): string[] {
		return ids.flatMap((id) => this.of(id).map((label) => `${id}: ${label}`));
	}
}

/**
 * How many checks failed in a run, given the count made as the checks were printed and the rows of
 * the scenarios ONLY left out: the checks after such a scenario were counted too (on its dummy row)
 * and are taken off again, so a limited run that passed everything it ran ends with 0 and exit code 0.
 */
export function failuresOfRun(counted: number, rows: { fail: number; skipped?: boolean }[]): number {
	return counted - rows.filter((r) => r.skipped).reduce((n, r) => n + r.fail, 0);
}
