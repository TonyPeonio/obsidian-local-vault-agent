/**
 * Whether the chat follows new text to the bottom. It does while the reader is at the bottom; once
 * they scroll up to read something, new text no longer pulls the view away, and a "jump to latest"
 * control is shown instead. Pure: the view feeds it the scroll position and asks what to do.
 */

export interface ScrollMetrics {
	scrollTop: number;
	clientHeight: number;
	scrollHeight: number;
}

/** How close to the end still counts as "at the bottom" (pixels): a line of text, roughly. */
export const BOTTOM_SLACK = 24;

export class ScrollFollow {
	private following = true;
	private unseen = false;
	private lastTop = 0;

	/**
	 * The list was scrolled, by the reader or by the view. Moving up, by however little, stops the
	 * following (otherwise text arriving many times a second would pull a slow scroll back before it
	 * got anywhere); coming back to the bottom resumes it. A position that is merely short of the
	 * bottom changes nothing: text added since the view last scrolled leaves it there without the
	 * reader having done anything.
	 */
	onScroll(m: ScrollMetrics): void {
		const distance = m.scrollHeight - m.scrollTop - m.clientHeight;
		const movedUp = m.scrollTop < this.lastTop - 1;
		// Exactly at the end, also after "moving up": the list got shorter and the browser kept it at its end.
		if (distance <= 1 || (!movedUp && distance <= BOTTOM_SLACK)) {
			this.following = true;
			this.unseen = false;
		} else if (movedUp) {
			this.following = false;
		}
		this.lastTop = m.scrollTop;
	}

	/** Something was added to the conversation. Returns whether the view should scroll to the bottom. */
	contentAdded(): boolean {
		if (this.following) return true;
		this.unseen = true;
		return false;
	}

	/** The reader asked for the latest (or sent a message): follow again. */
	jump(): void {
		this.following = true;
		this.unseen = false;
	}

	/** Whether the "jump to latest" control is shown. */
	get showJump(): boolean {
		return !this.following;
	}

	/** Whether something arrived that the reader has not scrolled to. */
	get hasUnseen(): boolean {
		return this.unseen;
	}
}
