/**
 * A browser stand-in for the parts of Obsidian the chat view touches, so the view's real DOM code
 * can run in a plain Chromium page (see run.mjs). It is not Obsidian: markdown is rendered by the
 * small stand-in renderer of the render benchmark, icons are a letter, and notices are only
 * recorded. What it does exercise for real is the browser: layout, scrolling, selections, events.
 */
import { standInRender } from "../bench-render";

/* eslint-disable */
type Info = string | { cls?: string | string[]; text?: string; attr?: Record<string, string | number | boolean | null>; type?: string; value?: string; title?: string } | undefined;

function apply(el: HTMLElement, o: Info): void {
	if (!o) return;
	if (typeof o === "string") {
		el.className = o;
		return;
	}
	if (o.cls) el.className = Array.isArray(o.cls) ? o.cls.join(" ") : o.cls;
	if (o.text !== undefined) el.textContent = o.text;
	if (o.type) (el as HTMLInputElement).type = o.type;
	if (o.value !== undefined) (el as HTMLInputElement).value = o.value;
	if (o.title) el.title = o.title;
	for (const [k, v] of Object.entries(o.attr ?? {})) if (v !== null) el.setAttribute(k, String(v));
}

const make = (tag: string, o: Info): HTMLElement => {
	const el = document.createElement(tag);
	apply(el, o);
	return el;
};

const N = Node.prototype as any;
N.createEl = function (tag: string, o?: Info, cb?: (el: HTMLElement) => void) {
	const el = make(tag, o);
	this.appendChild(el);
	cb?.(el);
	return el;
};
N.createDiv = function (o?: Info, cb?: (el: HTMLElement) => void) {
	return this.createEl("div", o, cb);
};
N.createSpan = function (o?: Info, cb?: (el: HTMLElement) => void) {
	return this.createEl("span", o, cb);
};
N.empty = function () {
	while (this.lastChild) this.removeChild(this.lastChild);
};
Object.defineProperty(N, "win", { get: () => window });
Object.defineProperty(N, "doc", { get: () => document });

const E = Element.prototype as any;
E.setText = function (text: string) {
	this.textContent = text;
};
E.addClass = function (...c: string[]) {
	this.classList.add(...c);
};
E.removeClass = function (...c: string[]) {
	this.classList.remove(...c);
};
E.toggleClass = function (c: string, on: boolean) {
	this.classList.toggle(c, on);
};
E.hasClass = function (c: string) {
	return this.classList.contains(c);
};
const H = HTMLElement.prototype as any;
H.hide = function () {
	this.style.display = "none";
};
H.show = function () {
	this.style.display = "";
};
H.toggle = function (show: boolean) {
	if (show) this.show();
	else this.hide();
};

const W = window as any;
W.createEl = (tag: string, o?: Info) => make(tag, o);
W.createDiv = (o?: Info) => make("div", o);
W.createSpan = (o?: Info) => make("span", o);
W.activeDocument = document;
W.activeWindow = window;

export class WorkspaceLeaf {}

export class ItemView {
	app: any;
	leaf: any;
	containerEl: HTMLElement;
	contentEl: HTMLElement;
	constructor(leaf: any) {
		this.leaf = leaf;
		this.app = leaf.app;
		this.containerEl = leaf.containerEl;
		this.contentEl = (this.containerEl as any).createDiv({ cls: "view-content" });
	}
	register(_cb: () => void): void {}
}

export class Notice {
	static shown: Notice[] = [];
	hidden = false;
	constructor(
		public message: string,
		public timeout?: number,
	) {
		Notice.shown.push(this);
	}
	hide(): void {
		this.hidden = true;
	}
}

/** Every call the view made to the markdown renderer: how often, and how much text. */
export const renderLog = { calls: 0, chars: 0 };

export const MarkdownRenderer = {
	async render(_app: unknown, markdown: string, el: HTMLElement): Promise<void> {
		renderLog.calls++;
		renderLog.chars += markdown.length;
		// Obsidian's renderer is asynchronous too; a render that takes a moment is what makes overlapping renders possible.
		await new Promise((r) => setTimeout(r, 2));
		el.insertAdjacentHTML("beforeend", standInRender(markdown).map((n) => n.html).join(""));
	},
};

export function setIcon(el: HTMLElement, name: string): void {
	(el as any).empty();
	const icon = document.createElement("span");
	icon.className = "svg-icon";
	icon.dataset.icon = name;
	icon.textContent = { "arrow-down": "↓", "send-horizontal": "➤", square: "■", x: "×", "undo-2": "↩", clock: "◷", "alert-triangle": "⚠", plus: "+", copy: "⧉", "refresh-cw": "↻", "clipboard-copy": "⧉", "file-input": "⇥", mic: "●" }[name] ?? "•";
	el.appendChild(icon);
}

// What other modules of the plugin import; none of it runs in the check.
export class Plugin {}
export class Modal {}
export class PluginSettingTab {}
export class Setting {}
export class TFile {}
export class MarkdownView {}
export function normalizePath(p: string): string {
	return p.replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^\/+|\/+$/g, "");
}
export function getAllTags(): string[] {
	return [];
}
export async function requestUrl(): Promise<never> {
	throw new Error("requestUrl is not available in the DOM check");
}
