/**
 * @jest-environment node
 *
 * nativeAccountCreateOpen sends `{type, reqId, account}` (spec §25.46.3 / §25.52Z.2). `account` is the public BeamioTag
 * the page creates, never a credential. The shell does not build this command; the page sends it.
 */
import { NATIVE_ACCOUNT_CREATE_OPEN_COMMAND, nativeAccountCreateOpen } from './nativeRecovery'

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

function installShell(): void {
	w.CashTreesIOS = {
		chatModuleCommand: (p: { command: Sent }) => {
			const cmd = p.command
			sent.push(cmd)
			const send = (payload: Record<string, unknown>) =>
				setTimeout(() => window.dispatchEvent(new CustomEvent('cashtreesios', { detail: { action: 'chatModuleEvent', event: payload } })), 0)
			if (cmd.type === 'hello') send({ type: 'ready', reqId: cmd.reqId, result: { capabilities: ['identity.native-keys.v1'] } })
			else if (cmd.type === NATIVE_ACCOUNT_CREATE_OPEN_COMMAND) send({ type: 'ack', ok: true, page: 'opened', reqId: cmd.reqId })
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

afterEach(() => {
	delete w.CashTreesIOS
	sent = []
})

describe('nativeAccountCreateOpen request fields', () => {
	it('sends exactly type, reqId and the BeamioTag as account', async () => {
		installShell()
		const result = await settle(nativeAccountCreateOpen('alice_01'))
		expect(result).toEqual({ ok: true, page: 'opened' })
		const cmd = sent.find((c) => c.type === NATIVE_ACCOUNT_CREATE_OPEN_COMMAND) as Sent
		expect(cmd).toBeDefined()
		expect(Object.keys(cmd).sort()).toEqual(['account', 'reqId', 'type'])
		expect(cmd.account).toBe('alice_01')
		expect(typeof cmd.reqId).toBe('number')
	})

	it('never sends a key or secret field with the account', async () => {
		installShell()
		await settle(nativeAccountCreateOpen('bob'))
		const cmd = sent.find((c) => c.type === NATIVE_ACCOUNT_CREATE_OPEN_COMMAND) as Sent
		for (const k of ['privateKey', 'privateKeyHex', 'mnemonic', 'password', 'pin', 'recoveryCode']) expect(k in cmd).toBe(false)
	})
})

describe('account pre-check before the native open (§25.52Z.2)', () => {
	it.each([
		['alice_01', true],
		['0x' + 'ab'.repeat(20), true],
		['0x' + 'AB'.repeat(20), false],
		['0x123', false],
		['0xabc', false],
		['a'.repeat(64), true],
		['a'.repeat(65), false],
		['', false],
		['北京', false],
		['has space', false],
		['0xnotatag', false],
	])('%s -> valid=%s', async (account, valid) => {
		const { isValidNativeAccount } = await import('./nativeRecovery')
		expect(isValidNativeAccount(account)).toBe(valid)
	})

	it('an invalid account is refused with bad_request and nothing is sent', async () => {
		installShell()
		const result = await settle(nativeAccountCreateOpen('北京'))
		expect(result).toEqual({ ok: false, reason: 'bad_request' })
		expect(sent.some((c) => c.type === NATIVE_ACCOUNT_CREATE_OPEN_COMMAND)).toBe(false)
	})
})
