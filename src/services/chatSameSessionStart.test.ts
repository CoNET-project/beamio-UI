/**
 * @jest-environment node
 */
/**
 * chat connects in the SAME session after the first /home (no cold start). The restore session starts the chat before the native wallet holds the phrase
 * (native answers no_key); the first /home hands the phrase over and the native wallet becomes ready: that event, and the first identity's `registered`, must start the
 * chat again: a start that ended with no_key keeps its arguments. SYNTHETIC; the native answers are scripted.
 */
jest.mock('@/workers/appDaemon/client', () => ({}))
jest.mock('@/workers/beamioTag/client', () => ({}))
jest.mock('@/services/chatMediaWorkerBridge', () => ({}))
jest.mock('@/services/argon2WorkerBridge', () => ({}))

type Chat = typeof import('./chat')

function load(startResults: string[]) {
	const start = jest.fn(async () => startResults[Math.min(start.mock.calls.length - 1, startResults.length - 1)])
	let chat: Chat | undefined
	jest.isolateModules(() => {
		jest.doMock('@/services/chatWorkerBridge', () => ({
			boundAccountOfActiveClient: () => null,
			applyNativeRouteEligibility: () => 'unchanged',
			clearNativeRouteState: () => undefined,
			pauseNativeChatListen: () => true,
		}))
		jest.doMock('@/services/shellChatCapability', () => ({
			ensureShellChatState: async () => 'native_chat',
			isShellContext: () => true,
			onShellChatCapabilityResolved: () => () => undefined,
			shellChatBlockedNow: () => false,
		}))
		jest.doMock('./shellChatStart', () => ({ ...jest.requireActual('./shellChatStart'), startShellChatFromNativeIdentity: start }))
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		chat = require('./chat')
	})
	return { chat: chat!, start }
}
const noop = () => undefined
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('the shell chat start in the same session as the restore', () => {
	it('a start that ends with no_key (the restore session, native wallet not ready) is started again by the wallet-ready event: no cold start needed', async () => {
		const { chat, start } = load(['no_key', 'started'])
		await chat.initChat(noop, noop, noop, false, noop) // restore session: native answers no_key
		expect(start).toHaveBeenCalledTimes(1)
		// the first /home: the phrase is handed over, the native wallet is ready (NATIVE_WALLET_READY_EVENT -> restartShellChatAfterWalletReady)
		expect(chat.restartShellChatAfterWalletReady()).toBe('started')
		await flush()
		expect(start).toHaveBeenCalledTimes(2)
	})

	it('the chat is connected within the first /home: the second start reports started, within a bounded number of starts (N=2) and no timer is needed', async () => {
		jest.useFakeTimers()
		try {
			const { chat, start } = load(['no_key', 'started'])
			await chat.initChat(noop, noop, noop, false, noop)
			const t0 = Date.now()
			expect(chat.restartShellChatAfterWalletReady()).toBe('started')
			await Promise.resolve()
			await Promise.resolve()
			// the second start ran at once (no 30 s ladder, no cold start), and it was the last one needed
			expect(start).toHaveBeenCalledTimes(2)
			expect(Date.now() - t0).toBeLessThan(5_000)
			// a live chat is not started a third time by another wallet-ready event
			jest.advanceTimersByTime(5_000)
			expect(chat.restartShellChatAfterWalletReady()).toBe('skipped')
			expect(start).toHaveBeenCalledTimes(2)
		} finally {
			jest.useRealTimers()
		}
	})

	it('the first identity `registered` starts the chat again too (startNow keeps working after a no_key start)', async () => {
		const { chat, start } = load(['no_key', 'started'])
		await chat.initChat(noop, noop, noop, false, noop)
		chat.applyFirstIdentityStatus({ state: 'registered' } as never)
		await flush()
		expect(start).toHaveBeenCalledTimes(2)
	})

	it('without any earlier start there is nothing to restart (no chat is started by an event alone)', () => {
		const { chat, start } = load(['started'])
		expect(chat.restartShellChatAfterWalletReady()).toBe('skipped')
		expect(start).not.toHaveBeenCalled()
	})

	it('a start that is still running is not doubled by the event (never two at once)', async () => {
		let release: (v: string) => void = () => undefined
		const { chat, start } = load(['no_key'])
		start.mockImplementationOnce(() => new Promise<string>((resolve) => { release = resolve }))
		const running = chat.initChat(noop, noop, noop, false, noop)
		await flush()
		expect(chat.restartShellChatAfterWalletReady()).toBe('skipped')
		expect(start).toHaveBeenCalledTimes(1) // no second start while the first one runs
		release('no_key')
		await running
	})

	// (item d): the event is not lost
	it('a wallet-ready event during a running start is queued: when that start ends with no_key, ONE more start runs at once (no ladder wait)', async () => {
		let release: (v: string) => void = () => undefined
		const { chat, start } = load(['started'])
		start.mockImplementationOnce(() => new Promise<string>((resolve) => { release = resolve }))
		const running = chat.initChat(noop, noop, noop, false, noop)
		await flush()
		expect(chat.restartShellChatAfterWalletReady()).toBe('skipped')
		release('no_key')
		await running
		await flush()
		expect(start).toHaveBeenCalledTimes(2)
	})

	it('several events during one running start are one queued start (a flag, not a count)', async () => {
		let release: (v: string) => void = () => undefined
		const { chat, start } = load(['no_key'])
		start.mockImplementationOnce(() => new Promise<string>((resolve) => { release = resolve }))
		const running = chat.initChat(noop, noop, noop, false, noop)
		await flush()
		for (let i = 0; i < 5; i++) chat.restartShellChatAfterWalletReady()
		release('no_key')
		await running
		await flush()
		expect(start).toHaveBeenCalledTimes(2) // the queued one ends no_key too: no event, no further start
		await flush()
		expect(start).toHaveBeenCalledTimes(2)
	})

	it('a queued event does nothing when the running start ends with started (the chat is live)', async () => {
		let release: (v: string) => void = () => undefined
		const { chat, start } = load(['started'])
		start.mockImplementationOnce(() => new Promise<string>((resolve) => { release = resolve }))
		const running = chat.initChat(noop, noop, noop, false, noop)
		await flush()
		chat.restartShellChatAfterWalletReady()
		release('started')
		await running
		await flush()
		expect(start).toHaveBeenCalledTimes(1)
	})

	it('a queued event does nothing after the app left the foreground (the pause clears it with the arguments)', async () => {
		let release: (v: string) => void = () => undefined
		const { chat, start } = load(['started'])
		start.mockImplementationOnce(() => new Promise<string>((resolve) => { release = resolve }))
		const running = chat.initChat(noop, noop, noop, false, noop)
		await flush()
		chat.restartShellChatAfterWalletReady()
		chat.pauseGossipListenOnBackground(noop)
		release('no_key')
		await running
		await flush()
		expect(start).toHaveBeenCalledTimes(1)
	})
})
