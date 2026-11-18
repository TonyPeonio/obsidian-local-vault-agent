/**
 * Messages sent while the model is busy. They used to be dropped without a word; now they wait
 * here, in the order they were sent, and go out one by one when the running turn has ended. Stop
 * (and a turn that fails) hands them back to the message box instead of sending them: nothing the
 * user typed is lost, and nothing is sent that they may no longer want. Pure: no DOM.
 */

export interface QueuedMessage {
	id: number;
	text: string;
	/** Whether notes linked in the text are attached when it is sent (off for prompts that only list notes). */
	attach: boolean;
	/** Vault paths of images attached in the composer. */
	images: string[];
}

export class MessageQueue {
	private items: QueuedMessage[] = [];
	private nextId = 1;

	get size(): number {
		return this.items.length;
	}

	/** The waiting messages, first to be sent first. */
	get list(): readonly QueuedMessage[] {
		return this.items;
	}

	add(text: string, attach = true, images: string[] = []): QueuedMessage {
		const item: QueuedMessage = { id: this.nextId++, text, attach, images };
		this.items.push(item);
		return item;
	}

	/** Takes the next message to send off the queue, or null when none waits. */
	next(): QueuedMessage | null {
		return this.items.shift() ?? null;
	}

	/** Puts a message that could not be sent after all back at the front, so the order holds. */
	putBack(item: QueuedMessage): void {
		this.items.unshift(item);
	}

	/** Takes one message out of the queue (the user took it back). */
	remove(id: number): QueuedMessage | null {
		const at = this.items.findIndex((i) => i.id === id);
		return at < 0 ? null : this.items.splice(at, 1)[0];
	}

	/** Empties the queue and returns what was waiting, in order. */
	clear(): QueuedMessage[] {
		const all = this.items;
		this.items = [];
		return all;
	}
}

/**
 * The text for the message box when queued messages are handed back: the queued ones in the order
 * they were sent, then whatever was being typed, one per paragraph.
 */
export function restoredDraft(returned: readonly QueuedMessage[], current: string): string {
	return [...returned.map((m) => m.text.trim()), current.trim()].filter((s) => s.length > 0).join("\n\n");
}

/** One line of a queued message for the list above the message box. */
export function queuePreview(text: string, max = 120): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}
