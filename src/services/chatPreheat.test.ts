/**
 * SDK chat preheat (sdk-roles-chat-preheat.v1). The worker start and the tail completion are stubs at the boundary (the worker and
 * IPFS are not loaded under jest); the preheat module is the real code. SYNTHETIC values only.
 */
import { startChatPreheat, awaitChatPreheat, chatPreheatState, resetChatPreheatForTest, isMigratedState, resolveLibraryState, unknownStateRetryOf, MAX_UNKNOWN_STATE_RETRIES } from './chatPreheat'

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

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// G1-b: the library read does not wait for the whole preheat
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
import { PREHEAT_JOIN_MAX_MS, awaitBounded, preheatWaitPlan } from './chatPreheat'

describe('G1-b: preheatWaitPlan and awaitBounded', () => {
	it('a library that already answers (switched, purged) is read at once: no wait at all', () => {
		for (const s of ['switched', 'purged']) expect(preheatWaitPlan(s)).toEqual({ wait: false, boundMs: 0 })
	})
	it('every other state (not answered yet, none, running, complete) joins the preheat for at most 3 s', () => {
		expect(PREHEAT_JOIN_MAX_MS).toBe(3000)
		for (const s of [null, 'none', 'running', 'complete']) expect(preheatWaitPlan(s)).toEqual({ wait: true, boundMs: 3000 })
	})
	it('awaitBounded: a preheat that never completes is left after the bound (false); one that completes in time hands over its answer; a rejection is false', async () => {
		jest.useFakeTimers()
		try {
			let settled: boolean | null = null
			const never = new Promise<boolean>(() => undefined)
			void awaitBounded(never, 3000).then((v) => { settled = v })
			jest.advanceTimersByTime(2999)
			await Promise.resolve()
			expect(settled).toBeNull()
			jest.advanceTimersByTime(2)
			await Promise.resolve()
			expect(settled).toBe(false)
			await expect(awaitBounded(Promise.resolve(true), 3000)).resolves.toBe(true)
			await expect(awaitBounded(Promise.reject(new Error('x')), 3000)).resolves.toBe(false)
		} finally {
			jest.useRealTimers()
		}
	})
	it('freeze blocker 1: state first null (unknown) then switched: the state after the wait is the one `migrated` is computed from', () => {
		const before: string | null = null
		const after: string | null = 'switched'
		expect(isMigratedState(before)).toBe(false) // computed from the state before the wait the library page would not be merged
		const resolved = resolveLibraryState(before, after)
		expect(resolved).toBe('switched')
		expect(isMigratedState(resolved)).toBe(true)
	})
	it('a known state is never replaced by an unknown one; purged counts as migrated, none/running/complete/null do not', () => {
		expect(resolveLibraryState('switched', null)).toBe('switched')
		expect(resolveLibraryState('running', 'complete')).toBe('complete')
		expect(resolveLibraryState(null, null)).toBeNull()
		expect(isMigratedState('purged')).toBe(true)
		for (const s of [null, 'none', 'running', 'complete']) expect(isMigratedState(s)).toBe(false)
	})
	it('still unknown with a local library page: ask again, at most MAX_UNKNOWN_STATE_RETRIES times; a known state, or a non-local page, never retries', () => {
		expect(unknownStateRetryOf({ state: null, pageLocal: true, retries: 0 })).toBe(true)
		expect(unknownStateRetryOf({ state: null, pageLocal: true, retries: MAX_UNKNOWN_STATE_RETRIES - 1 })).toBe(true)
		expect(unknownStateRetryOf({ state: null, pageLocal: true, retries: MAX_UNKNOWN_STATE_RETRIES })).toBe(false)
		expect(unknownStateRetryOf({ state: null, pageLocal: false, retries: 0 })).toBe(false)
		expect(unknownStateRetryOf({ state: 'switched', pageLocal: true, retries: 0 })).toBe(false)
	})
	it('the 90 s bound of the tail waiter is NOT lowered', () => {
		const bridge = require('fs').readFileSync(require('path').join(__dirname, 'chatWorkerBridge.ts'), 'utf8') as string
		expect(bridge).toMatch(/const HISTORY_TAIL_TIMEOUT_MS = 90_000/)
	})
})
