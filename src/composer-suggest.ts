/**
 * A small completion popup for the chat composer: `@` picks a note, `/` picks a command.
 * Registers its keydown listener before the view's own so Enter picks instead of sending.
 */

export interface SuggestItem {
	key: string;
	title: string;
	detail?: string;
}

export interface SuggestTrigger {
	char: "@" | "/";
	items(query: string): SuggestItem[];
	/** `replace` swaps the trigger text (e.g. "@chess") for `text` and moves the caret after it. */
	pick(item: SuggestItem, replace: (text: string) => void): void;
}

export class ComposerSuggest {
	private el: HTMLElement;
	private items: SuggestItem[] = [];
	private selected = 0;
	private active: { trigger: SuggestTrigger; start: number; end: number } | null = null;
	private blurTimer: number | null = null;

	constructor(
		private input: HTMLTextAreaElement,
		container: HTMLElement,
		private triggers: SuggestTrigger[],
	) {
		this.el = container.createDiv({ cls: "lva-suggest" });
		this.el.hide();
		input.addEventListener("input", () => this.update());
		input.addEventListener("click", () => this.update());
		input.addEventListener("keydown", (e) => this.onKey(e));
		input.addEventListener("blur", () => {
			this.blurTimer = window.setTimeout(() => this.close(), 150);
		});
		input.addEventListener("focus", () => {
			if (this.blurTimer !== null) window.clearTimeout(this.blurTimer);
		});
	}

	get isOpen(): boolean {
		return this.active !== null;
	}

	close(): void {
		this.active = null;
		this.items = [];
		this.el.empty();
		this.el.hide();
	}

	private update(): void {
		const caret = this.input.selectionStart ?? this.input.value.length;
		const before = this.input.value.slice(0, caret);
		for (const trigger of this.triggers) {
			const m =
				trigger.char === "/"
					? /^\/(\S*)$/.exec(before) && !this.input.value.slice(caret).trim() ? /^\/(\S*)$/.exec(before) : null
					: /(?:^|\s)@([^\s@]*)$/.exec(before);
			if (!m) continue;
			const query = m[1];
			const start = caret - query.length - 1;
			this.items = trigger.items(query).slice(0, 8);
			if (this.items.length === 0) break;
			this.active = { trigger, start, end: caret };
			this.selected = 0;
			this.render();
			return;
		}
		this.close();
	}

	private render(): void {
		this.el.empty();
		this.items.forEach((item, i) => {
			const row = this.el.createDiv({ cls: "lva-suggest-item" + (i === this.selected ? " is-selected" : "") });
			row.createSpan({ cls: "lva-suggest-title", text: item.title });
			if (item.detail) row.createSpan({ cls: "lva-suggest-detail", text: item.detail });
			row.addEventListener("mousedown", (e) => {
				e.preventDefault();
				this.pick(i);
			});
		});
		this.el.show();
	}

	private onKey(e: KeyboardEvent): void {
		if (!this.active) return;
		switch (e.key) {
			case "ArrowDown":
				this.selected = (this.selected + 1) % this.items.length;
				break;
			case "ArrowUp":
				this.selected = (this.selected - 1 + this.items.length) % this.items.length;
				break;
			case "Enter":
			case "Tab":
				this.pick(this.selected);
				break;
			case "Escape":
				this.close();
				break;
			default:
				return;
		}
		e.preventDefault();
		e.stopImmediatePropagation();
		if (this.active) this.render();
	}

	private pick(index: number): void {
		const active = this.active;
		const item = this.items[index];
		if (!active || !item) return;
		const { start, end, trigger } = active;
		this.close();
		trigger.pick(item, (text) => {
			const v = this.input.value;
			this.input.value = v.slice(0, start) + text + v.slice(end);
			const caret = start + text.length;
			this.input.setSelectionRange(caret, caret);
			this.input.focus();
			this.input.dispatchEvent(new Event("input"));
		});
	}
}
