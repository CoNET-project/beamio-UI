/**
 * @jest-environment node
 *
 * Regression (PM request, Android review): every native open gets a fresh reqId, including a retry after a failed open.
 * The shell de-duplicates by reqId (N-31–42), so a retry that reuses an id would be treated as the same request.
 * The fake shell answers each open with the next scripted reply and records the reqId it was sent.
 */
import {
	NATIVE_ACCOUNT_CREATE_OPEN_COMMAND,
	NATIVE_RECOVERY_OPEN_COMMAND,
	nativeAccountCreateOpen,
	nativeRecoveryOpen,
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
/** Scripted replies for open commands, consumed in order. */
let replies: Record<string, unknown>[] = []

function installShell(): void {
	w.CashTreesIOS = {
		chatModuleCommand: (p: { command: Sent }) => {
			const cmd = p.command
			sent.push(cmd)
			const send = (payload: Record<string, unknown>) =>
				setTimeout(() => window.dispatchEvent(new CustomEvent('cashtreesios', { detail: { action: 'chatModuleEvent', event: payload } })), 0)
			if (cmd.type === 'hello') send({ type: 'ready', reqId: cmd.reqId, result: { capabilities: ['identity.native-keys.v1'] } })
			else if (cmd.type === NATIVE_RECOVERY_OPEN_COMMAND || cmd.type === NATIVE_ACCOUNT_CREATE_OPEN_COMMAND) {
				const next = replies.shift() ?? { type: 'ack', ok: true, page: 'opened' }
				send({ ...next, reqId: cmd.reqId })
			}
		},
	}
}

async function settle<T>(p: Promise<T>): Promise<T> {
	let done = false
	void p.then(() => (done = true))
	for (let i = 0; i < 500 && !done; i++) {
		await new Promise((r) => setTimeout(r, 1))
	}
	return p
}

/** The reqIds of the open commands only (hello is not an open). */
const openReqIds = (type: string): unknown[] => sent.filter((c) => c.type === type).map((c) => c.reqId)

beforeEach(() => {
	installShell()
})

afterEach(() => {
	delete w.CashTreesIOS
	sent = []
	replies = []
})

describe('native open reqId is fresh on every attempt', () => {
	it('two consecutive recovery opens send different reqIds', async () => {
		await settle(nativeRecoveryOpen())
		await settle(nativeRecoveryOpen())
		const ids = openReqIds(NATIVE_RECOVERY_OPEN_COMMAND)
		expect(ids).toHaveLength(2)
		expect(typeof ids[0]).toBe('number')
		expect(ids[0]).not.toBe(ids[1])
	})

	it('a recovery retry after a failed open sends a new reqId', async () => {
		replies = [{ type: 'ack', ok: false, error: 'native_busy' }]
		const first = await settle(nativeRecoveryOpen())
		expect(first.ok).toBe(false)
		const second = await settle(nativeRecoveryOpen())
		expect(second.ok).toBe(true)
		const ids = openReqIds(NATIVE_RECOVERY_OPEN_COMMAND)
		expect(ids).toHaveLength(2)
		expect(ids[0]).not.toBe(ids[1])
	})

	it('two consecutive account-create opens send different reqIds', async () => {
		await settle(nativeAccountCreateOpen('alice'))
		await settle(nativeAccountCreateOpen('alice'))
		const ids = openReqIds(NATIVE_ACCOUNT_CREATE_OPEN_COMMAND)
		expect(ids).toHaveLength(2)
		expect(ids[0]).not.toBe(ids[1])
	})

	it('an account-create retry after a failed open sends a new reqId', async () => {
		replies = [{ type: 'ack', ok: false, error: 'lookup_unavailable' }]
		const first = await settle(nativeAccountCreateOpen('alice'))
		expect(first.ok).toBe(false)
		const second = await settle(nativeAccountCreateOpen('alice'))
		expect(second.ok).toBe(true)
		const ids = openReqIds(NATIVE_ACCOUNT_CREATE_OPEN_COMMAND)
		expect(ids).toHaveLength(2)
		expect(ids[0]).not.toBe(ids[1])
	})
})
