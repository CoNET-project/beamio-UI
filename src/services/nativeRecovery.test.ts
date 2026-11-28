/**
 * @jest-environment node
 *
 * Recovery in a shell: the page sends `{type, reqId}` only and receives short result codes. A non-ok
 * result keeps the listening; `ok` ends it; a page that stays open for 10 minutes with no result is cancelled locally once visible.
 * No secret is sent, and an unknown result code is ignored.
 */
import {
	NATIVE_RECOVERY_LOCAL_CANCEL_MS,
	NATIVE_ACCOUNT_CREATE_OPEN_COMMAND,
	NATIVE_RECOVERY_OPEN_COMMAND,
	NATIVE_RECOVERY_RESULT_CODES,
	nativeAccountCreateOpen,
	nativeRecoveryOpen,
	onNativeAccountCreateResult,
	onNativeRecoveryResult,
	recoveryOpenErrorKey,
} from './nativeRecovery'

type Sent = Record<string, unknown>
type Win = EventTarget & { CashTreesIOS?: unknown }
const w = new EventTarget() as Win
;(globalThis as unknown as { window: Win }).window = w
class ShellCustomEvent extends Event {
	readonly detail: unknown
	constructor(type: string, init?: { detail?: unknown }) {
		super(type)
		this.detail = init?.detail
	}
}
;(globalThis as unknown as { CustomEvent: typeof ShellCustomEvent }).CustomEvent = ShellCustomEvent

let sent: Sent[] = []

function installShell(reply: Record<string, unknown>): void {
	w.CashTreesIOS = {
		chatModuleCommand: (p: { command: Sent }) => {
			const cmd = p.command
			sent.push(cmd)
			const send = (payload: Record<string, unknown>) =>
				setTimeout(() => window.dispatchEvent(new CustomEvent('cashtreesios', { detail: { action: 'chatModuleEvent', event: payload } })), 0)
			if (cmd.type === 'hello') send({ type: 'ack', reqId: cmd.reqId, ok: true, result: { capabilities: [] } })
			else if (cmd.type === NATIVE_RECOVERY_OPEN_COMMAND) send({ ...reply, reqId: cmd.reqId })
		},
	}
}

/** Raw delivery, with the reqId as given (the B7 filter tests). */
const emitRaw = (event: Record<string, unknown>) =>
	window.dispatchEvent(new CustomEvent('cashtreesios', { detail: { action: 'chatModuleEvent', event } }))

/** Mapping tests: a result without a reqId is delivered (QA candidate period, with a warning); the reqId filter has its own tests below. */
const emitResult = (event: Record<string, unknown>) => {
	const { reqId: _reqId, ...rest } = event
	void _reqId
	emitRaw(rest)
}

/** Lets the fake shell's replies (timers) and the promise chain run, under fake timers. */
async function settle<T>(p: Promise<T>): Promise<T> {
	let done = false
	void p.then(() => (done = true))
	for (let i = 0; i < 500 && !done; i++) {
		jest.advanceTimersByTime(1)
		await Promise.resolve()
	}
	return p
}

beforeEach(() => {
	sent = []
})
// A standing listener keeps the window listener installed, so the end-of-test cancelled ends any open watch.
let standing: (() => void) | undefined
beforeEach(() => {
	standing = onNativeRecoveryResult(() => undefined)
})
afterEach(() => {
	// An open page that was acknowledged starts a watch; a cancelled result ends it (the standing listener is still subscribed).
	emitResult({ type: 'nativeRecoveryResult', reqId: 0, code: 'cancelled' })
	standing?.()
	delete w.CashTreesIOS
})

describe('nativeRecoveryOpen', () => {
	it('sends only type and reqId, and resolves ok on the acknowledgement (not yet a success)', async () => {
		installShell({ type: 'ack', ok: true })
		await expect(nativeRecoveryOpen()).resolves.toEqual({ ok: true })
		const cmd = sent.find((c) => c.type === NATIVE_RECOVERY_OPEN_COMMAND) as Sent
		expect(Object.keys(cmd).sort()).toEqual(['reqId', 'type'])
	})

	it('a refusal from the shell returns its code', async () => {
		installShell({ type: 'ack', ok: false, error: 'not_supported' })
		await expect(nativeRecoveryOpen()).resolves.toEqual({ ok: false, reason: 'not_supported' })
	})
})

describe('onNativeRecoveryResult', () => {
	it('delivers a known code, with the public address on ok', () => {
		const got: unknown[] = []
		const off = onNativeRecoveryResult((r) => got.push(r))
		emitResult({ type: 'nativeRecoveryResult', reqId: 1, code: 'ok', eoa: '0x' + 'ab'.repeat(20) })
		off()
		expect(got).toEqual([{ code: 'ok', eoa: '0x' + 'ab'.repeat(20), cooldownSec: undefined }])
	})

	it('carries the cooldown with backoff', () => {
		const got: unknown[] = []
		const off = onNativeRecoveryResult((r) => got.push(r))
		emitResult({ type: 'nativeRecoveryResult', reqId: 2, code: 'backoff', cooldownSec: 30 })
		off()
		expect(got).toEqual([{ code: 'backoff', eoa: undefined, cooldownSec: 30 }])
	})

	it('eoa comes only with ok, and cooldownSec only with backoff', () => {
		const got: unknown[] = []
		const off = onNativeRecoveryResult((r) => got.push(r))
		emitResult({ type: 'nativeRecoveryResult', reqId: 5, code: 'bad_pin', eoa: '0x' + 'ab'.repeat(20), cooldownSec: 30 })
		emitResult({ type: 'nativeRecoveryResult', reqId: 6, code: 'cancelled', eoa: '0x' + 'ab'.repeat(20) })
		off()
		expect(got).toEqual([
			{ code: 'bad_pin', eoa: undefined, cooldownSec: undefined },
			{ code: 'cancelled', eoa: undefined, cooldownSec: undefined },
		])
	})

	it('accepts legacy_record (a record in the pre-migration registry)', () => {
		expect(NATIVE_RECOVERY_RESULT_CODES).toContain('legacy_record')
		const got: unknown[] = []
		const off = onNativeRecoveryResult((r) => got.push(r))
		emitResult({ type: 'nativeRecoveryResult', reqId: 7, code: 'legacy_record' })
		off()
		expect(got).toEqual([{ code: 'legacy_record', eoa: undefined, cooldownSec: undefined }])
	})

	it('a non-ok result keeps the listening, so the page can retry; ok ends it', () => {
		const got: string[] = []
		const off = onNativeRecoveryResult((r) => got.push(r.code))
		emitResult({ type: 'nativeRecoveryResult', reqId: 8, code: 'bad_pin' })
		emitResult({ type: 'nativeRecoveryResult', reqId: 9, code: 'not_found' })
		emitResult({ type: 'nativeRecoveryResult', reqId: 10, code: 'ok', eoa: '0x' + 'cd'.repeat(20) })
		emitResult({ type: 'nativeRecoveryResult', reqId: 11, code: 'bad_pin' })
		off()
		expect(got).toEqual(['bad_pin', 'not_found', 'ok'])
	})

	it('passes an unknown code on as unknown; the raw string is never passed on', () => {
		const got: unknown[] = []
		const off = onNativeRecoveryResult((r) => got.push(r))
		emitResult({ type: 'nativeRecoveryResult', reqId: 3, code: 'recovery_code_is_12_words' })
		off()
		expect(got).toEqual([{ code: 'unknown' }])
		expect(JSON.stringify(got)).not.toContain('recovery_code_is_12_words')
	})

	it('stops after unsubscribe', () => {
		const got: unknown[] = []
		const off = onNativeRecoveryResult((r) => got.push(r))
		off()
		emitResult({ type: 'nativeRecoveryResult', reqId: 4, code: 'cancelled' })
		expect(got).toEqual([])
	})
})

describe('the 10-minute local cancel', () => {
	afterEach(() => {
		jest.useRealTimers()
	})

	it('a page open for 10 minutes with no result is cancelled locally', async () => {
		jest.useFakeTimers()
		installShell({ type: 'ack', ok: true })
		const got: unknown[] = []
		const off = onNativeRecoveryResult((r) => got.push(r))
		await expect(settle(nativeRecoveryOpen())).resolves.toEqual({ ok: true })
		expect(got).toEqual([])
		jest.advanceTimersByTime(NATIVE_RECOVERY_LOCAL_CANCEL_MS)
		expect(got).toEqual([{ code: 'cancelled', eoa: undefined, cooldownSec: undefined }])
		off()
	})

	it('a result inside the window means no local cancel later', async () => {
		jest.useFakeTimers()
		installShell({ type: 'ack', ok: true })
		const got: string[] = []
		const off = onNativeRecoveryResult((r) => got.push(r.code))
		await settle(nativeRecoveryOpen())
		emitResult({ type: 'nativeRecoveryResult', reqId: 12, code: 'bad_pin' })
		jest.advanceTimersByTime(NATIVE_RECOVERY_LOCAL_CANCEL_MS * 2)
		expect(got).toEqual(['bad_pin'])
		off()
	})
})

describe('recoveryOpenErrorKey (the line shown when the native page cannot open)', () => {
	it('not_supported and not_available have their own lines', () => {
		expect(recoveryOpenErrorKey('not_supported')).toBe('recovery.native.not_supported')
		expect(recoveryOpenErrorKey('not_available')).toBe('recovery.native.not_available')
	})

	it('any other refusal, a timeout or an unknown reason uses the generic restore failure', () => {
		for (const r of ['bad_request', 'key_over_bridge_refused', 'timeout', 'unavailable']) {
			expect(recoveryOpenErrorKey(r)).toBe('something_went_wrong_while_restoring_your_wallet')
		}
	})
})

describe('B7 reqId filter', () => {
	it('delivers a result whose reqId is the open request reqId, and discards a mismatched one', async () => {
		installShell({ type: 'ack', ok: true })
		const got: unknown[] = []
		const off = onNativeRecoveryResult((r) => got.push(r))
		await settle(nativeRecoveryOpen())
		const openId = (sent.find((c) => c.type === NATIVE_RECOVERY_OPEN_COMMAND) as { reqId: number }).reqId
		emitRaw({ type: 'nativeRecoveryResult', reqId: openId + 999, code: 'bad_pin' })
		emitRaw({ type: 'nativeRecoveryResult', reqId: openId, code: 'bad_pin' })
		expect(got).toEqual([{ code: 'bad_pin' }])
		off()
	})

	it('delivers a result with no reqId during the QA candidate period', async () => {
		installShell({ type: 'ack', ok: true })
		const got: unknown[] = []
		const off = onNativeRecoveryResult((r) => got.push(r))
		await settle(nativeRecoveryOpen())
		emitRaw({ type: 'nativeRecoveryResult', code: 'not_found' })
		expect(got).toEqual([{ code: 'not_found' }])
		off()
	})
})

/** A shell that sends the RESULT event first and the ack after it, or the other way round. */
function installOrderedShell(openCommand: string, results: (reqId: number) => Array<Record<string, unknown>>, ack: Record<string, unknown>, order: 'result_first' | 'ack_first'): void {
	w.CashTreesIOS = {
		chatModuleCommand: (p: { command: Sent }) => {
			const cmd = p.command
			sent.push(cmd)
			const send = (payload: Record<string, unknown>, delay: number) =>
				setTimeout(() => window.dispatchEvent(new CustomEvent('cashtreesios', { detail: { action: 'chatModuleEvent', event: payload } })), delay)
			if (cmd.type === 'hello') send({ type: 'ack', reqId: cmd.reqId, ok: true, result: { capabilities: [] } }, 0)
			else if (cmd.type === openCommand) {
				const reqId = cmd.reqId as number
				const resultDelay = order === 'result_first' ? 0 : 5
				const ackDelay = order === 'result_first' ? 5 : 0
				for (const r of results(reqId)) send(r, resultDelay)
				send({ ...ack, reqId }, ackDelay)
			}
		},
	}
}

describe('the result may reach the page before the ack, either order is accepted', () => {
	afterEach(() => {
		jest.useRealTimers()
	})
	const eoa = '0x' + 'ab'.repeat(20)

	it('recovery: a non-ok result BEFORE the ack is delivered once, when the ack ok arrives (same as the other order)', async () => {
		for (const order of ['result_first', 'ack_first'] as const) {
			jest.useFakeTimers()
			installOrderedShell(NATIVE_RECOVERY_OPEN_COMMAND, (reqId) => [{ type: 'nativeRecoveryResult', reqId, code: 'bad_pin' }], { type: 'ack', ok: true }, order)
			const got: unknown[] = []
			const off = onNativeRecoveryResult((r) => got.push(r))
			await expect(settle(nativeRecoveryOpen())).resolves.toEqual({ ok: true })
			jest.advanceTimersByTime(20)
			expect(got).toEqual([{ code: 'bad_pin' }])
			off()
			jest.useRealTimers()
		}
	})

	it('recovery: an ok result before the ack is delivered with the address, and the 10-minute local cancel does not fire afterwards', async () => {
		jest.useFakeTimers()
		installOrderedShell(NATIVE_RECOVERY_OPEN_COMMAND, (reqId) => [{ type: 'nativeRecoveryResult', reqId, code: 'ok', eoa }], { type: 'ack', ok: true }, 'result_first')
		const got: unknown[] = []
		const off = onNativeRecoveryResult((r) => got.push(r))
		await expect(settle(nativeRecoveryOpen())).resolves.toEqual({ ok: true })
		jest.advanceTimersByTime(NATIVE_RECOVERY_LOCAL_CANCEL_MS * 2)
		expect(got).toEqual([{ code: 'ok', eoa }])
		off()
	})

	it('recovery: a result before a REFUSED ack is discarded (a result is delivered only for an open the shell acknowledged with ok); a result with another reqId before the ack is never delivered', async () => {
		jest.useFakeTimers()
		installOrderedShell(NATIVE_RECOVERY_OPEN_COMMAND, (reqId) => [{ type: 'nativeRecoveryResult', reqId, code: 'ok', eoa }], { type: 'ack', ok: false, error: 'not_available' }, 'result_first')
		const got: unknown[] = []
		const off = onNativeRecoveryResult((r) => got.push(r))
		await expect(settle(nativeRecoveryOpen())).resolves.toEqual({ ok: false, reason: 'not_available' })
		jest.advanceTimersByTime(20)
		expect(got).toEqual([])
		installOrderedShell(NATIVE_RECOVERY_OPEN_COMMAND, (reqId) => [{ type: 'nativeRecoveryResult', reqId: reqId + 777, code: 'bad_pin' }], { type: 'ack', ok: true }, 'result_first')
		await settle(nativeRecoveryOpen())
		jest.advanceTimersByTime(20)
		expect(got).toEqual([])
		off()
	})

	it('account create: a result BEFORE the ack is delivered when the ack ok arrives, in either order; before a refused ack it is discarded', async () => {
		const eoaCreate = '0x' + 'cd'.repeat(20)
		const result = (reqId: number) => ({ type: 'nativeAccountCreateResult', reqId, ok: true, result: { code: 'ok', eoa: eoaCreate } })
		for (const order of ['result_first', 'ack_first'] as const) {
			jest.useFakeTimers()
			installOrderedShell(NATIVE_ACCOUNT_CREATE_OPEN_COMMAND, (reqId) => [result(reqId)], { type: 'ack', ok: true, page: 'opened' }, order)
			const got: unknown[] = []
			const off = onNativeAccountCreateResult((r) => got.push(r))
			await expect(settle(nativeAccountCreateOpen('someone'))).resolves.toMatchObject({ ok: true })
			jest.advanceTimersByTime(20)
			expect(got).toEqual([{ code: 'ok', eoa: eoaCreate }])
			off()
			jest.useRealTimers()
		}
		jest.useFakeTimers()
		installOrderedShell(NATIVE_ACCOUNT_CREATE_OPEN_COMMAND, (reqId) => [result(reqId)], { type: 'ack', ok: false, error: 'not_available' }, 'result_first')
		const refused: unknown[] = []
		const off = onNativeAccountCreateResult((r) => refused.push(r))
		await settle(nativeAccountCreateOpen('someone'))
		jest.advanceTimersByTime(20)
		expect(refused).toEqual([])
		off()
	})

	it('the hold is wired in the source: a pending reqId is set before the ack wait, held results are released only after the ack ok', () => {
		const fs = require('fs') as typeof import('fs')
		const src = fs.readFileSync(require('path').join(__dirname, 'nativeRecovery.ts'), 'utf8')
		expect(src.indexOf('pendingRecoveryReqId = reqId')).toBeLessThan(src.indexOf('await requestNativeAck({ type: NATIVE_RECOVERY_OPEN_COMMAND }'))
		expect(src.indexOf('for (const r of held) handleRecoveryResult(r)')).toBeGreaterThan(src.indexOf('openedRecoveryReqId = reqId\n\t\tbeginWatch()'))
		expect(src).toMatch(/openedCreateReqId = reqId\s*\n\s*for \(const p of held\) for \(const replay of createReplays\) replay\(p\)/)
	})
})

describe('late events and the passive subscription: no extra navigation', () => {
	it('a result that arrives after the subscription ended reaches nobody', () => {
		const got: string[] = []
		const off = onNativeRecoveryResult((r) => got.push(r.code))
		emitResult({ type: 'nativeRecoveryResult', code: 'bad_pin' })
		off()
		emitResult({ type: 'nativeRecoveryResult', code: 'ok', eoa: '0x' + 'ab'.repeat(20) })
		emitResult({ type: 'nativeRecoveryResult', code: 'bad_pin' })
		expect(got).toEqual(['bad_pin'])
	})
	it('an ok is delivered once: the subscriber is removed by it, so a late duplicate ok brings no second navigation', () => {
		const got: string[] = []
		const off = onNativeRecoveryResult((r) => got.push(r.code))
		emitResult({ type: 'nativeRecoveryResult', code: 'ok', eoa: '0x' + 'ab'.repeat(20) })
		emitResult({ type: 'nativeRecoveryResult', code: 'ok', eoa: '0x' + 'ab'.repeat(20) })
		expect(got).toEqual(['ok'])
		off()
	})
	it('the entry gate subscribes only while the native recovery exit is on screen, and its cleanup is the unsubscribe (a late event after the exit is gone cannot navigate)', () => {
		const fs = require('fs') as typeof import('fs')
		const gate = fs.readFileSync(require('path').join(__dirname, '../components/AppEntryGate.tsx'), 'utf8')
		expect(gate).toMatch(/if \(storageUnavailable !== 'native_recovery_needed'\) return\s*\n\s*return onNativeRecoveryResult\(\(\{ code, eoa \}\) => \{/)
		expect(gate).toMatch(/\}\)\s*\}, \[storageUnavailable\]\)/)
		// the ok branch ends the exit first (setStorageUnavailable(null)) and then asks for the wallet once
		expect(gate).toMatch(/setStorageUnavailable\(null\)\s*\n\s*void reachNativeWallet\(\)\.then\(\(\) => notifyNativeWalletReady\(''\)\)\s*\n\s*return/)
	})
})
