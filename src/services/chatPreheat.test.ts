/**
 * SDK chat preheat (sdk-roles-chat-preheat.v1). The worker start and the tail completion are stubs at the boundary (the worker and
 * IPFS are not loaded under jest); the preheat module is the real code. SYNTHETIC values only.
 */
import { startChatPreheat, awaitChatPreheat, chatPreheatState, resetChatPreheatForTest } from './chatPreheat'

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const CHAT_TEXT = 'synthetic chat body 9f3a'
const ACCOUNT = '0x9858effd232b4033e47d90003d41ec34ecaeda94'
const LINE = /^\[sdk\] preheat state=(requested|ready|failed) ms=\d+$/

/** A browser start: the worker start resolves; the tail completion is a controllable promise. */
const browserDeps = (over: Partial<Parameters<typeof startChatPreheat>[0]> = {}) => {
	const tail: { resolve: (ok: boolean) => void } = { resolve: () => undefined }
	const startWorker = jest.fn(() => Promise.resolve())
	const awaitHistoryTail = jest.fn(() => new Promise<boolean>((r) => { tail.resolve = r }))
	const lines: string[] = []
	const deps = { shell: false, accountKey: ACCOUNT, mnemonicHandle: () => PHRASE, startWorker, awaitHistoryTail, log: (l: string) => { lines.push(l) }, ...over }
	return { deps, startWorker, awaitHistoryTail, tail, lines }
}

beforeEach(() => resetChatPreheatForTest())

describe('start: preheat and history prefetch run in parallel with the wallet start (SDR-08)', () => {
	it('(+) the worker start and the tail wait are both begun before the wallet start resolves, and the wallet start does not await them', async () => {
		const order: string[] = []
		const { deps, tail } = browserDeps({
			startWorker: () => { order.push('worker-start'); return Promise.resolve() },
			awaitHistoryTail: () => { order.push('tail-wait'); return new Promise<boolean>((r) => { tail.resolve = r }) },
		})
		const preheat = startChatPreheat(deps)
		const walletStart = (async () => { order.push('wallet-start'); await Promise.resolve(); order.push('wallet-done') })()
		await walletStart
		expect(order).toEqual(['worker-start', 'tail-wait', 'wallet-start', 'wallet-done'])
		expect(chatPreheatState()).toBe('requested')
		tail.resolve(true)
		await expect(preheat).resolves.toBe(true)
	})
})

describe('browser runtime starts the preheat; shell does not (scope)', () => {
	it('(+) browser: the worker starts at account-ready and the state becomes ready only on the tail completion', async () => {
		const { deps, startWorker, tail, lines } = browserDeps()
		const p = startChatPreheat(deps)
		expect(startWorker).toHaveBeenCalledTimes(1)
		expect(chatPreheatState()).toBe('requested')
		tail.resolve(true)
		await expect(p).resolves.toBe(true)
		expect(chatPreheatState()).toBe('ready')
		expect(lines.every((l) => LINE.test(l))).toBe(true)
	})
	it('(-) shell: no worker start, no history wait, no log, nothing requested', async () => {
		const { deps, startWorker, awaitHistoryTail, lines } = browserDeps({ shell: true })
		await expect(startChatPreheat(deps)).resolves.toBe(false)
		expect(startWorker).not.toHaveBeenCalled()
		expect(awaitHistoryTail).not.toHaveBeenCalled()
		expect(lines).toEqual([])
		expect(chatPreheatState()).toBe('idle')
	})
})

describe('offline home is not blocked (SDR-10)', () => {
	it('(+) a pending tail leaves the home path free: startChatPreheat returns at once', () => {
		const { deps } = browserDeps({ awaitHistoryTail: () => new Promise<boolean>(() => undefined) })
		const t = Date.now()
		startChatPreheat(deps)
		expect(Date.now() - t).toBeLessThan(100)
		expect(chatPreheatState()).toBe('requested')
	})
	it('(+) a failed worker start resolves false, never throws, and sets failed', async () => {
		const { deps } = browserDeps({ startWorker: () => { throw new Error('boom') } })
		await expect(startChatPreheat(deps)).resolves.toBe(false)
		expect(chatPreheatState()).toBe('failed')
	})
	it('(+) a tail that never arrives (timeout reported as false) is failed, not ready', async () => {
		const { deps, tail } = browserDeps()
		const p = startChatPreheat(deps)
		tail.resolve(false)
		await expect(p).resolves.toBe(false)
		expect(chatPreheatState()).toBe('failed')
	})
})

describe('the UI reads the prepared result without a second fetch (SDR-09)', () => {
	it('(+) start once, UI reads three times: the worker start and the tail wait each run exactly once', async () => {
		const { deps, startWorker, awaitHistoryTail, tail } = browserDeps()
		const p1 = startChatPreheat(deps)
		const p2 = startChatPreheat(deps)
		const reads = [awaitChatPreheat(), awaitChatPreheat(), awaitChatPreheat()]
		tail.resolve(true)
		await expect(Promise.all(reads)).resolves.toEqual([true, true, true])
		expect(await p1).toBe(true)
		expect(await p2).toBe(true)
		expect(startWorker).toHaveBeenCalledTimes(1)
		expect(awaitHistoryTail).toHaveBeenCalledTimes(1)
	})
	it('(-) a read with no preheat running resolves false at once and starts nothing', async () => {
		await expect(awaitChatPreheat()).resolves.toBe(false)
		expect(chatPreheatState()).toBe('idle')
	})
})

describe('logs carry status codes and timing only (SDR-11)', () => {
	it('(+) requested, ready, failed lines contain no mnemonic and no chat content', async () => {
		const lines: string[] = []
		const log = (l: string) => lines.push(l)
		const ok = browserDeps({ log })
		const p1 = startChatPreheat(ok.deps)
		ok.tail.resolve(true)
		await p1
		resetChatPreheatForTest()
		const bad = browserDeps({ log, startWorker: () => Promise.reject(new Error(`${PHRASE} ${CHAT_TEXT}`)) })
		await startChatPreheat(bad.deps)
		const captured = lines.join('\n')
		expect(lines.length).toBe(4)
		for (const l of lines) expect(l).toMatch(LINE)
		expect(captured).not.toContain(PHRASE)
		expect(captured).not.toContain('abandon')
		expect(captured).not.toContain(CHAT_TEXT)
	})
})
