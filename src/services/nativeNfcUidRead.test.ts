/**
 * @jest-environment node
 *
 * Neutral card read in a shell (client NFC,  2026-11-13). The page sends `{type, reqId}` only; the shell answers with
 * the UID and, when present, the SUN parameters. No bind semantics, no key material, a short result code for every failure.
 */
import {
	NATIVE_NFC_UID_READ_COMMAND,
	NATIVE_NFC_UID_RESULT_EVENT,
	nativeNfcUidRead,
	parseNfcUidResult,
} from './nativeNfcUidRead'

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

const UID = '04a1b2c3d4e5f6'
const SUN = { e: 'ab'.repeat(32), c: '00003d', m: '1122334455667788' }

let sent: Sent[] = []

/** A shell that answers `hello` and the read command with `ack`, then sends `result` (if any) as an event. */
function installShell(ack: Record<string, unknown>, result?: Record<string, unknown>): void {
	w.CashTreesIOS = {
		chatModuleCommand: (p: { command: Sent }) => {
			const cmd = p.command
			sent.push(cmd)
			const send = (payload: Record<string, unknown>) =>
				setTimeout(
					() => window.dispatchEvent(new CustomEvent('cashtreesios', { detail: { action: 'chatModuleEvent', event: payload } })),
					0,
				)
			if (cmd.type === 'hello') send({ type: 'ack', reqId: cmd.reqId, ok: true, result: { capabilities: [] } })
			else if (cmd.type === NATIVE_NFC_UID_READ_COMMAND) {
				send({ ...ack, reqId: cmd.reqId })
				if (result) send(result)
			}
		},
	}
}

beforeEach(() => {
	sent = []
})
afterEach(() => {
	delete w.CashTreesIOS
})

describe('the command carries no bind meaning and no key material', () => {
	it('the command name does not say bind', () => {
		expect(NATIVE_NFC_UID_READ_COMMAND).not.toMatch(/bind/i)
		expect(NATIVE_NFC_UID_RESULT_EVENT).not.toMatch(/bind/i)
	})

	it('the read command sends only type and reqId', async () => {
		installShell({ type: 'ack', ok: true }, { type: NATIVE_NFC_UID_RESULT_EVENT, code: 'ok', uid: UID })
		await nativeNfcUidRead()
		const cmd = sent.find((c) => c.type === NATIVE_NFC_UID_READ_COMMAND) as Sent
		expect(Object.keys(cmd).sort()).toEqual(['reqId', 'type'])
	})
})

describe('parseNfcUidResult', () => {
	it('accepts a UID and normalises it to lower case', () => {
		expect(parseNfcUidResult({ type: NATIVE_NFC_UID_RESULT_EVENT, code: 'ok', uid: UID.toUpperCase() })).toEqual({
			ok: true,
			uid: UID,
		})
	})

	it('accepts SUN parameters when all three are well formed', () => {
		expect(
			parseNfcUidResult({ type: NATIVE_NFC_UID_RESULT_EVENT, code: 'ok', uid: UID, e: SUN.e.toUpperCase(), c: SUN.c, m: SUN.m }),
		).toEqual({ ok: true, uid: UID, sun: { e: SUN.e, c: SUN.c, m: SUN.m } })
	})

	it('a UID that is not 14 hex characters is an invalid tag', () => {
		expect(parseNfcUidResult({ type: NATIVE_NFC_UID_RESULT_EVENT, code: 'ok', uid: '04a1b2c3d4e5f' })).toEqual({ ok: false, reason: 'invalid_tag' })
	})

	it('malformed SUN parameters are an invalid tag, not a partial success', () => {
		expect(
			parseNfcUidResult({ type: NATIVE_NFC_UID_RESULT_EVENT, code: 'ok', uid: UID, e: 'ab', c: SUN.c, m: SUN.m }),
		).toEqual({ ok: false, reason: 'invalid_tag' })
	})

	it('a failure code is passed through', () => {
		expect(parseNfcUidResult({ type: NATIVE_NFC_UID_RESULT_EVENT, code: 'cancelled' })).toEqual({ ok: false, reason: 'cancelled' })
		expect(parseNfcUidResult({ type: NATIVE_NFC_UID_RESULT_EVENT, code: 'permission_denied' })).toEqual({
			ok: false,
			reason: 'permission_denied',
		})
	})

	it('an unknown code or another event type is ignored (null)', () => {
		expect(parseNfcUidResult({ type: NATIVE_NFC_UID_RESULT_EVENT, code: 'bound_card_ok' })).toBeNull()
		expect(parseNfcUidResult({ type: 'nfcPhysicalCard', code: 'ok', uid: UID })).toBeNull()
	})
})

describe('nativeNfcUidRead against a shell', () => {
	it('resolves the UID and the SUN parameters from the result event', async () => {
		installShell(
			{ type: 'ack', ok: true },
			{ type: NATIVE_NFC_UID_RESULT_EVENT, code: 'ok', uid: UID, e: SUN.e, c: SUN.c, m: SUN.m },
		)
		await expect(nativeNfcUidRead()).resolves.toEqual({ ok: true, uid: UID, sun: SUN })
	})

	it('resolves the UID alone when the tag gives no SUN parameters', async () => {
		installShell({ type: 'ack', ok: true }, { type: NATIVE_NFC_UID_RESULT_EVENT, code: 'ok', uid: UID })
		await expect(nativeNfcUidRead()).resolves.toEqual({ ok: true, uid: UID })
	})

	it('a user cancel resolves cancelled', async () => {
		installShell({ type: 'ack', ok: true }, { type: NATIVE_NFC_UID_RESULT_EVENT, code: 'cancelled' })
		await expect(nativeNfcUidRead()).resolves.toEqual({ ok: false, reason: 'cancelled' })
	})

	it('a shell that refuses the command resolves with its reason', async () => {
		installShell({ type: 'ack', ok: false, error: 'not_supported' })
		await expect(nativeNfcUidRead()).resolves.toEqual({ ok: false, reason: 'not_supported' })
	})

	it('no answer within the timeout resolves timeout', async () => {
		installShell({ type: 'ack', ok: true })
		await expect(nativeNfcUidRead({ timeoutMs: 40 })).resolves.toEqual({ ok: false, reason: 'timeout' })
	})

	it('without a native bridge the read reports native_unavailable and sends nothing', async () => {
		await expect(nativeNfcUidRead()).resolves.toEqual({ ok: false, reason: 'native_unavailable' })
		expect(sent.find((c) => c.type === NATIVE_NFC_UID_READ_COMMAND)).toBeUndefined()
	})
})
