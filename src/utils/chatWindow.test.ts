import {
	CHAT_WINDOW_EDGE_PX,
	CHAT_WINDOW_INITIAL,
	CHAT_WINDOW_STEP,
	anchoredScrollTop,
	hiddenCount,
	nextWindowCount,
	shouldExpandWindow,
	viewportForScroller,
	windowTail,
} from './chatWindow'

describe('chat render window', () => {
	const list = Array.from({ length: 100 }, (_, i) => i)

	it('renders only the newest items, oldest first', () => {
		expect(windowTail(list, 3)).toEqual([97, 98, 99])
		expect(windowTail(list, 0)).toEqual([])
		expect(windowTail(list, 500)).toEqual(list)
		expect(windowTail([], 40)).toEqual([])
	})

	it('reports hidden older items and never goes negative', () => {
		expect(hiddenCount(100, 40)).toBe(60)
		expect(hiddenCount(10, 40)).toBe(0)
		expect(hiddenCount(10, -5)).toBe(10)
	})

	it('grows by one step and stops at the available total', () => {
		expect(nextWindowCount(CHAT_WINDOW_INITIAL, 1000)).toBe(CHAT_WINDOW_INITIAL + CHAT_WINDOW_STEP)
		expect(nextWindowCount(90, 100)).toBe(100)
		expect(nextWindowCount(0, 0)).toBe(0)
	})

	it('expands only when older items exist and the user is near the top or content does not fill', () => {
		const base = { scrollHeight: 2000, clientHeight: 700, hidden: 5 }
		expect(shouldExpandWindow({ ...base, scrollTop: 10 })).toBe(true)
		expect(shouldExpandWindow({ ...base, scrollTop: CHAT_WINDOW_EDGE_PX + 1 })).toBe(false)
		expect(shouldExpandWindow({ scrollTop: 0, scrollHeight: 300, clientHeight: 700, hidden: 5 })).toBe(true)
		expect(shouldExpandWindow({ ...base, scrollTop: 10, hidden: 0 })).toBe(false)
	})

	it('keeps the same content in place after height is added above', () => {
		// 200px of older rows were prepended: the viewport must move down by 200px to stay on the same message
		expect(anchoredScrollTop({ scrollTop: 50, scrollHeight: 2000 }, 2200)).toBe(250)
		// nothing added: unchanged
		expect(anchoredScrollTop({ scrollTop: 50, scrollHeight: 2000 }, 2000)).toBe(50)
		// never negative
		expect(anchoredScrollTop({ scrollTop: 0, scrollHeight: 2000 }, 1500)).toBe(0)
	})
})

describe('local library viewport', () => {
	it('uses the scroller size, the root font scale and the window orientation', () => {
		expect(viewportForScroller({ clientWidth: 390, clientHeight: 760, rootFontSizePx: 16, innerWidth: 390, innerHeight: 844 })).toEqual({
			widthPt: 390,
			heightPt: 760,
			orientation: 'portrait',
			fontScale: 1,
			layoutVersion: 1,
		})
		const landscape = viewportForScroller({ clientWidth: 700, clientHeight: 300, rootFontSizePx: 24, innerWidth: 844, innerHeight: 390 })
		expect(landscape.orientation).toBe('landscape')
		expect(landscape.fontScale).toBe(1.5)
	})

	it('never returns a zero size', () => {
		expect(viewportForScroller({ clientWidth: 0, clientHeight: 0, rootFontSizePx: 0, innerWidth: 0, innerHeight: 0 }).widthPt).toBe(1)
	})
})
