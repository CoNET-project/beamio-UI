/**
 * @jest-environment node
 */
/**
 * r92 step 4 (draft 24.2 P1 to P9, 24.3 V-03..V-08, 22.4): the shell startup and write paths, on synthetic records only.
 * - the old PWA store (PouchDB "init") is read only: no put, no remove, and no shell write on any route;
 * - the S25 sequence: a shell record read not_ready then ok (the page copy holds only the EOA key), native no_key, store absent: onboarding;
 *   the same sequence with the native answer unknown: the startup wait (unavailable), never onboarding;
 * - the decision inputs are logged as status codes only.
 * The document `init` is removed only by the explicit passcode reset (wipeLocalWalletForRestore); no startup or write path removes it.
 */
import { ethers } from 'ethers'
import { NO_KEY_ERROR } from './nativeKeyState'

const KEY = '0x' + '11'.repeat(32)
const EOA = new ethers.Wallet(KEY).address.toLowerCase()
const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const LEGACY_ADDR = '0x9858effd232b4033e47d90003d41ec34ecaeda94'

const mockSt: {
	reads: Array<Record<string, unknown>>
	native: unknown
	legacyDoc: Record<string, unknown> | 'missing' | 'throw'
	logs: string[]
} = { reads: [], native: { kind: 'refused', code: NO_KEY_ERROR }, legacyDoc: 'missing', logs: [] }

const mockShellWrite = jest.fn(async () => undefined)
const mockDbPut = jest.fn(async () => ({ ok: true }))
const mockDbRemove = jest.fn(async () => ({ ok: true }))

jest.mock('./shellContext', () => ({ isShellContext: () => true }))
jest.mock('./shellRecordStore', () => {
	const actual = jest.requireActual('./shellRecordStore')
	return {
		...actual,
		shellRecordRead: async () => {
			const next = mockSt.reads.length > 1 ? mockSt.reads.shift() : mockSt.reads[0]
			return next as never
		},
		shellRecordWrite: (...args: unknown[]) => (mockShellWrite as (...a: unknown[]) => Promise<void>)(...args),
	}
})
jest.mock('./walletEoaAddress', () => ({
	readWalletEoaAddress: async () => mockSt.native,
}))
jest.mock('@/utils/cashTreesNativePwaLog', () => ({
	publishNativePwaLog: (_level: string, message: string) => {
		mockSt.logs.push(message)
	},
}))
jest.mock('pouchdb', () => ({
	__esModule: true,
	default: () => ({
		get: async (id: string) => {
			if (id !== 'init') throw Object.assign(new Error('missing'), { status: 404, name: 'not_found' })
			if (mockSt.legacyDoc === 'throw') throw Object.assign(new Error('io'), { status: 500, name: 'unknown_error' })
			if (mockSt.legacyDoc === 'missing') throw Object.assign(new Error('missing'), { status: 404, name: 'not_found' })
			return mockSt.legacyDoc
		},
		put: mockDbPut,
		remove: mockDbRemove,
	}),
}))
// argon2idAsync must not run in these tests (the PBKDF2 stand-in is removed). The bridge module cannot load in jest (import.meta),
// so it stays mocked, but a call fails closed. A test that needs the v3 KDF injects it with setMnemonicKdfForTest.
jest.mock('@/services/argon2WorkerBridge', () => ({
	argon2idAsync: () => {
		throw new Error('argon2idAsync must not run in this test: inject the v3 KDF with setMnemonicKdfForTest')
	},
}))
jest.mock('@/services/beamioTagWorkerBridge', () => ({ searchBeamioTagRemote: jest.fn() }))

// eslint-disable-next-line @typescript-eslint/no-var-requires
const beamio = require('./beamio') as typeof import('./beamio')

const ok = (record: Record<string, unknown>) => ({ status: 'ok', rev: 2, record, walletFieldsRedacted: false })
const notReady = { status: 'error', reason: 'not_ready' }
const keyOnly = () => ({ rev: 2, profiles: [{ keyID: EOA, privateKeyArmor: KEY, isPrimary: true }] })
const titleOf = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64')

beforeEach(() => {
	mockSt.reads = []
	mockSt.native = { kind: 'refused', code: NO_KEY_ERROR }
	mockSt.legacyDoc = 'missing'
	mockSt.logs = []
	mockShellWrite.mockClear()
	mockDbPut.mockClear()
	mockDbRemove.mockClear()
})

describe('S25 sequence (24.3): not_ready then the key-only copy, native no_key, store absent', () => {
	it('confirmed by both sides: onboarding route (empty)', async () => {
		mockSt.reads = [notReady, ok(keyOnly())]
		const r = await beamio.checkStorageWithStatus({ probe: true })
		expect(r.status).toBe('empty')
	})

	it('the same sequence with the native walletStatus unknown: a wait (unavailable), never onboarding', async () => {
		mockSt.reads = [notReady, ok(keyOnly())]
		mockSt.native = { kind: 'refused', code: 'not_ready' }
		const r = await beamio.checkStorageWithStatus({ probe: true })
		expect(r.status).toBe('unavailable')
	})

	it('the decision inputs are logged as status codes; no key or address value is in the log', async () => {
		mockSt.reads = [notReady, ok(keyOnly())]
		await beamio.checkStorageWithStatus({ probe: true })
		const line = mockSt.logs.find((l) => l.startsWith('[startup] decision inputs'))
		expect(line).toBeTruthy()
		expect(line).toContain('native_empty=')
		expect(line?.includes(KEY.slice(2))).toBe(false)
		expect(line?.toLowerCase().includes(EOA.slice(2))).toBe(false)
	})
})

describe('old PWA store first (24.1, 24.2 P1 P2 P6, 24.3 V-03 V-05 V-07)', () => {
	it('a valid old record enters its account; the store is only read: no put, no remove, no shell write', async () => {
		mockSt.reads = [{ status: 'absent' }] // the native answer comes first; confirmed absent here
		mockSt.legacyDoc = { title: titleOf({ mnemonicPhrase: PHRASE, profiles: [{ keyID: LEGACY_ADDR }] }) }
		const r = await beamio.checkStorageWithStatus({ probe: true })
		expect(r.status).toBe('loaded')
		expect(mockDbPut).not.toHaveBeenCalled()
		expect(mockDbRemove).not.toHaveBeenCalled()
		expect(mockShellWrite).not.toHaveBeenCalled()
	})

	it('rule C (PWA-local): a legacy mnemonic that does not derive to the account is no valid mnemonic here; the native side decides; nothing written', async () => {
		// the legacy mnemonic derives to LEGACY_ADDR, not to this key-only copy's keyID: the PWA-local record has no account credential.
		mockSt.legacyDoc = { title: titleOf({ mnemonicPhrase: PHRASE, profiles: [{ keyID: EOA }] }) }
		mockSt.reads = [ok(keyOnly())]
		mockSt.native = { kind: 'refused', code: NO_KEY_ERROR }
		const r = await beamio.checkStorageWithStatus({ probe: true })
		// a key-only copy with the native no_key is onboarding (the data is kept); the mismatch itself is never a hold
		expect(r.status).toBe('empty')
		expect(mockDbPut).not.toHaveBeenCalled()
		expect(mockDbRemove).not.toHaveBeenCalled()
		expect(mockShellWrite).not.toHaveBeenCalled()
	})

	it('rule C: the same mismatch with the native side unknown is still held (unavailable), never onboarding', async () => {
		mockSt.legacyDoc = { title: titleOf({ mnemonicPhrase: PHRASE, profiles: [{ keyID: EOA }] }) }
		mockSt.reads = [ok(keyOnly())]
		mockSt.native = { kind: 'refused', code: 'timeout' }
		const r = await beamio.checkStorageWithStatus({ probe: true })
		expect(r.status).toBe('unavailable')
		expect(mockShellWrite).not.toHaveBeenCalled()
	})

	it('a failed read of the old store is unknown (never empty), and nothing is written', async () => {
		mockSt.legacyDoc = 'throw'
		// the native side alone would confirm empty here (key-only copy, no_key): the unknown old store must still hold it
		mockSt.reads = [ok(keyOnly())]
		const r = await beamio.checkStorageWithStatus({ probe: true })
		expect(r.status).toBe('unavailable')
		expect(mockShellWrite).not.toHaveBeenCalled()
		expect(mockDbRemove).not.toHaveBeenCalled()
	})

	it('a retry after an interrupted start reads the same old record again with the same result (V-03, V-04)', async () => {
		mockSt.reads = [{ status: 'absent' }] // the native answer comes first; confirmed absent here
		mockSt.legacyDoc = { title: titleOf({ mnemonicPhrase: PHRASE, profiles: [{ keyID: LEGACY_ADDR }] }) }
		const first = await beamio.checkStorageWithStatus({ probe: true })
		const second = await beamio.checkStorageWithStatus({ probe: true })
		expect(first.status).toBe('loaded')
		expect(second.status).toBe('loaded')
		expect(mockDbPut).not.toHaveBeenCalled()
	})
})

describe('the init document is removed only by the explicit passcode reset (24.2 P6)', () => {
	it('every removeDocIfExists call is the helper definition or sits inside wipeLocalWalletForRestore', () => {
		const src = require('fs').readFileSync(require('path').join(__dirname, 'beamio.ts'), 'utf8') as string
		const defAt = src.indexOf('const removeDocIfExists = async')
		const wipeAt = src.indexOf('export const wipeLocalWalletForRestore')
		const wipeEnd = src.indexOf('\n}\n', wipeAt)
		const calls = [...src.matchAll(/removeDocIfExists\(/g)].map((m) => m.index as number)
		const outside = calls.filter((at) => !(at >= wipeAt && at < wipeEnd) && !(at >= defAt && at < defAt + 120))
		expect(calls.length).toBeGreaterThan(0)
		expect(outside).toEqual([])
	})
})
