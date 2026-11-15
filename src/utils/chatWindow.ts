/**
 * Render window for the chat timeline (interface, D7).
 * Only the newest `count` messages are rendered; scrolling near the top grows the window and the
 * scroll position is kept by the height that was added above the viewport.
 * Pure functions only: no DOM, no network.
 */

/** Messages rendered on first paint. Covers one phone screen of typical bubbles with headroom. */
export const CHAT_WINDOW_INITIAL = 40
/** Messages added per expansion (one older page). */
export const CHAT_WINDOW_STEP = 30
/** Distance from the top (px) that triggers loading older messages into the window. */
export const CHAT_WINDOW_EDGE_PX = 240

/** The newest `count` items, oldest first. `count` ≤ 0 yields an empty list. */
export function windowTail<T>(list: readonly T[], count: number): T[] {
	if (count <= 0) return []
	return count >= list.length ? list.slice() : list.slice(list.length - count)
}

/** How many older items are outside the window. */
export function hiddenCount(total: number, count: number): number {
	return Math.max(0, total - Math.max(0, count))
}

/** Window size after one expansion, capped at the number of available messages. */
export function nextWindowCount(count: number, total: number): number {
	return Math.min(total, Math.max(0, count) + CHAT_WINDOW_STEP)
}

/**
 * Expand when older messages exist and either the user is near the top, or the rendered
 * content does not yet fill the scroller (so no scroll event would ever fire).
 */
export function shouldExpandWindow(input: {
	scrollTop: number
	scrollHeight: number
	clientHeight: number
	hidden: number
}): boolean {
	if (input.hidden <= 0) return false
	if (input.scrollHeight <= input.clientHeight) return true
	return input.scrollTop < CHAT_WINDOW_EDGE_PX
}

/**
 * scrollTop that keeps the same content in place after height is added above the viewport.
 * Only the growth above the current position matters, so it is the difference in scrollHeight.
 */
export function anchoredScrollTop(prev: { scrollTop: number; scrollHeight: number }, nextScrollHeight: number): number {
	return Math.max(0, prev.scrollTop + (nextScrollHeight - prev.scrollHeight))
}

/**
 * Viewport for the local library's first screen. widthPt and heightPt are the scroller's client
 * size; fontScale is the root font size relative to 16px (the system text scale in the page). The page never
 * infers orientation from the library; it passes it in here.
 */
export function viewportForScroller(input: {
	clientWidth: number
	clientHeight: number
	rootFontSizePx: number
	innerWidth: number
	innerHeight: number
}): { widthPt: number; heightPt: number; orientation: 'portrait' | 'landscape'; fontScale: number; layoutVersion: number } {
	const fontScale = input.rootFontSizePx > 0 ? input.rootFontSizePx / 16 : 1
	return {
		widthPt: Math.max(1, Math.round(input.clientWidth)),
		heightPt: Math.max(1, Math.round(input.clientHeight)),
		orientation: input.innerHeight >= input.innerWidth ? 'portrait' : 'landscape',
		fontScale: Math.round(fontScale * 100) / 100,
		layoutVersion: 1,
	}
}
