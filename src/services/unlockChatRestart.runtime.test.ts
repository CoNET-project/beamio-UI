/**
 * @jest-environment node
 *
 * Runtime check (real chat.ts): while the unlock restart runs, the foreground resume does not touch the native listen.
 * The native bridge is a stub; resumeGossipListenOnForeground and the restart claim are the real code. SYNTHETIC values only.
 * Scope: the foreground resume's guard. The full App lock → unlock → history reload is not run here (see the report).
 */
const mockDeepStub = (): any => new Proxy(function () {}, {
	get: (_t, k) => (k === 'then' || k === Symbol.toPrimitive ? undefined : k === '__esModule' ? true : mockDeepStub()),
	apply: () => mockDeepStub(),
	construct: () => mockDeepStub() as any,
})

const bridge = {
	resumeNativeChatListen: jest.fn(() => false),
	isNativeChatListenOwner: jest.fn(() => false),
}
jest.mock('@/services/chatWorkerBridge', () => {
	const stub = new Proxy({} as Record<string, unknown>, {
		get: (t, k) => {
			if (k === '__esModule') return true
			if (k in t) return t[k as string]
			return mockDeepStub()
		},
	})
	return stub
})
// argon2idAsync must not run in these tests (the PBKDF2 stand-in is removed). The bridge module cannot load in jest (import.meta),
// so it stays mocked, but a call fails closed. A test that needs the v3 KDF injects it with setMnemonicKdfForTest.
jest.mock('@/services/argon2WorkerBridge', () => ({
	argon2idAsync: () => {
		throw new Error('argon2idAsync must not run in this test: inject the v3 KDF with setMnemonicKdfForTest')
	},
}))
jest.mock('@/workers/beamioTag/client', () => mockDeepStub())
jest.mock('@/services/shellContext', () => ({ isShellContext: () => true }))
jest.mock('@/utils/cashTreesNativePwaLog', () => ({ publishNativePwaLog: jest.fn() }))

describe('unlock restart vs foreground resume (runtime, real chat.ts)', () => {
	test('while the unlock restart runs, the foreground resume leaves the native listen alone', async () => {
		jest.resetModules()
		const bridgeMod = require('@/services/chatWorkerBridge')
		bridgeMod.resumeNativeChatListen = bridge.resumeNativeChatListen
		const restart = require('./unlockChatRestart')
		const chat = require('./chat')

		let finish: () => void = () => undefined
		restart.registerUnlockChatRestart(() => new Promise<void>((resolve) => { finish = resolve }))
		expect(restart.requestChatRestartAfterUnlock()).toBe(true)
		expect(restart.isUnlockChatRestartRunning()).toBe(true)

		bridge.resumeNativeChatListen.mockClear()
		await chat.resumeGossipListenOnForeground(jest.fn(), jest.fn(), jest.fn(), jest.fn(), 0, true)
		expect(bridge.resumeNativeChatListen).not.toHaveBeenCalled()

		finish()
		await new Promise((r) => setTimeout(r, 0))
		expect(restart.isUnlockChatRestartRunning()).toBe(false)
	})
})
