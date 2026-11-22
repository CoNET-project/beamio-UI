/**
 * T-R2 (kind 2, profile sync), browser. The PGP identity sent is the chain's, unchanged when the chain has one (a non-empty chain value is
 * never overwritten). When the chain has none (an account created by createRecover), the account's own self-consistent PGP key is the first
 * registration; otherwise the save is refused and nothing is sent. An empty value is never sent. SYNTHETIC values only.
 */
// beamio.ts reads TextEncoder at module load (jsdom does not provide it): set the globals before the module is required.
const nodeUtil = require('util')
Object.assign(globalThis, { TextEncoder: nodeUtil.TextEncoder, TextDecoder: nodeUtil.TextDecoder })
// Worker bridges use import.meta, which jest cannot parse here: every export is an inert stub (no start calls a worker).
jest.mock('./argon2WorkerBridge', () => new Proxy({}, { get: () => () => undefined }))
jest.mock('./chatMediaWorkerBridge', () => new Proxy({}, { get: () => () => undefined }))
jest.mock('./chatWorkerBridge', () => new Proxy({}, { get: () => () => undefined }))
jest.mock('../workers/beamioTag/client', () => new Proxy({}, { get: () => () => undefined }))
jest.mock('../workers/appDaemon/client', () => new Proxy({}, { get: () => () => undefined }))
// openpgp does not load under jest here. The self-consistency check reads the keyID of a SYNTHETIC armor through this stub.
jest.mock('openpgp', () => ({ readKey: async ({ armoredKey }: { armoredKey: string }) => ({ getKeyIDs: () => [{ toHex: () => 'x' }, { toHex: () => armoredKey.replace(/^SYNTH-PGP:/, '') }] }) }))
const { postBeamio, chainIdentityRead, sendPendingProfileSync } = require('./beamio') as typeof import('./beamio')
const { markLocallyCreatedAccount } = require('./localAccountCreation') as typeof import('./localAccountCreation')
const { setCoNET_Data } = require('@/utils/globals') as typeof import('@/utils/globals')
const { ethers } = require('ethers')

const PK = `0x${'11'.repeat(32)}`
const EOA = new ethers.Wallet(PK).address
const CHAIN_ID = '0xchainpgpid'
const CHAIN_ARMOR = 'CHAIN-ARMOR-SYNTHETIC'
const LOCAL_ID = '0xlocalpgpid'
const LOCAL_ARMOR = 'LOCAL-ARMOR-SYNTHETIC'
const OWN_ID = '0xABCDEF0123456789'
const OWN_ARMOR = 'SYNTH-PGP:ABCDEF0123456789'

let bodies: Record<string, unknown>[] = []

/** The browser record of the signing account: its own PGP key (null: the record has none). */
const setOwnRecord = (own: { keyID: string; publicKey: string } | null) => {
	setCoNET_Data({ profiles: [{ keyID: EOA.toLowerCase(), privateKeyArmor: PK, ...(own ? { chatManager: { pgpKey: { keyID: own.keyID, publicKey: own.publicKey } } } : {}) }] } as never)
}

beforeEach(() => {
	bodies = []
	// the local creation record is per test: none unless a test writes it (2.1 (b))
	localStorage.clear()
	;(globalThis as { fetch?: unknown }).fetch = jest.fn(async (_url: unknown, init?: { body?: unknown }) => {
		bodies.push(JSON.parse(String(init?.body ?? '{}')))
		return { ok: true, status: 200, json: async () => ({}) }
	})
	chainIdentityRead.read = async () => ({ status: 'ok', info: { exists: true, pgpPublicKeyID: CHAIN_ID, pgpPublicKeyArmor: CHAIN_ARMOR } as never })
	setOwnRecord(null)
})

/** A profile record whose local copy of the PGP identity differs from the chain. */
const profileRecord = () => ({
	accountName: 'synthtag', image: '', darkTheme: false, isUSDCFaucet: false, isETHFaucet: false, firstName: '', lastName: '',
	language: 'en', currency: 'USD', tax: '0', localeCurrencyConfigured: true, initialLoading: false,
	pgpPublicKeyID: LOCAL_ID, pgpPublicKeyArmor: LOCAL_ARMOR,
}) as never

const chainEmpty = () => {
	chainIdentityRead.read = async () => ({ status: 'ok', info: { exists: true, pgpPublicKeyID: '', pgpPublicKeyArmor: '' } as never })
}

describe('T-R2 profile sync sends the chain PGP identity, unchanged', () => {
	it('the body carries exactly the chain value (not the local copy, not the own record), and no recover', async () => {
		setOwnRecord({ keyID: OWN_ID, publicKey: OWN_ARMOR })
		const ok = await postBeamio(profileRecord(), PK)
		expect(ok).toBe(true)
		expect(bodies).toHaveLength(1)
		expect(bodies[0].pgpKeyID).toBe(CHAIN_ID)
		expect(bodies[0].pgpKey).toBe(CHAIN_ARMOR)
		expect('recover' in bodies[0]).toBe(false)
	})

	it('a non-empty chain value is never overwritten by a different own key', async () => {
		setOwnRecord({ keyID: OWN_ID, publicKey: OWN_ARMOR })
		await postBeamio(profileRecord(), PK)
		expect(bodies[0].pgpKeyID).not.toBe(OWN_ID)
		expect(bodies[0].pgpKey).not.toBe(OWN_ARMOR)
	})
})

describe('T-R2 first registration: the chain has no PGP identity', () => {
	it('positive: the account was created on this device (local record) and the user saved: the self-consistent own key is sent, exactly once', async () => {
		chainEmpty()
		setOwnRecord({ keyID: OWN_ID, publicKey: OWN_ARMOR })
		markLocallyCreatedAccount(EOA)
		const ok = await postBeamio(profileRecord(), PK)
		expect(ok).toBe(true)
		expect(bodies).toHaveLength(1)
		expect(bodies[0].pgpKeyID).toBe(OWN_ID)
		expect(bodies[0].pgpKey).toBe(OWN_ARMOR)
	})

	it('negative (2.1 (a)): a queued re-send is not a user save: the first registration is refused even on a locally created account, nothing sent', async () => {
		chainEmpty()
		setCoNET_Data({ profiles: [{ keyID: EOA.toLowerCase(), privateKeyArmor: PK, chatManager: { pgpKey: { keyID: OWN_ID, publicKey: OWN_ARMOR } } }], beamio: profileRecord() } as never)
		markLocallyCreatedAccount(EOA)
		expect(await sendPendingProfileSync(EOA.toLowerCase())).toBe('failed')
		expect(bodies).toEqual([])
	})

	it('negative (2.1 (c)): a restored account (no local creation record) with an empty chain is never first-registered, even with a self-consistent own key: refused, nothing sent', async () => {
		chainEmpty()
		setOwnRecord({ keyID: OWN_ID, publicKey: OWN_ARMOR })
		expect(await postBeamio(profileRecord(), PK)).toBe(false)
		expect(bodies).toEqual([])
	})

	it('negative: the chain is empty and the own key is not self-consistent (keyID does not match the armor): refused, nothing sent', async () => {
		chainEmpty()
		setOwnRecord({ keyID: '0x1111111111111111', publicKey: OWN_ARMOR })
		expect(await postBeamio(profileRecord(), PK)).toBe(false)
		expect(bodies).toEqual([])
	})

	it('negative: the chain is empty and the browser record has no own key: refused, nothing sent', async () => {
		chainEmpty()
		setOwnRecord(null)
		expect(await postBeamio(profileRecord(), PK)).toBe(false)
		expect(bodies).toEqual([])
	})

	it('negative: a partial chain value (armor empty, keyID set) is refused, nothing sent', async () => {
		chainIdentityRead.read = async () => ({ status: 'ok', info: { exists: true, pgpPublicKeyID: CHAIN_ID, pgpPublicKeyArmor: '' } as never })
		setOwnRecord({ keyID: OWN_ID, publicKey: OWN_ARMOR })
		expect(await postBeamio(profileRecord(), PK)).toBe(false)
		expect(bodies).toEqual([])
	})

	it('an empty chain value with no own key refuses the save: nothing is sent', async () => {
		chainEmpty()
		expect(await postBeamio(profileRecord(), PK)).toBe(false)
		expect(bodies).toEqual([])
	})
})

describe('T-R2 an unreadable chain refuses the save', () => {
	it('an unreadable chain refuses the save: nothing is sent', async () => {
		chainIdentityRead.read = async () => { throw new Error('rpc down') }
		setOwnRecord({ keyID: OWN_ID, publicKey: OWN_ARMOR })
		expect(await postBeamio(profileRecord(), PK)).toBe(false)
		expect(bodies).toEqual([])
	})
})

export {}
