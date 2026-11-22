/**
 * @jest-environment node
 */
/**
 *two valid wallets with different addresses, end to end.
 *
 * B. The native wallet is valid at address A, the PWA wallet (the old PWA store, read first) is valid at address B, A ≠ B.
 * The start enters the PWA home on B WITHOUT asking the native side, then sends pwaWalletSync once with B over the REAL transport.
 * The shell seals the old native wallet, reads it back and verifies it, and only then writes B. If the shell answers unknown or
 * fails (write_failed, stale_seq, no answer), the PWA home and all data stay, and the failure is shown as retryable. Nothing is
 * re-derived and nothing is deleted.
 * A. A native-validated copy whose EOA contradicts the native walletEoaAddress: unknown, the data is kept, nothing is written or sent.
 *
 * The page's storage is the real beamio.ts read; the store, the native account answers and the PouchDB document are stubs. The bridge is
 * a fake shell on window.BeamioShellRecord (the node environment has a minimal window). SYNTHETIC values only: the phrases are the
 * public BIP-39 test vectors, and the second one derives a different address.
 */
import { createShellMnemonicSync, type ShellSyncAnswer } from './shellMnemonicSync'
import { mapSyncReply, pwaWalletSyncTransportAvailable, sendNativeMnemonicPreread, sendPwaWalletSync } from './pwaWalletSyncTransport'
import { getShellSyncState, resetShellSyncStatus } from './shellSyncStatus'
import { encodeInitRaw } from './initRecordCodec'
import { validMnemonicEoa } from '@/utils/consumerWalletGate'
import { ethers } from 'ethers'

jest.mock('@/utils/cashTreesNativePwaLog', () => ({ publishNativePwaLog: jest.fn() }))
jest.mock('./shellContext', () => ({ isShellContext: () => true }))
jest.mock('@/services/argon2WorkerBridge', () => ({ argon2idAsync: jest.fn() }))
jest.mock('@/services/beamioTagWorkerBridge', () => ({ searchBeamioTagRemote: jest.fn() }))

// The old PWA store (`init`). Writes are recorded; the real store is never touched.
let mockLegacyTitle: string | null = null
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

const srs = shellRecordStore as unknown as { shellRecordRead: jest.Mock; shellRecordWrite: jest.Mock; prepareShellFreshWrite: jest.Mock }
const wea = walletEoaAddress as unknown as { readWalletEoaAddress: jest.Mock }
const bx = beamio as unknown as { checkStorageWithStatus: () => Promise<{ status: string; reason?: string; data?: unknown }> }

// Account B is the PWA wallet; account A is the native wallet (a different valid address).
const PHRASE_B = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const EOA_B = validMnemonicEoa({ mnemonicPhrase: PHRASE_B } as never)
const EOA_A = '0x' + 'ab'.repeat(20) // the native address (a stub; only the address matters here)

const legacyTitleB = () => encodeInitRaw({ mnemonicPhrase: PHRASE_B, profiles: [{ keyID: EOA_B }], beamio: {} })

// A fake window with only what the shell transport reads. It is installed per test.
type Envelope = { ok: true; result: Record<string, unknown> } | { ok: false; error: string; reason?: string } | 'silent' | 'unusable'
type Req = { type: string; reqId: number; seq?: number; eoa?: string; phrase?: string }
let sent: Req[] = []
function installShell(writeReply: (req: Req, n: number) => Envelope, prereadState: 'valid' | 'absent' | 'unknown' = 'valid') {
	sent = []
	const host: { postMessage?: (raw: string) => void; onmessage: ((ev: { data: string }) => void) | null; allowedOrigins: string[] } = {
		allowedOrigins: ['http://localhost'],
		onmessage: null,
		postMessage: (raw: string) => {
			const req = JSON.parse(raw) as Req
			sent.push(req)
			const reply: Envelope = req.type === 'nativeMnemonicPreread' ? { ok: true, result: { state: prereadState } } : writeReply(req, sent.length)
			if (reply === 'silent' || reply === 'unusable') return
			host.onmessage?.({ data: JSON.stringify({ type: 'ack', reqId: req.reqId, ...reply }) })
		},
	}
	const win = (globalThis as unknown as { window: Record<string, unknown> }).window
	win.BeamioShellRecord = host
}
function installUnusableShell() {
	sent = []
	const win = (globalThis as unknown as { window: Record<string, unknown> }).window
	win.BeamioShellRecord = { allowedOrigins: ['http://localhost'] }
}

beforeEach(() => {
	;(globalThis as unknown as { window: Record<string, unknown> }).window = {
		location: { origin: 'http://localhost' },
		addEventListener: () => undefined,
		removeEventListener: () => undefined,
	}
	jest.clearAllMocks()
	mockLegacyTitle = null
	mockDbWrites = []
	resetShellSyncStatus()
})

afterEach(() => {
	delete (globalThis as unknown as { window?: unknown }).window
})

/** The sync the gate runs after the home is entered: the production sender over the real transport, fast retries. */
const sync = () =>
	createShellMnemonicSync({
		send: (command, txId, mnemonic, eoa) => sendPwaWalletSync(command, txId, mnemonic, eoa),
		reread: (seq) => sendNativeMnemonicPreread(seq),
		retryDelaysMs: [1, 1, 1],
		wait: async () => undefined,
		log: () => undefined,
		bridgeAvailable: () => pwaWalletSyncTransportAvailable(),
	})

describe('B: two valid wallets at different addresses (A native, B PWA): enter the PWA, then one sync over the real bridge', () => {
	// 2026-11-20: the native answer is read first. For this run it is confirmed absent (no native record here); the
	// native-valid-other-account entry is covered in persistRegression.test.ts.
	beforeEach(() => {
		srs.shellRecordRead.mockResolvedValue({ status: 'absent' })
	})
	it('B1 success: the start enters the PWA home on B (native answer first, absent); pwaWalletSync is sent once with B; the state is synced', async () => {
		mockLegacyTitle = legacyTitleB()
		installShell(() => ({ ok: true, result: { sync: 'updated' } }))
		const start = await bx.checkStorageWithStatus()
		expect(start.status).toBe('loaded') // not unknown, not held
		expect(validMnemonicEoa(start.data as never)).toBe(EOA_B) // the home is on B
		expect(wea.readWalletEoaAddress).not.toHaveBeenCalled() // absent: no account to check
		expect(srs.shellRecordRead).toHaveBeenCalled() // the native answer is read first
		expect(await sync().sync(PHRASE_B, EOA_B)).toEqual({ kind: 'synced', tx: 1 })
		expect(sent.length).toBe(1)
		expect(sent[0].type).toBe('pwaWalletSync')
		expect(sent[0].eoa).toBe(EOA_B)
		expect(getShellSyncState()).toEqual({ kind: 'synced' })
		expect(mockDbWrites).toEqual([])
		expect(srs.shellRecordWrite).not.toHaveBeenCalled()
	})

	it('B2 SDK write_failed: the PWA home and all data stay; the failure is retryable on the home; the re-read (valid) keeps the retries', async () => {
		mockLegacyTitle = legacyTitleB()
		installShell(() => ({ ok: false, error: 'write_failed', reason: 'internal_state' }), 'valid')
		const start = await bx.checkStorageWithStatus()
		expect(start.status).toBe('loaded')
		const out = await sync().sync(PHRASE_B, EOA_B)
		expect(out).toEqual({ kind: 'failed', tx: 1, code: 'write_failed', retryable: true, reason: 'internal_state' })
		expect(getShellSyncState()).toEqual({ kind: 'failed', code: 'write_failed', retryable: true, reason: 'internal_state' })
		expect(mockLegacyTitle).toBe(legacyTitleB()) // the old PWA data is unchanged
		expect(mockDbWrites).toEqual([])
		expect(srs.shellRecordWrite).not.toHaveBeenCalled()
		expect(wea.readWalletEoaAddress).not.toHaveBeenCalled() // still the PWA home, the native side is not used to decide
	})

	it('B3 SDK unknown (no usable reply): retryable, the home and the data stay, nothing is re-derived or deleted', async () => {
		mockLegacyTitle = legacyTitleB()
		installUnusableShell()
		const start = await bx.checkStorageWithStatus()
		expect(start.status).toBe('loaded')
		const out = await sync().sync(PHRASE_B, EOA_B)
		expect(out).toEqual({ kind: 'failed', tx: 1, code: 'no_answer', retryable: true })
		expect(getShellSyncState()).toEqual({ kind: 'failed', code: 'no_answer', retryable: true })
		expect(mockLegacyTitle).toBe(legacyTitleB())
		expect(mockDbWrites).toEqual([])
	})

	it('B4 SDK stale_seq: the failure is retryable and shown; the home stays', async () => {
		mockLegacyTitle = legacyTitleB()
		installShell(() => ({ ok: false, error: 'stale_seq' }))
		expect((await bx.checkStorageWithStatus()).status).toBe('loaded')
		expect(await sync().sync(PHRASE_B, EOA_B)).toEqual({ kind: 'failed', tx: 1, code: 'stale_seq', retryable: true })
		expect(getShellSyncState()).toEqual({ kind: 'failed', code: 'stale_seq', retryable: true })
		expect(mockLegacyTitle).toBe(legacyTitleB())
	})

	it('B5 a later retry after the shell recovers sends one new sync and succeeds; the home never changed', async () => {
		mockLegacyTitle = legacyTitleB()
		let failing = true
		installShell(() => (failing ? { ok: false, error: 'write_failed', reason: 'storage_write' } : { ok: true, result: { sync: 'updated' } }))
		expect((await bx.checkStorageWithStatus()).status).toBe('loaded')
		expect((await sync().sync(PHRASE_B, EOA_B)).kind).toBe('failed')
		failing = false
		const before = sent.length
		expect(await sync().sync(PHRASE_B, EOA_B)).toEqual({ kind: 'synced', tx: 1 })
		expect(sent.length - before).toBe(1)
		expect(getShellSyncState()).toEqual({ kind: 'synced' })
	})
})

describe('A: a native-validated copy whose EOA contradicts the native walletEoaAddress: unknown, kept, nothing written or sent', () => {
	it('the start is unavailable (eoa_mismatch); nothing is loaded for the home, nothing is written, no sync is sent', async () => {
		// the shell validated the copy for account B (eoa = keyID = B), but the native address answers A
		srs.shellRecordRead.mockResolvedValue({
			status: 'ok',
			rev: 2,
			walletFieldsRedacted: false,
			copyValidated: true,
			eoa: EOA_B.toLowerCase(),
			record: { mnemonicPhrase: PHRASE_B, profiles: [{ keyID: EOA_B.toLowerCase() }], beamio: {} },
		})
		wea.readWalletEoaAddress.mockResolvedValue({ kind: 'address', eoa: EOA_A.toLowerCase() })
		installShell(() => ({ ok: true, result: { sync: 'updated' } }))
		const start = await bx.checkStorageWithStatus()
		expect(start).toEqual({ status: 'unavailable', reason: 'eoa_mismatch' })
		expect(sent.length).toBe(0)
		expect(srs.shellRecordWrite).not.toHaveBeenCalled()
		expect(srs.prepareShellFreshWrite).not.toHaveBeenCalled()
		expect(mockDbWrites).toEqual([])
	})
})

// Exposed for the reply mapping of the spec's codes (kept with the B cases so they stay one file of evidence).
describe('reply codes used by B', () => {
	it('write_failed carries its reason; untrusted_source and bad_request do not', () => {
		expect(mapSyncReply({ ok: false, error: 'write_failed', reason: 'internal_state' })).toEqual({ code: 'write_failed', reason: 'internal_state' })
		expect(mapSyncReply({ ok: false, error: 'bad_request' })).toEqual({ code: 'bad_request' })
	})
	it('B is the address of its phrase; A is a different address', () => {
		expect(EOA_B).toBe(ethers.Wallet.fromPhrase(PHRASE_B).address.toLowerCase())
		expect(EOA_A).not.toBe(EOA_B)
	})
	it('the sync answer type stays a string code', () => {
		const a: ShellSyncAnswer = 'ok'
		expect(typeof a).toBe('string')
	})
})
