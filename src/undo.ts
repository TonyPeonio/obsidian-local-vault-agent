import { applyPatch, structuredPatch } from "diff";
import type { ApprovalRequest, ChangeRecord, VaultAccess } from "./types";

/** Records kept in the change history (oldest are dropped first). */
export const MAX_HISTORY = 300;

/**
 * Every approved write is recorded here with the content it replaced, so the user can take a
 * change back after the fact. The plugin saves it to `history.json` in its folder, so the change
 * history and its Undo buttons survive a restart. Undone changes stay in the list, marked.
 * Pure: Obsidian-free, tested against the fake vault.
 */
export class UndoStack {
	private changes: ChangeRecord[] = [];
	private nextId = 1;
	private listeners = new Set<() => void>();

	constructor(private max = MAX_HISTORY) {}

	push(change: Omit<ChangeRecord, "id">): ChangeRecord {
		const record: ChangeRecord = { ...change, id: this.nextId++ };
		this.changes.push(record);
		if (this.changes.length > this.max) this.changes.splice(0, this.changes.length - this.max);
		this.emit();
		return record;
	}

	/** Replaces the history with saved records (from `toJSON`). */
	load(records: unknown): void {
		if (!Array.isArray(records)) return;
		this.changes = records
			.filter((r): r is ChangeRecord => {
				const c = r as Partial<ChangeRecord> | null;
				return !!c && typeof c.id === "number" && typeof c.path === "string" && typeof c.before === "string" && typeof c.after === "string";
			})
			.slice(-this.max);
		this.nextId = this.changes.reduce((m, c) => Math.max(m, c.id), 0) + 1;
		this.emit();
	}

	/** The history for saving: attachment bytes are left out (too large for JSON). */
	toJSON(): ChangeRecord[] {
		return this.changes.map((c) => (c.binary ? { ...c, binary: undefined } : c));
	}

	markUndone(id: number, time = Date.now()): void {
		const c = this.byId(id);
		if (!c || c.undone) return;
		c.undone = time;
		this.emit();
	}

	get size(): number {
		return this.changes.length;
	}

	/** Oldest first. */
	list(): readonly ChangeRecord[] {
		return this.changes;
	}

	byId(id: number): ChangeRecord | undefined {
		return this.changes.find((c) => c.id === id);
	}

	/** The most recent change that has not been undone. */
	latest(): ChangeRecord | undefined {
		for (let i = this.changes.length - 1; i >= 0; i--) if (!this.changes[i].undone) return this.changes[i];
		return undefined;
	}

	/** Changes made in one agent turn (of one chat, when given) and not undone, most recent first (the order to revert them in). */
	forTurn(turn: number, chat?: string): ChangeRecord[] {
		return this.changes.filter((c) => c.turn === turn && !c.undone && (chat === undefined || c.chat === chat)).reverse();
	}

	remove(id: number): void {
		const before = this.changes.length;
		this.changes = this.changes.filter((c) => c.id !== id);
		if (this.changes.length !== before) this.emit();
	}

	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private emit(): void {
		for (const l of this.listeners) l();
	}
}

/** Why a change cannot be undone: nothing left to undo, or the note changed since in a way that overlaps it. */
export class RevertError extends Error {
	constructor(
		message: string,
		readonly kind: "nothing" | "conflict",
	) {
		super(message);
		this.name = "RevertError";
	}
}

/**
 * Takes a change (`before` -> `after`) back out of `current`, the note as it is now. When the note
 * is still exactly `after` that is `before`; when it was edited since, the change is reversed as a
 * patch with exact context, so later edits elsewhere in the note are kept. Null when the later
 * edits overlap the change (a conflict).
 */
export function reverseOnto(current: string, before: string, after: string): string | null {
	return carryOnto(current, after, before);
}

/**
 * The change `from` → `to` carried over onto `current`: `to` when `current` is still `from`, else
 * the change applied as a patch with exact context (null when `current` changed where the change is).
 */
export function carryOnto(current: string, from: string, to: string): string | null {
	if (current === from) return to;
	const patch = structuredPatch("note", "note", from, to, "", "", { context: 2 });
	const out = applyPatch(current, patch, { fuzzFactor: 0 });
	return out === false ? null : out;
}

export interface RevertPlan extends ApprovalRequest {
	apply(): Promise<void>;
}

export function describeChange(change: ChangeRecord): string {
	switch (change.tool) {
		case "create_note":
			return `created ${change.path}`;
		case "delete_file":
			return `deleted ${change.path}`;
		case "move_note":
			return `moved ${change.before} to ${change.after}`;
		case "append_to_note":
			return `appended to ${change.path}`;
		case "add_block_ids":
			return `added block ids to ${change.path}`;
		case "undo":
			return `undid a change to ${change.path}`;
		case "replace_note":
			return `rewrote ${change.path}`;
		default:
			return `edited ${change.path}`;
	}
}

/**
 * Works out what undoing `change` means for the vault as it is *now*, as an approval request
 * (current content → restored content) plus the action that performs it. Throws when there is
 * nothing to undo any more.
 */
export async function planRevert(change: ChangeRecord, vault: VaultAccess): Promise<RevertPlan> {
	const { path } = change;
	const isNote = /\.md$/i.test(path);
	switch (change.tool) {
		case "create_note": {
			if (!vault.exists(path)) throw new RevertError(`${path} no longer exists; nothing to undo.`, "nothing");
			const current = await vault.read(path);
			// Deleting a note that was written to since would lose that writing.
			if (change.after && current !== change.after) throw new RevertError(`${path} was edited after the agent created it; deleting it would lose those edits. Delete it by hand if you want it gone.`, "conflict");
			return {
				tool: "undo",
				path,
				before: current,
				after: "",
				summary: `Undo: delete ${path} (the agent created it)`,
				apply: () => vault.trash(path),
			};
		}
		case "move_note": {
			const from = change.after;
			const to = change.before;
			if (!vault.resolveFile(from)) throw new RevertError(`${from} is no longer there; nothing to undo.`, "nothing");
			if (vault.resolveFile(to)) throw new RevertError(`${to} already exists; cannot move back.`, "conflict");
			return {
				tool: "undo",
				path: from,
				before: from,
				after: to,
				summary: `Undo: move ${from} back to ${to}`,
				apply: () => vault.rename(from, to),
			};
		}
		case "delete_file": {
			if (vault.resolveFile(path)) throw new RevertError(`${path} already exists; nothing to undo.`, "nothing");
			if (isNote) {
				return {
					tool: "undo",
					path,
					before: "",
					after: change.before,
					summary: `Undo: restore ${path}`,
					apply: () => vault.create(path, change.before),
				};
			}
			const data = change.binary;
			if (!data) throw new RevertError(`${path} was too large to keep a copy of; restore it from the trash by hand.`, "nothing");
			return {
				tool: "undo",
				path,
				before: "",
				after: `(restore attachment, ${data.byteLength} bytes)`,
				summary: `Undo: restore ${path}`,
				apply: () => vault.createBinary(path, data),
			};
		}
		default: {
			if (!vault.exists(path)) {
				return {
					tool: "undo",
					path,
					before: "",
					after: change.before,
					summary: `Undo: restore ${path}`,
					apply: () => vault.create(path, change.before),
				};
			}
			const current = await vault.read(path);
			if (current === change.before) throw new RevertError(`${path} is already as it was before this change.`, "nothing");
			const restored = reverseOnto(current, change.before, change.after);
			if (restored === null) throw new RevertError(`${path} changed since in a way that overlaps this change, so it cannot be undone automatically. Compare the note with the change in the history and fix it by hand.`, "conflict");
			return {
				tool: "undo",
				path,
				before: current,
				after: restored,
				summary: current === change.after ? `Undo: ${describeChange(change)}` : `Undo: ${describeChange(change)} (later edits kept)`,
				apply: async () => {
					// The note must not have changed while the diff was open.
					if ((await vault.read(path)) !== current) throw new RevertError(`${path} changed while the undo was waiting for approval; try again.`, "conflict");
					await vault.modify(path, restored);
				},
			};
		}
	}
}

/**
 * Of the changes one agent run reported, those still applied, most recent first (the order to revert
 * them in). The records are the ones `UndoStack.push` returned, so `undone` is current; an undo's own
 * record is never among them, unlike `forTurn`, which returns it as the turn's newest change.
 */
export function stillApplied(made: readonly ChangeRecord[]): ChangeRecord[] {
	return made.filter((c) => !c.undone).reverse();
}
