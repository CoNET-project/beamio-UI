/**
 * @jest-environment node
 *
 * 0.53.58: the one-shot identity-only init of the cold start makes the native session ready and its
 * `[history] ready` log reaches nobody; the chat start's own init is answered idempotent and logs nothing. The history load waited for
 * that log up to 90 s and the conversation list stayed on "Loading conversations…". A client of an account this page already made ready
 * takes the key as ready after the settle time. Fresh sessions, other accounts, other bridges and a global teardown keep the wait.
 * SYNTHETIC values.
 */
import { createNativeConetChatClient, initNativeIdentityOnly } from './nativeConetChatTransport'
import { forgetNativeSessionReady, HISTORY_ASSUMED_READY_SETTLE_MS, nativeSessionReadySince, noteNativeSessionReady } from './nativeSessionReady'
import { sendGlobalDestroyOnLogout } from './nativeKeyState'
import fs from 'fs'
import path from 'path'

type Cmd = { type?: string; reqId?: number }
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

const EOA = '0x39581c72b8c7d0de85ff22cf3ae178ae813957aa'
const OTHER = '0x1111111111111111111111111111111111111111'
let sent: Cmd[] = []
/** true: the module logs `[history] ready` after a (non-idempotent) init; false: it stays silent (an idempotent init). */
let logReadyAfterInit = false

function emit(event: Record<string, unknown>): void {
	setTimeout(() => window.dispatchEvent(new CustomEvent('cashtreesios', { detail: { action: 'chatModuleEvent', event } })), 0)
}

function installShell(): void {
	sent = []
	w.CashTreesIOS = {
		chatModuleCommand: (p: { command: Cmd }) => {
			const cmd = p.command
			sent.push(cmd)
			if (cmd.type === 'hello') {
				emit({ type: 'ready', reqId: cmd.reqId, result: { protocolVersion: 1, capabilities: ['identity.native-keys.v1', 'history.v2'] } })
			} else if (cmd.type === 'init') {
				emit({ type: 'ready', reqId: cmd.reqId, result: { historyApi: 2 } })
				if (logReadyAfterInit) emit({ type: 'event:log', level: 'info', message: '[history] ready genesis=abc' })
			} else if (cmd.type === 'historyLoad') {
				emit({ type: 'ack', ok: true, reqId: cmd.reqId, result: {} })
			}
		},
	}
}

function config(eoa: string = EOA) {
	return {
		identity: { eoaAddress: eoa, pgpPublicKeyArmored: '', ownRouteArmoredPublicKey: '' },
		conetRpcUrl: 'https://rpc.invalid',
		addressPgpContractAddress: '0x0000000000000000000000000000000000000001',
		getNodes: async () => [{ domain: 'synthetic.node', armoredPublicKey: 'synthetic' }] as never,
		ipfsBaseUrl: 'https://ipfs.invalid',
		apiBaseUrl: 'https://api.invalid',
		chatIndexRegistryAddress: '0x1511Caa71081C84d8a591490D1b83879088EED72',
	} as unknown as Parameters<typeof createNativeConetChatClient>[0]
}

async function advance(ms: number, step = 250): Promise<void> {
	for (let done = 0; done < ms; done += step) {
		jest.advanceTimersByTime(step)
		for (let i = 0; i < 30; i++) await Promise.resolve()
	}
}

const loads = (): number => sent.filter((c) => c.type === 'historyLoad').length

beforeEach(() => {
	forgetNativeSessionReady()
	logReadyAfterInit = false
	jest.useFakeTimers('modern')
})
afterEach(() => {
	jest.useRealTimers()
})

async function initClient(eoa: string = EOA) {
	const client = createNativeConetChatClient(config(eoa))
	const init = client.init()
	await advance(500)
	await init
	return client
}

describe('history key after an init that the module answers idempotent', () => {
	it('the one-shot cold-start init, then the chat start: the load is sent after the settle time, not after 90 s', async () => {
		installShell()
		await expect((async () => {
			const p = initNativeIdentityOnly(config())
			await advance(500)
			return p
		})()).resolves.toEqual({ ok: true })
		const client = await initClient()
		void client.history.load().catch(() => undefined)
		await advance(HISTORY_ASSUMED_READY_SETTLE_MS + 1000)
		expect(loads()).toBe(1)
	})

	it('a chat restart of the same page (a second full client): the load is also sent without the 90 s wait', async () => {
		installShell()
		logReadyAfterInit = true
		const first = await initClient()
		first.destroy()
		logReadyAfterInit = false // the module answers the restart idempotent and stays silent
		const second = await initClient()
		void second.history.load().catch(() => undefined)
		await advance(HISTORY_ASSUMED_READY_SETTLE_MS + 1000)
		expect(loads()).toBe(1)
	})

	it('the ready log, when it does come, releases the load at once (unchanged)', async () => {
		installShell()
		logReadyAfterInit = true
		const client = await initClient()
		void client.history.load().catch(() => undefined)
		await advance(500)
		expect(loads()).toBe(1)
	})

	it('a fresh session (no earlier init of this page) with no ready log waits for the iOS limit of 15 s, then goes anyway (was 90 s)', async () => {
		installShell()
		const client = await initClient()
		void client.history.load().catch(() => undefined)
		await advance(14_000, 500)
		expect(loads()).toBe(0)
		await advance(2_000, 500)
		expect(loads()).toBe(1)
	})

	it('a load that went out without the module announcing the key is repeated ONCE, 8 s later (it may have been dropped); a load after the module\'s own log is not', async () => {
		installShell()
		const client = await initClient()
		void client.history.load().catch(() => undefined)
		await advance(16_000, 500)
		expect(loads()).toBe(1)
		await advance(7_000, 500)
		expect(loads()).toBe(1)
		await advance(2_000, 500)
		expect(loads()).toBe(2) // the one repeat
		await advance(60_000, 1000)
		expect(loads()).toBe(2) // and no more
		forgetNativeSessionReady()
		logReadyAfterInit = true
		const announced = await initClient()
		const before = loads()
		void announced.history.load().catch(() => undefined)
		await advance(20_000, 500)
		expect(loads()).toBe(before + 1) // the key was announced by the module: no repeat
	})

	it('the key taken as ready by the page (idempotent init) also gets the one repeat', async () => {
		installShell()
		const p = initNativeIdentityOnly(config())
		await advance(500)
		await p
		const client = await initClient()
		void client.history.load().catch(() => undefined)
		await advance(HISTORY_ASSUMED_READY_SETTLE_MS + 1000)
		expect(loads()).toBe(1)
		await advance(9_000, 500)
		expect(loads()).toBe(2)
	})

	it('another account is a new session: it keeps the wait', async () => {
		installShell()
		const p = initNativeIdentityOnly(config(OTHER))
		await advance(500)
		await p
		const client = await initClient(EOA)
		void client.history.load().catch(() => undefined)
		await advance(HISTORY_ASSUMED_READY_SETTLE_MS + 1000)
		expect(loads()).toBe(0)
	})

	it('after the global teardown (logout, lock) the next init is a new session: it keeps the wait', async () => {
		installShell()
		const p = initNativeIdentityOnly(config())
		await advance(500)
		await p
		forgetNativeSessionReady()
		const client = await initClient()
		void client.history.load().catch(() => undefined)
		await advance(HISTORY_ASSUMED_READY_SETTLE_MS + 1000)
		expect(loads()).toBe(0)
	})

	it('the settle time counts from the earlier init: a chat start right behind it waits only for the rest', async () => {
		installShell()
		const p = initNativeIdentityOnly(config())
		await advance(500)
		await p
		const client = createNativeConetChatClient(config())
		const init = client.init()
		await advance(500)
		await init
		void client.history.load().catch(() => undefined)
		await advance(250)
		expect(loads()).toBe(0) // still inside the settle time of the earlier init
		await advance(HISTORY_ASSUMED_READY_SETTLE_MS)
		expect(loads()).toBe(1)
	})
})

describe('the logout / lock teardown clears the registry (wiring)', () => {
	it('sendGlobalDestroyOnLogout forgets every registered session (behaviour)', () => {
		noteNativeSessionReady('ios native chat', EOA)
		expect(nativeSessionReadySince('ios native chat', EOA)).not.toBeNull()
		sendGlobalDestroyOnLogout()
		expect(nativeSessionReadySince('ios native chat', EOA)).toBeNull()
	})
	it('the call is in place before the command is posted (static)', () => {
		const src = fs.readFileSync(path.join(__dirname, 'nativeKeyState.ts'), 'utf8')
		const fn = src.slice(src.indexOf('export function sendGlobalDestroyOnLogout'), src.indexOf('export function sendGlobalDestroyOnLogout') + 400)
		expect(fn).toMatch(/forgetNativeSessionReady\(\)[\s\S]*postChatModuleCommand\(buildGlobalDestroyCommand\(\)\)/)
	})
})

