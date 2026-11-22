/**
 * History re-init after unlock (route 2): the claim protocol, run on the real module.
 *
 * What this proves: for one lock → unlock, the chat start (`initChat`) runs exactly once whether the App's `init()` run
 * follows the unlock or not, with gossip active and with gossip inactive. The App's `init()` is modelled by
 * `runInitModel` (it asks `takeUnlockChatOwnership()` first, as src/App.tsx does); the App's wiring itself is checked
 * by the static test in unlockChatRestart.static.test.ts, not by rendering App (honest scope).
 */
import {
	runUnlockChatStart,
	registerUnlockChatRestart,
	requestChatRestartAfterUnlock,
	resetUnlockChatRestartForTest,
	takeUnlockChatOwnership,
} from './unlockChatRestart'

type Start = { gossip: boolean }

// the App's init() as far as the chat start is concerned: skip its own initChat when the unlock owns it
const runInitModel = (starts: Start[], gossipActive: boolean) => {
	const owned = takeUnlockChatOwnership()
	if (!owned) starts.push({ gossip: gossipActive })
}

describe('unlock chat restart (single entry)', () => {
	beforeEach(() => resetUnlockChatRestartForTest())

	test.each([true, false])('lock → unlock → init: initChat exactly once (gossip active = %s)', async (gossipActive) => {
		const starts: Start[] = []
		registerUnlockChatRestart(async () => {
			starts.push({ gossip: false }) // the explicit start is always gossip=false
		})
		// the unlock callback: claim first, then init()
		expect(requestChatRestartAfterUnlock()).toBe(true)
		runInitModel(starts, gossipActive)
		await new Promise((r) => setTimeout(r, 0))
		expect(starts).toEqual([{ gossip: false }])
	})

	test('init runs first after the unlock: still exactly once', async () => {
		const starts: Start[] = []
		registerUnlockChatRestart(async () => {
			starts.push({ gossip: false })
		})
		requestChatRestartAfterUnlock()
		runInitModel(starts, true)
		runInitModel(starts, true) // a later init (wake-up) is not skipped by mistake
		await new Promise((r) => setTimeout(r, 0))
		expect(starts).toEqual([{ gossip: false }, { gossip: true }])
	})

	test('two unlock callbacks while the start runs: one start', async () => {
		const starts: Start[] = []
		let release: () => void = () => undefined
		registerUnlockChatRestart(() => new Promise<void>((resolve) => {
			starts.push({ gossip: false })
			release = resolve
		}))
		requestChatRestartAfterUnlock()
		requestChatRestartAfterUnlock()
		release()
		await new Promise((r) => setTimeout(r, 0))
		expect(starts).toHaveLength(1)
	})

	test('no registered start: nothing is claimed, init starts the chat itself', () => {
		const starts: Start[] = []
		expect(requestChatRestartAfterUnlock()).toBe(false)
		runInitModel(starts, false)
		expect(starts).toEqual([{ gossip: false }])
	})

	test('a failing start runs once and does not reject the unlock callback', async () => {
		let calls = 0
		registerUnlockChatRestart(async () => {
			calls += 1
			throw new Error('boom')
		})
		expect(requestChatRestartAfterUnlock()).toBe(true)
		await new Promise((r) => setTimeout(r, 0))
		expect(calls).toBe(1)
	})
})

describe('runUnlockChatStart (branch choice, injected deps)', () => {
	const deps = (over: Partial<Parameters<typeof runUnlockChatStart>[0]> & { keep?: boolean } = {}) => {
		const calls: string[] = []
		const d = {
			isShell: true,
			resumeNativeListen: jest.fn(() => over.keep ?? true),
			reloadHistory: jest.fn(() => { calls.push('reload') }),
			setGossip: jest.fn((v: boolean) => { calls.push(`gossip:${v}`) }),
			prepareListenResume: jest.fn(() => { calls.push('prepare') }),
			initChat: jest.fn(async (g: boolean) => { calls.push(`initChat:${g}`) }),
			log: jest.fn(),
			...over,
		}
		return { d, calls }
	}

	test('shell, native listen kept: no initChat, history reloaded once, gossip flag on, no teardown', async () => {
		const { d, calls } = deps({ keep: true })
		await runUnlockChatStart(d)
		expect(d.initChat).not.toHaveBeenCalled()
		expect(d.reloadHistory).toHaveBeenCalledTimes(1)
		expect(d.prepareListenResume).not.toHaveBeenCalled()
		expect(calls).toEqual(['gossip:true', 'reload'])
	})

	test('shell, native listen not owned: initChat exactly once, no teardown, no history reload', async () => {
		const { d } = deps({ keep: false })
		await runUnlockChatStart(d)
		expect(d.initChat).toHaveBeenCalledTimes(1)
		expect(d.initChat).toHaveBeenCalledWith(false)
		expect(d.prepareListenResume).not.toHaveBeenCalled()
		expect(d.reloadHistory).not.toHaveBeenCalled()
	})

	test('browser: listen restarted as the foreground resume does, then initChat once with gossip off', async () => {
		const { d, calls } = deps({ isShell: false })
		await runUnlockChatStart(d)
		expect(d.resumeNativeListen).not.toHaveBeenCalled()
		expect(calls).toEqual(['prepare', 'gossip:false', 'initChat:false'])
	})

	test('claim + shell, native not kept: the unlock starts the chat once; the later init run skips it', async () => {
		const { d } = deps({ keep: false })
		registerUnlockChatRestart(() => runUnlockChatStart(d))
		expect(requestChatRestartAfterUnlock()).toBe(true)
		// the App's init run after the unlock asks for ownership first; it owns the start, so it skips initChat
		expect(takeUnlockChatOwnership()).toBe(true)
		await new Promise((r) => setTimeout(r, 0))
		expect(d.initChat).toHaveBeenCalledTimes(1)
	})
})
