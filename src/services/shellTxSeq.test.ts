/**
 * The shared, persistent transaction sequence (shellTxSeq). SYNTHETIC values only; the storage is an in-memory stand-in.
 */
import { createShellTxSeq, SHELL_TX_SEQ_STORAGE_KEY, type SeqStorage } from './shellTxSeq'
import { createShellMnemonicSync, SHELL_MNEMONIC_SYNC_COMMAND } from './shellMnemonicSync'

/** An in-memory stand-in for localStorage that survives a "restart" (a new sequence over the same storage). */
function memoryStorage(initial: Record<string, string> = {}): SeqStorage & { data: Record<string, string> } {
	const data: Record<string, string> = { ...initial }
	return {
		data,
		getItem: (k: string) => (k in data ? data[k] : null),
		setItem: (k: string, v: string) => {
			data[k] = v
		},
	}
}

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const EOA = '0x9858effd232b4033e47d90003d41ec34ecaeda94'
const noWait = async () => undefined

describe('shared transaction sequence (pwaWalletSync and pwaEmptySignal)', () => {
	it('issues strictly increasing numbers within one run, even when the clock does not move', () => {
		const next = createShellTxSeq(memoryStorage(), () => 1_000)
		const a = next()
		const b = next()
		const c = next()
		expect(a).toBeLessThan(b)
		expect(b).toBeLessThan(c)
	})

	it('a restart issues a number above every number issued before it (stored counter)', () => {
		const storage = memoryStorage()
		const before = createShellTxSeq(storage, () => 1_000)
		let last = 0
		for (let i = 0; i < 5; i += 1) last = before()
		// restart: a new sequence over the same storage, with a clock that went back
		const after = createShellTxSeq(storage, () => 10)
		expect(after()).toBeGreaterThan(last)
	})

	it('a restart issues a number above the earlier ones even when the stored value is lost (clock floor)', () => {
		const before = createShellTxSeq(memoryStorage(), () => 5_000)
		const last = before()
		const afterLoss = createShellTxSeq(memoryStorage(), () => 6_000)
		expect(afterLoss()).toBeGreaterThan(last)
	})

	it('storage that cannot be read or written still gives increasing numbers', () => {
		const broken: SeqStorage = {
			getItem: () => {
				throw new Error('no storage')
			},
			setItem: () => {
				throw new Error('no storage')
			},
		}
		const next = createShellTxSeq(broken, () => 100)
		expect(next()).toBeLessThan(next())
	})

	it('the stored value is the one persisted under the versioned key', () => {
		const storage = memoryStorage()
		const next = createShellTxSeq(storage, () => 42)
		const n = next()
		expect(storage.data[SHELL_TX_SEQ_STORAGE_KEY]).toBe(String(n))
	})
})

describe('pwaWalletSync takes its number from the sequence; a retry keeps it', () => {
	it('a restart of the page sends a number above the one sent before the restart', async () => {
		const storage = memoryStorage()
		const sent: number[] = []
		const first = createShellMnemonicSync({
			send: async (command, txId) => {
				expect(command).toBe(SHELL_MNEMONIC_SYNC_COMMAND)
				sent.push(txId)
				return 'ok' as const
			},
			retryDelaysMs: [1],
			wait: noWait,
			log: () => undefined,
			bridgeAvailable: () => true,
			nextSeq: createShellTxSeq(storage, () => 1_000),
		})
		await first.sync(PHRASE, EOA)
		await first.sync(PHRASE, EOA)
		const restarted = createShellMnemonicSync({
			send: async (_c, txId) => {
				sent.push(txId)
				return 'ok' as const
			},
			retryDelaysMs: [1],
			wait: noWait,
			log: () => undefined,
			bridgeAvailable: () => true,
			nextSeq: createShellTxSeq(storage, () => 10),
		})
		await restarted.sync(PHRASE, EOA)
		expect(sent[2]).toBeGreaterThan(sent[1])
		expect(sent[1]).toBeGreaterThan(sent[0])
	})

	it('a retry is sent with the same number as the first attempt', async () => {
		const txs: number[] = []
		const sync = createShellMnemonicSync({
			send: jest.fn(async (_c: string, txId: number) => {
				txs.push(txId)
				return txs.length === 3 ? ('ok' as const) : ('no_answer' as const)
			}),
			retryDelaysMs: [1, 1, 1],
			wait: noWait,
			log: () => undefined,
			bridgeAvailable: () => true,
			nextSeq: createShellTxSeq(memoryStorage(), () => 7_000),
		})
		const out = await sync.sync(PHRASE, EOA)
		expect(out.kind).toBe('synced')
		expect(txs.length).toBe(3)
		expect(new Set(txs).size).toBe(1)
	})
})
