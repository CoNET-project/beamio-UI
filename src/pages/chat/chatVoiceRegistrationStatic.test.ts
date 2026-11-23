/**
 * @jest-environment node
 *
 * Static check of the connected-call registration wiring (review (C), v70 §77): the mount effect resets the unmount marker,
 * so React.StrictMode's dev-only simulated unmount/remount cannot leave a stale registration.
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const src = readFileSync(join(__dirname, 'chat.tsx'), 'utf8')

describe('connected-call registration wiring (static)', () => {
	test('the mount effect resets pageUnmountedRef to false before the unmount marker is set', () => {
		const at = src.indexOf('const pageUnmountedRef = useRef(false)')
		expect(at).toBeGreaterThan(-1)
		const block = src.slice(at, at + 700)
		const reset = block.indexOf('pageUnmountedRef.current = false')
		const mark = block.indexOf('pageUnmountedRef.current = true')
		expect(reset).toBeGreaterThan(-1)
		expect(mark).toBeGreaterThan(reset)
	})
	test('the registration cleanup returns early on unmount and clears on the connected-state change', () => {
		const at = src.indexOf('if (pageUnmountedRef.current) return')
		expect(at).toBeGreaterThan(-1)
		expect(src.slice(at, at + 200)).toContain('clearConnectedCallIfMatches(callId, sessionId)')
	})
})
