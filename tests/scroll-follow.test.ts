import { describe, expect, it } from "vitest";
import { BOTTOM_SLACK, ScrollFollow, type ScrollMetrics } from "../src/scroll-follow";

/** A message list 400 px tall; `scrollTop` is where the reader is. */
class List {
	clientHeight = 400;
	scrollHeight = 400;
	scrollTop = 0;
	constructor(private follow: ScrollFollow) {}
	metrics(): ScrollMetrics {
		return { scrollTop: this.scrollTop, clientHeight: this.clientHeight, scrollHeight: this.scrollHeight };
	}
	/** Text arrives; the view scrolls to the end when told to, as AgentView.scrollToBottom does. */
	grow(px: number): void {
		this.scrollHeight += px;
		if (this.follow.contentAdded()) this.scrollTo(this.scrollHeight);
	}
	/** The list gets shorter (a card is collapsed, a block is drawn smaller): the browser keeps the position inside it. */
	shrink(px: number): void {
		this.scrollHeight -= px;
		const max = this.scrollHeight - this.clientHeight;
		if (this.scrollTop > max) this.scrollTo(max);
	}
	scrollTo(top: number): void {
		const next = Math.max(0, Math.min(top, this.scrollHeight - this.clientHeight));
		if (next === this.scrollTop) return;
		this.scrollTop = next;
		this.follow.onScroll(this.metrics());
	}
	scrollBy(px: number): void {
		this.scrollTo(this.scrollTop + px);
	}
	get distance(): number {
		return this.scrollHeight - this.scrollTop - this.clientHeight;
	}
}

function chat(): { follow: ScrollFollow; list: List } {
	const follow = new ScrollFollow();
	const list = new List(follow);
	return { follow, list };
}

describe("ScrollFollow", () => {
	it("follows new text while the reader is at the bottom", () => {
		const { follow, list } = chat();
		for (let i = 0; i < 20; i++) list.grow(60);
		expect(list.distance).toBe(0);
		expect(follow.showJump).toBe(false);
		expect(follow.hasUnseen).toBe(false);
	});

	it("stops following when the reader scrolls up, and offers to jump to the latest", () => {
		const { follow, list } = chat();
		for (let i = 0; i < 20; i++) list.grow(60);
		list.scrollBy(-300);
		const at = list.scrollTop;
		expect(follow.showJump).toBe(true);
		expect(follow.hasUnseen).toBe(false);
		for (let i = 0; i < 10; i++) list.grow(60);
		expect(list.scrollTop).toBe(at);
		expect(follow.hasUnseen).toBe(true);
	});

	it("lets a slow scroll get away from text that arrives many times a second", () => {
		const { follow, list } = chat();
		for (let i = 0; i < 20; i++) list.grow(60);
		// A trackpad moves a few pixels between two pieces of text: still within the slack of the bottom.
		list.scrollBy(-4);
		expect(follow.showJump).toBe(true);
		list.grow(20);
		list.scrollBy(-4);
		list.grow(20);
		expect(list.distance).toBe(48);
		expect(follow.showJump).toBe(true);
	});

	it("resumes when the reader scrolls back to the bottom", () => {
		const { follow, list } = chat();
		for (let i = 0; i < 20; i++) list.grow(60);
		list.scrollBy(-300);
		list.grow(100);
		// Down, but not to the end yet.
		list.scrollBy(200);
		expect(follow.showJump).toBe(true);
		list.scrollBy(1000);
		expect(follow.showJump).toBe(false);
		expect(follow.hasUnseen).toBe(false);
		list.grow(60);
		expect(list.distance).toBe(0);
	});

	it("resumes a little short of the bottom when the reader is moving down", () => {
		const { follow, list } = chat();
		for (let i = 0; i < 20; i++) list.grow(60);
		list.scrollBy(-300);
		list.scrollBy(300 - (BOTTOM_SLACK - 4));
		expect(follow.showJump).toBe(false);
	});

	it("jumps to the latest when asked, and follows again", () => {
		const { follow, list } = chat();
		for (let i = 0; i < 20; i++) list.grow(60);
		list.scrollBy(-500);
		list.grow(60);
		follow.jump();
		list.scrollTo(list.scrollHeight);
		expect(follow.showJump).toBe(false);
		expect(follow.hasUnseen).toBe(false);
		list.grow(60);
		expect(list.distance).toBe(0);
	});

	it("keeps following when the list gets shorter under a reader at the bottom", () => {
		const { follow, list } = chat();
		for (let i = 0; i < 20; i++) list.grow(60);
		// The position moves up with the end of the list; the reader did not scroll.
		list.shrink(150);
		expect(follow.showJump).toBe(false);
		list.grow(60);
		expect(list.distance).toBe(0);
	});

	it("does not take text that grew without a scroll for the reader leaving the bottom", () => {
		const { follow, list } = chat();
		for (let i = 0; i < 20; i++) list.grow(60);
		// A block is drawn taller after the view last scrolled (an image loads): no scroll event at all.
		list.scrollHeight += 200;
		expect(follow.showJump).toBe(false);
		list.grow(10);
		expect(list.distance).toBe(0);
	});

	it("takes a wheel, key or finger going up at its word, before the list has moved", () => {
		const { follow, list } = chat();
		for (let i = 0; i < 20; i++) list.grow(60);
		// The request to scroll comes first; a piece of text arrives before the browser has scrolled.
		follow.scrollingUp(list.metrics());
		const at = list.scrollTop;
		list.grow(60);
		expect(list.scrollTop).toBe(at);
		expect(follow.showJump).toBe(true);
		// Then the list moves, and stays where the reader put it.
		list.scrollBy(-100);
		list.grow(60);
		expect(list.scrollTop).toBe(at - 100);
	});

	it("ignores a wheel going up when there is nothing to scroll", () => {
		const { follow, list } = chat();
		list.grow(-100);
		follow.scrollingUp(list.metrics());
		expect(follow.showJump).toBe(false);
	});

	it("starts at the bottom of an empty or short chat", () => {
		const { follow, list } = chat();
		expect(follow.showJump).toBe(false);
		list.grow(100);
		expect(follow.showJump).toBe(false);
	});
});
