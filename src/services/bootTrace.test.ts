/**
 * QA boot markers (request, 2026-11-16): the line format, the QA-only switch, and no secret material in a line.
 * The screen order and the sync order are checked in App.accountReset.test.tsx (the real gate).
 */
import { markBootScreen, markBootSync } from './bootTrace'

const mockPublish = jest.fn()
jest.mock('@/utils/cashTreesNativePwaLog', () => ({ publishNativePwaLog: (...a: unknown[]) => mockPublish(...a) }))

describe('[BeamioBoot] markers', () => {
	afterEach(() => {
		delete process.env.REACT_APP_BEAMIO_BOOT_TRACE
	})

	it('a build without REACT_APP_BEAMIO_BOOT_TRACE=true prints nothing (Release)', () => {
		markBootScreen('home')
		markBootSync('send', 1)
		expect(mockPublish).not.toHaveBeenCalled()
	})

	it('a QA build prints one screen line and one sync line, each in the agreed format', () => {
		process.env.REACT_APP_BEAMIO_BOOT_TRACE = 'true'
		markBootScreen('splash')
		markBootSync('retry', 3)
		const lines = mockPublish.mock.calls.map((c) => String(c[1]))
		expect(lines[0]).toMatch(/^\[BeamioBoot\] screen=splash launch=\d+ t=\d+$/)
		expect(lines[1]).toMatch(/^\[BeamioBoot\] sync=retry seq=3 launch=\d+ t=\d+$/)
		expect(mockPublish.mock.calls.every((c) => c[0] === 'info')).toBe(true)
	})

	it('the launch number is the same within one page start', () => {
		process.env.REACT_APP_BEAMIO_BOOT_TRACE = 'true'
		markBootScreen('home')
		markBootScreen('home')
		const n = mockPublish.mock.calls.map((c) => /launch=(\d+)/.exec(String(c[1]))?.[1])
		expect(n[0]).toBeDefined()
		expect(n[1]).toBe(n[0])
	})
})
