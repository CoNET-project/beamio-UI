/**
 * @jest-environment node
 *
 * Recovery in a shell: the page sends `{type, reqId}` only and receives short result codes. A non-ok
 * result keeps the listening; `ok` ends it; a page that stays open for 10 minutes with no result is cancelled locally once visible.
 * No secret is sent, and an unknown result code is ignored.
 */
import {
	NATIVE_RECOVERY_LOCAL_CANCEL_MS,
	NATIVE_RECOVERY_OPEN_COMMAND,
	NATIVE_RECOVERY_RESULT_CODES,
	nativeRecoveryOpen,
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
			if (cmd.type === 'hello') send({ type: 'ready', reqId: cmd.reqId, result: { capabilities: [] } })
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

describe('B7 reqId filter (§25.52Y.48, PM ruling)', () => {
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
