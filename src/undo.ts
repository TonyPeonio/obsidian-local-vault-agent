import type { ApprovalRequest, ChangeRecord, VaultAccess } from "./types";

/**
 * Every approved write is recorded here with the content it replaced, so the user can take a
 * change back after the fact. Pure: Obsidian-free, in memory, tested against the fake vault.
 */
export class UndoStack {
	private changes: ChangeRecord[] = [];
	private nextId = 1;
	private listeners = new Set<() => void>();

	push(change: Omit<ChangeRecord, "id">): ChangeRecord {
		const record: ChangeRecord = { ...change, id: this.nextId++ };
		this.changes.push(record);
		this.emit();
		return record;
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

	latest(): ChangeRecord | undefined {
		return this.changes[this.changes.length - 1];
	}

	/** Changes made in one agent turn, most recent first (the order to revert them in). */
	forTurn(turn: number): ChangeRecord[] {
		return this.changes.filter((c) => c.turn === turn).reverse();
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

export interface RevertPlan extends ApprovalRequest {
	apply(): Promise<void>;
}

export function describeChange(change: ChangeRecord): string {
	switch (change.tool) {
		case "create_note":
			return `created ${change.path}`;
		case "delete_file":
			return `deleted ${change.path}`;
		case "append_to_note":
			return `appended to ${change.path}`;
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
			if (!vault.exists(path)) throw new Error(`${path} no longer exists; nothing to undo.`);
			const current = await vault.read(path);
			return {
				tool: "undo",
				path,
				before: current,
				after: "",
				summary: `Undo: delete ${path} (the agent created it)`,
				apply: () => vault.trash(path),
			};
		}
		case "delete_file": {
			if (vault.resolveFile(path)) throw new Error(`${path} already exists; nothing to undo.`);
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
			if (!data) throw new Error(`${path} was too large to keep a copy of; restore it from the trash by hand.`);
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
			if (current === change.before) throw new Error(`${path} is already as it was before this change.`);
			return {
				tool: "undo",
				path,
				before: current,
				after: change.before,
				summary: `Undo: ${describeChange(change)}`,
				apply: () => vault.modify(path, change.before),
			};
		}
	}
}
