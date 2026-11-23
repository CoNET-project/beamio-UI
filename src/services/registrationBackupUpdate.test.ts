/**
 * addUser with recover from RegenerateUser and RegenerateRecover. Kind (4), a backup update of a registered account (the user's explicit
 * regeneration of the recovery code), sends the chain's current PGP identity, unchanged. An empty, unreadable, or absent (no_account) chain
 * identity refuses it: a backup update never makes a first registration (review 2026-11-17). First registration runs only in the
 * save path (profileSyncChainPgp.test.ts). SYNTHETIC values only.
 */
// beamio.ts reads TextEncoder at module load (jsdom does not provide it): set the globals before the module is required.
const nodeUtil = require('util')
Object.assign(globalThis, { TextEncoder: nodeUtil.TextEncoder, TextDecoder: nodeUtil.TextDecoder })
// The password and AES steps use WebCrypto (jsdom has none): the Node webcrypto, for these tests only.
if (!(globalThis as { crypto?: { subtle?: unknown } }).crypto?.subtle) Object.defineProperty(globalThis, 'crypto', { value: require('crypto').webcrypto, configurable: true })
// Worker bridges use import.meta, which jest cannot parse here: every export is an inert stub (no start calls a worker).
// RegenerateRecover derives the recovery hash with argon2: a deterministic stand-in (the worker is not loadable under jest here).
jest.mock('./argon2WorkerBridge', () => ({ argon2idAsync: async (_p: Uint8Array, _s: Uint8Array, o: { dkLen: number }) => new Uint8Array(o.dkLen), warmArgon2Worker: () => undefined }))
jest.mock('./chatMediaWorkerBridge', () => new Proxy({}, { get: () => () => undefined }))
jest.mock('./chatWorkerBridge', () => new Proxy({}, { get: () => () => undefined }))
jest.mock('../workers/beamioTag/client', () => new Proxy({}, { get: () => () => undefined }))
jest.mock('../workers/appDaemon/client', () => new Proxy({}, { get: () => () => undefined }))
// openpgp does not load under jest here: the self-consistency check reads the keyID of a SYNTHETIC armor ("SYNTH-PGP:<keyID>") through this stub.
jest.mock('openpgp', () => ({ readKey: async ({ armoredKey }: { armoredKey: string }) => ({ getKeyIDs: () => [{ toHex: () => 'x' }, { toHex: () => armoredKey.replace(/^SYNTH-PGP:/, '') }] }) }))
const { RegenerateUser, RegenerateRecover, chainIdentityRead } = require('./beamio') as typeof import('./beamio')
const { markLocallyCreatedAccount } = require('./localAccountCreation') as typeof import('./localAccountCreation')
const { setCoNET_Data } = require('@/utils/globals') as typeof import('@/utils/globals')
const { ethers } = require('ethers')

const PK = `0x${'11'.repeat(32)}`
const RECOVER = [{ hash: '0x' + '22'.repeat(32), encrypto: 'synthetic' }]
const CHAIN_ID = '0xchainpgpid'
const CHAIN_ARMOR = 'CHAIN-ARMOR-SYNTHETIC'
const OWN_ID = '0xownpgpid'
const OWN_ARMOR = 'OWN-ARMOR-SYNTHETIC'

let bodies: Record<string, unknown>[] = []

beforeEach(() => {
	bodies = []
	localStorage.clear()
	;(globalThis as { fetch?: unknown }).fetch = jest.fn(async (_url: unknown, init?: { body?: unknown }) => {
		bodies.push(JSON.parse(String(init?.body ?? '{}')))
		return { ok: true, status: 200, json: async () => ({}) }
	})
})

const profile = (extra: Record<string, unknown> = {}) => ({
	accountName: 'synthtag', image: '', darkTheme: false, isUSDCFaucet: false, isETHFaucet: false, firstName: '', lastName: '',
	language: 'en', currency: 'USD', tax: '0', localeCurrencyConfigured: true, initialLoading: false,
	pgpPublicKeyID: OWN_ID, pgpPublicKeyArmor: OWN_ARMOR, ...extra,
}) as never

describe('kind (4) backup update of a registered account (RegenerateUser)', () => {
	it('sends the chain PGP identity unchanged, not the local copy', async () => {
		chainIdentityRead.read = async () => ({ status: 'ok', info: { exists: true, pgpPublicKeyID: CHAIN_ID, pgpPublicKeyArmor: CHAIN_ARMOR } as never })
		await RegenerateUser(profile(), RECOVER as never, PK)
		expect(bodies).toHaveLength(1)
		expect(bodies[0].pgpKeyID).toBe(CHAIN_ID)
		expect(bodies[0].pgpKey).toBe(CHAIN_ARMOR)
	})

	it('an empty chain value refuses the request: nothing is sent', async () => {
		chainIdentityRead.read = async () => ({ status: 'ok', info: { exists: true, pgpPublicKeyID: '', pgpPublicKeyArmor: '' } as never })
		expect(await RegenerateUser(profile(), RECOVER as never, PK)).toBe(false)
		expect(bodies).toEqual([])
	})

	it('an unreadable chain refuses the request: nothing is sent', async () => {
		chainIdentityRead.read = async () => { throw new Error('rpc down') }
		expect(await RegenerateUser(profile(), RECOVER as never, PK)).toBe(false)
		expect(bodies).toEqual([])
	})
})

describe('backup update with no chain identity (no_account): refused, nothing sent (review 2026-11-17)', () => {
	it('the chain has no identity for the EOA: the request is refused and no PGP identity (not even the page profile key) is sent', async () => {
		chainIdentityRead.read = async () => ({ status: 'no_account' })
		expect(await RegenerateUser(profile(), RECOVER as never, PK)).toBe(false)
		expect(bodies).toEqual([])
	})

	it('an empty page profile key does not change the refusal: nothing is sent', async () => {
		chainIdentityRead.read = async () => ({ status: 'no_account' })
		expect(await RegenerateUser(profile({ pgpPublicKeyID: '', pgpPublicKeyArmor: '' }), RECOVER as never, PK)).toBe(false)
		expect(bodies).toEqual([])
	})

	it('a locally created account still does not make the first registration in a backup update (3ff76d0; the save path does it, see profileSyncChainPgp.test.ts positive case)', async () => {
		markLocallyCreatedAccount(new ethers.Wallet(PK).address)
		chainIdentityRead.read = async () => ({ status: 'no_account' })
		expect(await RegenerateUser(profile(), RECOVER as never, PK)).toBe(false)
		expect(bodies).toEqual([])
	})
})

describe('kind (4) backup update through RegenerateRecover (the user regenerates the recovery code)', () => {
	it('sends the chain PGP identity unchanged, with recover, and returns the new recovery code', async () => {
		chainIdentityRead.read = async () => ({ status: 'ok', info: { exists: true, pgpPublicKeyID: CHAIN_ID, pgpPublicKeyArmor: CHAIN_ARMOR } as never })
		const out = await RegenerateRecover('synthetic words for the recovery test', profile() as never, '123456', PK)
		expect(out).not.toBeNull()
		expect(bodies).toHaveLength(1)
		expect(bodies[0].pgpKeyID).toBe(CHAIN_ID)
		expect(bodies[0].pgpKey).toBe(CHAIN_ARMOR)
		expect(Array.isArray(bodies[0].recover)).toBe(true)
	})

	it('an empty chain value refuses the regeneration: nothing is sent, no code is returned', async () => {
		chainIdentityRead.read = async () => ({ status: 'ok', info: { exists: true, pgpPublicKeyID: '', pgpPublicKeyArmor: '' } as never })
		expect(await RegenerateRecover('synthetic words for the recovery test', profile() as never, '123456', PK)).toBeNull()
		expect(bodies).toEqual([])
	})

	it('an unreadable chain refuses the regeneration: nothing is sent', async () => {
		chainIdentityRead.read = async () => { throw new Error('rpc down') }
		expect(await RegenerateRecover('synthetic words for the recovery test', profile() as never, '123456', PK)).toBeNull()
		expect(bodies).toEqual([])
	})
})

describe('kind (4) backup update: the first registration rule (the chain has no PGP identity)', () => {
	const SIGNER = new ethers.Wallet(PK).address
	const OWN_KEY_ID = '0xABCDEF0123456789'
	const OWN_KEY = 'SYNTH-PGP:ABCDEF0123456789'
	const setOwn = (keyID: string, publicKey: string) => setCoNET_Data({ profiles: [{ keyID: SIGNER.toLowerCase(), privateKeyArmor: PK, chatManager: { pgpKey: { keyID, publicKey } } }] } as never)

	it('negative (R78 2.1 (c)): a backup update never makes the first registration, even on a locally created account with a self-consistent own key: refused, nothing sent', async () => {
		chainIdentityRead.read = async () => ({ status: 'ok', info: { exists: true, pgpPublicKeyID: '', pgpPublicKeyArmor: '' } as never })
		setOwn(OWN_KEY_ID, OWN_KEY)
		markLocallyCreatedAccount(SIGNER)
		expect(await RegenerateUser(profile(), RECOVER as never, PK)).toBe(false)
		expect(bodies).toEqual([])
	})

	it('negative: the chain is empty and the own key does not match its armor: refused, nothing sent', async () => {
		chainIdentityRead.read = async () => ({ status: 'ok', info: { exists: true, pgpPublicKeyID: '', pgpPublicKeyArmor: '' } as never })
		setOwn('0x1111111111111111', OWN_KEY)
		expect(await RegenerateUser(profile(), RECOVER as never, PK)).toBe(false)
		expect(bodies).toEqual([])
	})

	it('a non-empty chain value is never overwritten by the own key', async () => {
		chainIdentityRead.read = async () => ({ status: 'ok', info: { exists: true, pgpPublicKeyID: CHAIN_ID, pgpPublicKeyArmor: CHAIN_ARMOR } as never })
		setOwn(OWN_KEY_ID, OWN_KEY)
		await RegenerateUser(profile(), RECOVER as never, PK)
		expect(bodies[0].pgpKeyID).toBe(CHAIN_ID)
		expect(bodies[0].pgpKey).toBe(CHAIN_ARMOR)
	})
})

export {}
