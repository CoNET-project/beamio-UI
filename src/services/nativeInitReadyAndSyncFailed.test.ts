/**
 * @jest-environment node
 *
 * 0.53.47: (1) a native init that finishes with the `ready` event is a success (a store account's first ready path), and an init whose
 * ready never comes ends as a failure after the init window, with no success claimed; (2) a history load answered with `sync_failed` is
 * retried, bounded, and is never read as synced or as an empty history. SYNTHETIC values.
 */
import { createNativeConetChatClient, initNativeIdentityOnly } from './nativeConetChatTransport'

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
let sent: Cmd[] = []
type Answer = { type: 'ready' | 'ack'; ok?: boolean; error?: string; result?: unknown } | null
let answerFor: (cmd: Cmd) => Answer = () => null

function installShell(): void {
	sent = []
	w.CashTreesIOS = {
		chatModuleCommand: (p: { command: Cmd }) => {
			const cmd = p.command
			sent.push(cmd)
			const a = cmd.type === 'hello' ? ({ type: 'ready', result: { protocolVersion: 1, capabilities: ['identity.native-keys.v1', 'history.v2'] } } as Answer) : answerFor(cmd)
			if (!a) return
			setTimeout(() => window.dispatchEvent(new CustomEvent('cashtreesios', { detail: { action: 'chatModuleEvent', event: { ...a, reqId: cmd.reqId } } })), 0)
		},
	}
}

function config() {
	return {
		identity: { eoaAddress: EOA, pgpPublicKeyArmored: '', ownRouteArmoredPublicKey: '' },
		conetRpcUrl: 'https://rpc.invalid',
		addressPgpContractAddress: '0x0000000000000000000000000000000000000001',
		getNodes: async () => [{ domain: 'synthetic.node', armoredPublicKey: 'synthetic' }] as never,
		ipfsBaseUrl: 'https://ipfs.invalid',
		apiBaseUrl: 'https://api.invalid',
		chatIndexRegistryAddress: '0x1511Caa71081C84d8a591490D1b83879088EED72',
	} as unknown as Parameters<typeof createNativeConetChatClient>[0]
}

/** advances until the condition holds (or the budget is spent); a load waits up to 90 s for the history key before it is sent. */
async function until(cond: () => boolean, budgetMs: number): Promise<void> {
	for (let done = 0; done < budgetMs && !cond(); done += 1000) await advance(1000)
}

const READY_WAIT_MS = 16_000 // longer than the iOS history-key wait (15 s)

afterEach(() => {
	jest.useRealTimers()
})

/** jest 27 has no advanceTimersByTimeAsync: advance in steps and let the promise chains run between them. */
async function advance(ms: number, step = 1000): Promise<void> {
	for (let done = 0; done < ms; done += step) {
		jest.advanceTimersByTime(step)
		for (let i = 0; i < 30; i++) await Promise.resolve()
	}
}

describe('identity-only init (a store account)', () => {
	it('the ready event of init is a success', async () => {
		installShell()
		answerFor = (cmd) => (cmd.type === 'init' ? { type: 'ready', result: {} } : null)
		await expect(initNativeIdentityOnly(config())).resolves.toEqual({ ok: true })
		expect(sent.filter((c) => c.type === 'init')).toHaveLength(1)
	})

	it('an init refused with an ack error is a failure with its code (unchanged)', async () => {
		installShell()
		answerFor = (cmd) => (cmd.type === 'init' ? { type: 'ack', ok: false, error: 'no_key' } : null)
		await expect(initNativeIdentityOnly(config())).resolves.toEqual({ ok: false, reason: 'no_key' })
	})

	it('no ready and no ack: the init window ends it as a failure, never a success', async () => {
		jest.useFakeTimers('modern')
		installShell()
		answerFor = () => null
		const p = initNativeIdentityOnly(config())
		await advance(181_000)
		const r = await p
		expect(r.ok).toBe(false)
	})
})

describe('history load answered with sync_failed', () => {
	async function native() {
		installShell()
		answerFor = (cmd) => (cmd.type === 'init' ? { type: 'ready', result: { historyApi: 2 } } : null)
		const client = createNativeConetChatClient(config())
		await client.init()
		// the module announces the history key (its own log), so these cases keep exercising the load itself (an unannounced key gets one repeat of the first load)
		window.dispatchEvent(new CustomEvent('cashtreesios', { detail: { action: 'chatModuleEvent', event: { type: 'event:log', level: 'info', message: '[history] ready genesis=abc' } } }))
		return client
	}

	it('is retried after 30 s, again on the next failure, and stops after a success; it is never an empty history', async () => {
		const client = await native()
		jest.useFakeTimers('modern')
		let loads = 0
		answerFor = (cmd) => {
			if (cmd.type !== 'historyLoad') return null
			loads += 1
			return loads < 3 ? { type: 'ack', ok: false, error: 'sync_failed' } : { type: 'ack', ok: true, result: {} }
		}
		const first = client.history.load()
		const firstFailed = expect(first).rejects.toThrow('sync_failed')
		await advance(READY_WAIT_MS)
		await firstFailed
		expect(loads).toBe(1)
		await until(() => loads >= 2, 300_000)
		expect(loads).toBe(2)
		await until(() => loads >= 3, 300_000)
		expect(loads).toBe(3)
		await advance(600_000)
		expect(loads).toBe(3)
	})

	it('is bounded: after the limit no further load is scheduled', async () => {
		const client = await native()
		jest.useFakeTimers('modern')
		let loads = 0
		answerFor = (cmd) => {
			if (cmd.type !== 'historyLoad') return null
			loads += 1
			return { type: 'ack', ok: false, error: 'sync_failed' }
		}
		const failed = expect(client.history.load()).rejects.toThrow('sync_failed')
		await advance(READY_WAIT_MS)
		await failed
		await until(() => loads >= 11, 4_000_000)
		await advance(600_000)
		expect(loads).toBe(11)
	})

	it('reverse: another load failure is not retried by this rule', async () => {
		const client = await native()
		jest.useFakeTimers('modern')
		let loads = 0
		answerFor = (cmd) => {
			if (cmd.type !== 'historyLoad') return null
			loads += 1
			return { type: 'ack', ok: false, error: 'bad_request' }
		}
		const failed = expect(client.history.load()).rejects.toThrow('bad_request')
		await advance(READY_WAIT_MS)
		await failed
		await advance(600_000)
		expect(loads).toBe(1)
	})
})
