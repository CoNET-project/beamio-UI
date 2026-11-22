/**
 * @jest-environment node
 */
/**
 *the four start-up cases with the page-to-shell sync (pwaWalletSync) state. The start enters the PWA on the legacy account (PWA first,
 * as ruled); the sync reply codes drive the home's state (synced, or failed and retryable); nothing is cleared. SYNTHETIC wallets only.
 * The bridge is a fake: the native reply set is the closed codes of the spec. The restart is an in-memory restart of the page state.
 */
import { ethers } from 'ethers'
import { encodeInitRaw } from './initRecordCodec'

jest.mock('@/utils/cashTreesNativePwaLog', () => ({ publishNativePwaLog: jest.fn() }))
jest.mock('./shellContext', () => ({ isShellContext: () => true }))
jest.mock('@/services/argon2WorkerBridge', () => ({ argon2idAsync: jest.fn() }))
jest.mock('@/services/beamioTagWorkerBridge', () => ({ searchBeamioTagRemote: jest.fn() }))

// The legacy `init` document. A removal or a write would call a method this fake does not have, so it would fail the test.
let mockLegacyTitle: string | null = null
// Every write method records its call here; the R-PWA- cases require none.
let mockDbWrites: string[] = []
jest.mock('pouchdb', () => {
	const writer = (name: string) => async () => {
		mockDbWrites.push(name)
		throw new Error(`unexpected ${name}`)
	}
	return {
		default: () => ({
			get: async () => {
				if (mockLegacyTitle === null) throw Object.assign(new Error('missing'), { status: 404, name: 'not_found' })
				return { title: mockLegacyTitle }
			},
			put: writer('put'),
			remove: writer('remove'),
			bulkDocs: writer('bulkDocs'),
			post: writer('post'),
		}),
	}
})

jest.mock('./shellRecordStore', () => {
	const actual = jest.requireActual('./shellRecordStore')
	return {
		...actual,
		shellRecordRead: jest.fn(),
		shellRecordWrite: jest.fn(async () => ({ status: 'ok', rev: 1 })),
		prepareShellFreshWrite: jest.fn(async () => ({ isolated: false })),
	}
})
jest.mock('./walletEoaAddress', () => ({ readWalletEoaAddress: jest.fn() }))

import * as shellRecordStore from './shellRecordStore'
import * as walletEoaAddress from './walletEoaAddress'
import * as beamio from './beamio'
import { createShellMnemonicSync, SHELL_MNEMONIC_SYNC_COMMAND, type ShellSyncAnswer } from './shellMnemonicSync'
import { getShellSyncState, resetShellSyncStatus, retryShellSync, setShellSyncRetry } from './shellSyncStatus'

const srs = shellRecordStore as unknown as { shellRecordRead: jest.Mock; shellRecordWrite: jest.Mock; prepareShellFreshWrite: jest.Mock }
const wea = walletEoaAddress as unknown as { readWalletEoaAddress: jest.Mock }
const bx = beamio as unknown as { checkStorageWithStatus: () => Promise<{ status: string; reason?: string }> }

const W1 = ethers.Wallet.createRandom() // the legacy (PWA) account
const W2 = ethers.Wallet.createRandom() // the native account, a different valid address

const legacyTitleFor = (w: ethers.HDNodeWallet | ethers.Wallet) =>
	encodeInitRaw({ mnemonicPhrase: (w as ethers.HDNodeWallet).mnemonic?.phrase, profiles: [{ keyID: w.address.toLowerCase() }], beamio: {} })

const nativeOk = (w: ethers.HDNodeWallet | ethers.Wallet) => ({
	status: 'ok' as const,
	rev: 3,
	walletFieldsRedacted: false,
	copyValidated: true,
	eoa: w.address.toLowerCase(),
	record: { mnemonicPhrase: (w as ethers.HDNodeWallet).mnemonic?.phrase, profiles: [{ keyID: w.address.toLowerCase() }], beamio: {} },
})

type Native = 'absent' | 'unknown' | { ok: ethers.HDNodeWallet | ethers.Wallet }
function setNative(n: Native) {
	if (n === 'absent') {
		srs.shellRecordRead.mockResolvedValue({ status: 'absent' })
		wea.readWalletEoaAddress.mockResolvedValue({ kind: 'refused', code: 'no_key' })
	} else if (n === 'unknown') {
		srs.shellRecordRead.mockResolvedValue({ status: 'error', reason: 'timeout' })
		wea.readWalletEoaAddress.mockResolvedValue({ kind: 'refused', code: 'error' })
	} else {
		srs.shellRecordRead.mockResolvedValue(nativeOk(n.ok))
		wea.readWalletEoaAddress.mockResolvedValue({ kind: 'address', eoa: n.ok.address.toLowerCase() })
	}
}

const noWait = async () => undefined
/** The sync as the gate runs it: fast retries, a fake bridge that answers from a queue (the last answer repeats). */
function syncWith(answers: ShellSyncAnswer[]) {
	const queue = [...answers]
	const send = jest.fn(async (): Promise<ShellSyncAnswer> => (queue.length > 1 ? (queue.shift() as ShellSyncAnswer) : queue[0]))
	const sync = createShellMnemonicSync({
		send,
		retryDelaysMs: [1, 1],
		wait: noWait,
		log: () => undefined,
		bridgeAvailable: () => true,
	})
	return { sync, send }
}

beforeEach(() => {
	jest.clearAllMocks()
	mockLegacyTitle = null
	mockDbWrites = []
	resetShellSyncStatus()
})

/** The gate's entry: the start read (PWA first), then the sync of the page's mnemonic. Returns what the home shows. */
async function enterAndSync(legacy: ethers.HDNodeWallet | ethers.Wallet | null, native: Native, answers: ShellSyncAnswer[]) {
	mockLegacyTitle = legacy ? legacyTitleFor(legacy) : null
	setNative(native)
	const start = await bx.checkStorageWithStatus()
	const writes = srs.shellRecordWrite.mock.calls.length + srs.prepareShellFreshWrite.mock.calls.length
	const phrase = legacy ? (legacy as ethers.HDNodeWallet).mnemonic?.phrase ?? '' : ''
	const eoa = legacy ? legacy.address.toLowerCase() : ''
	const { sync, send } = syncWith(answers)
	const outcome = start.status === 'loaded' ? await sync.sync(phrase, eoa) : null
	return { start, outcome, state: getShellSyncState(), sends: send.mock.calls.length, writes }
}

describe('four start-up cases with the sync state (PWA first, nothing cleared)', () => {
	it('case 1 same address: enters the PWA; sync ok; a second sync of the same account is idempotent (synced, nothing cleared)', async () => {
		const r = await enterAndSync(W1, { ok: W1 }, ['ok'])
		expect(r.start.status).toBe('loaded')
		expect(r.outcome).toEqual({ kind: 'synced', tx: 1 })
		expect(r.state).toEqual({ kind: 'synced' })
		expect(r.writes).toBe(0)
		// same account again: the same payload is sent with a new transaction number; the state stays synced
		const { sync } = syncWith(['ok'])
		expect(await sync.sync(W1.mnemonic?.phrase ?? '', W1.address.toLowerCase())).toEqual({ kind: 'synced', tx: 1 })
		expect(getShellSyncState()).toEqual({ kind: 'synced' })
	})

	it('case 2 native explicit absent: enters the PWA on the legacy account; sync ok; the native absent answer is not a reason to hold', async () => {
		const r = await enterAndSync(W1, 'absent', ['ok'])
		expect(r.start.status).toBe('loaded')
		expect(r.outcome).toEqual({ kind: 'synced', tx: 1 })
		expect(r.state).toEqual({ kind: 'synced' })
		expect(r.writes).toBe(0)
	})

	it('case 3 native read unknown: a hold, never the PWA home; the old store is not entered; nothing is written or sent', async () => {
		mockLegacyTitle = legacyTitleFor(W1)
		setNative('unknown')
		const start = await bx.checkStorageWithStatus()
		expect(start.status).toBe('unavailable')
		expect(srs.shellRecordWrite).not.toHaveBeenCalled()
		expect(mockDbWrites).toEqual([])
	})

	it('case 3b native read unknown with no legacy document: held (unavailable, retryable), no sync and nothing written', async () => {
		mockLegacyTitle = null
		setNative('unknown')
		const start = await bx.checkStorageWithStatus()
		expect(start.status).toBe('unavailable')
		expect(srs.shellRecordWrite).not.toHaveBeenCalled()
		expect(getShellSyncState()).toEqual({ kind: 'idle' })
	})

	it('case 4 different valid address: enters the PWA on the legacy account; sync write_failed is retryable and shown; the legacy data is kept; retry succeeds', async () => {
		const r = await enterAndSync(W1, { ok: W2 }, ['write_failed', 'write_failed', 'write_failed'])
		expect(r.start.status).toBe('loaded')
		expect(r.outcome).toEqual({ kind: 'failed', tx: 1, code: 'write_failed', retryable: true })
		expect(r.state).toEqual({ kind: 'failed', code: 'write_failed', retryable: true })
		expect(r.writes).toBe(0)
		// the legacy document is still there (nothing was removed; the fake would throw on a remove)
		expect(mockLegacyTitle).not.toBeNull()
		const { sync } = syncWith(['ok'])
		expect(await sync.sync(W1.mnemonic?.phrase ?? '', W1.address.toLowerCase())).toEqual({ kind: 'synced', tx: 1 })
		expect(getShellSyncState()).toEqual({ kind: 'synced' })
	})

	it('case 4 restart: the in-memory page state is reset, the legacy data is still there; the start enters the same PWA account and the sync runs again', async () => {
		// the first session failed to sync
		await enterAndSync(W1, { ok: W2 }, ['write_failed', 'write_failed', 'write_failed'])
		expect(getShellSyncState().kind).toBe('failed')
		// in-memory restart: the state and the sync instance are new; the persisted legacy document is unchanged
		resetShellSyncStatus()
		const again = await enterAndSync(W1, { ok: W2 }, ['ok'])
		expect(again.start.status).toBe('loaded')
		expect(again.outcome).toEqual({ kind: 'synced', tx: 1 })
		expect(again.state).toEqual({ kind: 'synced' })
		expect(again.writes).toBe(0)
	})

	it('the sync command is the placeholder pwaWalletSync name (no other command is sent)', async () => {
		const { sync, send } = syncWith(['ok'])
		await sync.sync(W1.mnemonic?.phrase ?? '', W1.address.toLowerCase())
		expect((send.mock.calls[0] as unknown[])[0]).toBe(SHELL_MNEMONIC_SYNC_COMMAND)
	})
})

/**
 * R-PWA- (independent pre-read): explicit assertions for the four cases. The sync is the page's pwaWalletSync (one transaction per
 * sync, the send count is the bridge call count). A failure is retryable and shown on the home; the old data is kept; a retry does not stack.
 */
describe('R-PWA-: explicit assertions for the sync outcome, the home state and the kept data', () => {
	const phraseOf = (w: ethers.HDNodeWallet | ethers.Wallet) => (w as ethers.HDNodeWallet).mnemonic?.phrase ?? ''

	it('case A (SDK seal/readback failure): the start enters the PWA home on the legacy account; the sync fails with write_failed (retryable); the old data is kept and nothing is written', async () => {
		mockLegacyTitle = legacyTitleFor(W1)
		const titleBefore = mockLegacyTitle
		setNative({ ok: W2 })
		const start = await bx.checkStorageWithStatus()
		expect(start.status).toBe('loaded')
		const { sync, send } = syncWith(['write_failed'])
		const out = await sync.sync(phraseOf(W1), W1.address.toLowerCase())
		expect(out).toEqual({ kind: 'failed', tx: 1, code: 'write_failed', retryable: true })
		expect(getShellSyncState()).toEqual({ kind: 'failed', code: 'write_failed', retryable: true })
		expect(send.mock.calls.length).toBe(1) // a failed write is not retried by itself (E5.1)
		expect(mockLegacyTitle).toBe(titleBefore) // the old data is kept
		expect(mockDbWrites).toEqual([])
		expect(srs.shellRecordWrite).not.toHaveBeenCalled()
		expect(srs.prepareShellFreshWrite).not.toHaveBeenCalled()
	})

	it('case B: a hold; nothing is deleted or rewritten in the old store; nothing is written', async () => {
		mockLegacyTitle = legacyTitleFor(W1)
		const titleBefore = mockLegacyTitle
		setNative('unknown')
		const start = await bx.checkStorageWithStatus()
		expect(start.status).toBe('unavailable')
		expect(mockLegacyTitle).toBe(titleBefore)
		expect(mockDbWrites).toEqual([])
		expect(srs.shellRecordWrite).not.toHaveBeenCalled()
	})

	it('case C (different valid address): the sync is sent once on the normal path (one bridge call); a retry after failure runs one new sync; a retry while one runs does not stack', async () => {
		mockLegacyTitle = legacyTitleFor(W1)
		setNative({ ok: W2 })
		const start = await bx.checkStorageWithStatus()
		expect(start.status).toBe('loaded')
		// the normal path: exactly one call
		const ok = syncWith(['ok'])
		await ok.sync.sync(phraseOf(W1), W1.address.toLowerCase())
		expect(ok.send.mock.calls.length).toBe(1)
		expect(getShellSyncState()).toEqual({ kind: 'synced' })

		// a failed sync, then the registered retry: one new run, not a stack of runs
		resetShellSyncStatus()
		let runs = 0
		const failing = syncWith(['write_failed'])
		setShellSyncRetry(() => {
			runs += 1
			void failing.sync.sync(phraseOf(W1), W1.address.toLowerCase())
		})
		await failing.sync.sync(phraseOf(W1), W1.address.toLowerCase())
		const afterFailure = failing.send.mock.calls.length
		expect(getShellSyncState().kind).toBe('failed')
		expect(retryShellSync()).toBe(true)
		expect(runs).toBe(1)
		// the retry is queued behind the same fake; drain it
		await new Promise((r) => setTimeout(r, 0))
		expect(failing.send.mock.calls.length).toBeGreaterThan(afterFailure)
	})

	it('case C (no stacking): while a sync is in flight, a retry is a no-op and sends nothing', async () => {
		let release: (a: ShellSyncAnswer) => void = () => undefined
		const send = jest.fn(() => new Promise<ShellSyncAnswer>((resolve) => { release = resolve }))
		const sync = createShellMnemonicSync({ send, retryDelaysMs: [0], wait: noWait, log: () => undefined, bridgeAvailable: () => true })
		let runs = 0
		setShellSyncRetry(() => {
			runs += 1
			void sync.sync(phraseOf(W1), W1.address.toLowerCase())
		})
		const first = sync.sync(phraseOf(W1), W1.address.toLowerCase())
		expect(getShellSyncState()).toEqual({ kind: 'syncing' })
		expect(retryShellSync()).toBe(false)
		expect(runs).toBe(0)
		expect(send.mock.calls.length).toBe(1)
		release('ok')
		expect(await first).toEqual({ kind: 'synced', tx: 1 })
	})

	it('case D (native absent with a valid legacy account): the native answer is read first (absent), then the PWA is entered; the sync is sent once', async () => {
		mockLegacyTitle = legacyTitleFor(W1)
		setNative('absent')
		const start = await bx.checkStorageWithStatus()
		expect(start.status).toBe('loaded')
		expect(srs.shellRecordRead).toHaveBeenCalled()
		const { sync, send } = syncWith(['ok'])
		expect(await sync.sync(phraseOf(W1), W1.address.toLowerCase())).toEqual({ kind: 'synced', tx: 1 })
		expect(send.mock.calls.length).toBe(1)
	})
})
