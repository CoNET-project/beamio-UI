/**
 * @jest-environment node
 */
/**
 * R94: a shell record that carries only the EOA private-key copy (no mnemonic), with the native side answering
 * no_key on both sides confirmed, is no account: the storage read is empty (onboarding route). A read failure, another native answer, a
 * record with a mnemonic keeps the unavailable state. A completed Beamio account with no mnemonic follows the same rule (decision 2026-11-17):
 * the shell's explicit no_key is onboarding (kept); the shell's unknown is unavailable, retryable. Read-only. SYNTHETIC keys and records only.
 */
import { ethers } from 'ethers'
import { NO_KEY_ERROR } from './nativeKeyState'

const KEY = '0x' + '11'.repeat(32)
const EOA = new ethers.Wallet(KEY).address
const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

/** The shell's record: the sanitized copy, with the EOA private-key copy, and the options each case sets. */
const mockState: { record: Record<string, unknown>; native: unknown; readThrows: boolean } = {
	record: {},
	native: { kind: 'refused', code: NO_KEY_ERROR },
	readThrows: false,
}

jest.mock('./shellContext', () => ({ isShellContext: () => true }))
jest.mock('./shellRecordStore', () => {
	const actual = jest.requireActual('./shellRecordStore')
	return {
		...actual,
		shellRecordRead: async () => ({ status: 'ok', rev: 1, record: mockState.record }),
	}
})
jest.mock('./walletEoaAddress', () => ({
	readWalletEoaAddress: async () => {
		if (mockState.readThrows) throw new Error('bridge down (simulated)')
		return mockState.native
	},
}))
jest.mock('pouchdb', () => ({ __esModule: true, default: () => ({ get: async () => ({}) }) }))
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

const keyCopy = (over: Record<string, unknown> = {}) => ({
	profiles: [{ keyID: EOA, privateKeyArmor: KEY, isPrimary: true, referrer: null, isNode: false, type: 'ethereum', webFilter: true, tokens: [], chats: [] }],
	...over,
})

beforeEach(() => {
	mockState.record = keyCopy()
	mockState.native = { kind: 'refused', code: NO_KEY_ERROR }
	mockState.readThrows = false
})

describe('a key-only shell copy with no mnemonic (R94)', () => {
	it('both sides confirm: the native side answers no_key and the copy has no mnemonic: the read is empty (onboarding route)', async () => {
		const r = await beamio.checkStorageWithStatus({ probe: true })
		expect(r.status).toBe('empty')
	})

	it('a native read failure (not no_key) keeps the unavailable state, never empty', async () => {
		mockState.native = { kind: 'refused', code: 'not_ready' }
		const r = await beamio.checkStorageWithStatus({ probe: true })
		expect(r.status).toBe('unavailable')
	})

	it('a native read that throws keeps the unavailable state, never empty', async () => {
		mockState.readThrows = true
		const r = await beamio.checkStorageWithStatus({ probe: true })
		expect(r.status).toBe('unavailable')
	})

	it('a copy with a mnemonic is never judged empty here: the native recovery route keeps it', async () => {
		mockState.record = keyCopy({ mnemonicPhrase: PHRASE })
		const r = await beamio.checkStorageWithStatus({ probe: true })
		expect(r.status).toBe('unavailable')
	})

	it('a copy with an unreadable mnemonic that does not derive to the account is not empty', async () => {
		mockState.record = keyCopy({ mnemonicPhrase: 'not a real phrase at all' })
		const r = await beamio.checkStorageWithStatus({ probe: true })
		expect(r.status).toBe('unavailable')
	})

	// Old expectation (before 2026-11-17): "a completed Beamio account without a mnemonic is never empty (recovery, not onboarding)".
	// New: split by the shell's answer.
	it('a completed Beamio account without a mnemonic, shell explicit no_key: empty (onboarding); the record is kept', async () => {
		const record = keyCopy({ beamio: { accountName: 'synthtag' } })
		mockState.record = record
		const r = await beamio.checkStorageWithStatus({ probe: true })
		expect(r.status).toBe('empty')
		expect(mockState.record).toBe(record)
	})

	it('a completed Beamio account without a mnemonic, shell unknown (not_ready or a thrown read): unavailable, retryable', async () => {
		mockState.record = keyCopy({ beamio: { accountName: 'synthtag' } })
		mockState.native = { kind: 'refused', code: 'not_ready' }
		expect((await beamio.checkStorageWithStatus({ probe: true })).status).toBe('unavailable')
		mockState.native = { kind: 'refused', code: NO_KEY_ERROR }
		mockState.readThrows = true
		expect((await beamio.checkStorageWithStatus({ probe: true })).status).toBe('unavailable')
	})
})

describe('R95: a no_key shell with no mnemonic and no privateKeyArmor (Android SDK after the fix)', () => {
	const noKeyRecord = () => ({ profiles: [{ keyID: EOA, isPrimary: true, referrer: null, isNode: false, type: 'ethereum', webFilter: true, tokens: [], chats: [] }] })

	it('(b) the native side answers no_key, the record has no mnemonic and no privateKeyArmor: the read is empty (onboarding route)', async () => {
		mockState.record = noKeyRecord()
		const r = await beamio.checkStorageWithStatus({ probe: true })
		expect(r.status).toBe('empty')
	})

	it('(b) a read failure, a timeout or not_ready with the same record stays unavailable (unknown, never empty)', async () => {
		mockState.record = noKeyRecord()
		mockState.native = { kind: 'refused', code: 'not_ready' }
		expect((await beamio.checkStorageWithStatus({ probe: true })).status).toBe('unavailable')
		mockState.native = { kind: 'refused', code: 'timeout' }
		expect((await beamio.checkStorageWithStatus({ probe: true })).status).toBe('unavailable')
		mockState.readThrows = true
		expect((await beamio.checkStorageWithStatus({ probe: true })).status).toBe('unavailable')
	})

	// Old expectation (before 2026-11-17): "a record without a mnemonic that is a completed account stays unavailable (recovery, not onboarding)".
	it('(b) a completed account without a mnemonic, shell explicit no_key: empty (onboarding)', async () => {
		mockState.record = { ...noKeyRecord(), beamio: { accountName: 'synthtag' } }
		expect((await beamio.checkStorageWithStatus({ probe: true })).status).toBe('empty')
	})
})
