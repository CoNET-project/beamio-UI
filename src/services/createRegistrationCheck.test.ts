/**
 * T-R3: the create path sends the full addUser (with recover) only for an EOA the chain does not register. A registered EOA is
 * refused (negative control), and a lookup that cannot tell is refused too (fail closed). SYNTHETIC values only.
 */
// beamio.ts reads TextEncoder at module load (jsdom does not provide it): set the globals before the module is required.
const nodeUtil = require('util')
Object.assign(globalThis, { TextEncoder: nodeUtil.TextEncoder, TextDecoder: nodeUtil.TextDecoder })
// The password and AES steps use WebCrypto (jsdom has none): the Node webcrypto, for these tests only.
if (!(globalThis as { crypto?: { subtle?: unknown } }).crypto?.subtle) Object.defineProperty(globalThis, 'crypto', { value: require('crypto').webcrypto, configurable: true })
const { assertUnregisteredBeforeCreate, createDetachedRecoverAccount, createRecover, chainIdentityRead, LocalCreateError } = require('./beamio') as typeof import('./beamio')
/**
 * Worker bridges use import.meta, which jest cannot parse here: every export is an inert stub (the start never calls a worker).
 */
// The recovery hash uses argon2 (the worker is not loadable under jest here): a deterministic stand-in.
jest.mock('./argon2WorkerBridge', () => ({ argon2idAsync: async (_p: Uint8Array, _s: Uint8Array, o: { dkLen: number }) => new Uint8Array(o.dkLen), warmArgon2Worker: () => undefined }))
jest.mock('./chatMediaWorkerBridge', () => new Proxy({}, { get: () => () => undefined }))
jest.mock('./chatWorkerBridge', () => new Proxy({}, { get: () => () => undefined }))
jest.mock('../workers/beamioTag/client', () => new Proxy({}, { get: () => () => undefined }))
jest.mock('../workers/appDaemon/client', () => new Proxy({}, { get: () => () => undefined }))

const EOA = '0x1111111111111111111111111111111111111111'

describe('T-R3 create path requires an unregistered EOA', () => {
	it('an EOA the chain does not register passes', async () => {
		await expect(assertUnregisteredBeforeCreate(EOA, async () => ({ status: 'no_account' }))).resolves.toBeUndefined()
	})

	it('negative control: a registered EOA is refused, so no addUser is sent', async () => {
		await expect(assertUnregisteredBeforeCreate(EOA, async () => ({ status: 'ok', info: {} as never }))).rejects.toBeInstanceOf(LocalCreateError)
	})

	it('a lookup that cannot tell (network error) is refused (fail closed)', async () => {
		await expect(assertUnregisteredBeforeCreate(EOA, async () => ({ status: 'network_error', reason: 'timeout' }))).rejects.toBeInstanceOf(LocalCreateError)
	})
})

/** T-R3 integration: the create path (createDetachedRecoverAccount calls newUser after the registration check) sends no addUser for a registered EOA. */
describe('T-R3 integration: the create path sends addUser only for an unregistered EOA', () => {
	let posts: string[] = []
	beforeEach(() => {
		posts = []
		// A fixed synthetic account (a jest test key and the public test phrase), not random: ethers' node crypto returns Buffers, which jsdom cannot hexlify.
		// The unregistered path is not driven here: after newUser it waits for the chain record (up to 45 s); assertUnregisteredBeforeCreate covers it.
		const { ethers } = require('ethers')
		jest.spyOn(ethers.Wallet, 'createRandom').mockImplementation(() => Object.assign(new ethers.Wallet('0x' + '11'.repeat(32)), { mnemonic: { phrase: 'test test test test test test test test test test test junk' } }) as never)
		;(globalThis as { fetch?: unknown }).fetch = jest.fn(async (url: unknown) => {
			if (String(url).includes('/api/addUser')) posts.push(String(url))
			return { ok: true, status: 200, json: async () => ({}) }
		})
	})

	it('negative control: a registered EOA is refused and no addUser is sent', async () => {
		chainIdentityRead.read = async () => ({ status: 'ok', info: { exists: true } as never })
		await expect(createDetachedRecoverAccount('synthtag', '123456')).rejects.toBeInstanceOf(LocalCreateError)
		expect(posts).toEqual([])
	})
})

/**
 * T-R3 integration, createRecover: the store probe and the new wallet are the test seam (deps: IndexedDB and the key store do not run under
 * jest). Everything else is the real path (the recovery hash, the encryption, the registration check, newUser). A refusal is checked by its
 * step code, so a refusal for another reason does not pass.
 */
describe('T-R3 integration: createRecover reaches newUser only for an unregistered EOA', () => {
	let posts: string[] = []
	const SYN_KEY = '0x' + '11'.repeat(32)
	const emptyStore = async () => ({ status: 'empty' }) as never
	const newWallet = async () => ({ mnemonicPhrase: 'test test test test test test test test test test test junk', profiles: [{ keyID: '0x1111111111111111111111111111111111111111', privateKeyArmor: SYN_KEY }] }) as never
	beforeEach(() => {
		posts = []
		;(globalThis as { fetch?: unknown }).fetch = jest.fn(async (url: unknown) => {
			if (String(url).includes('/api/addUser')) posts.push(String(url))
			return { ok: true, status: 200, json: async () => ({}) }
		})
	})

	it('negative control: a registered EOA is refused with already_registered, and no addUser is sent', async () => {
		chainIdentityRead.read = async () => ({ status: 'ok', info: { exists: true } as never })
		await expect(createRecover('synthtag', '123456', { deps: { checkStatus: emptyStore, createWallet: newWallet } })).rejects.toMatchObject({ step: 'already_registered' })
		expect(posts).toEqual([])
	})

	it('a lookup that cannot tell is refused with registration_unknown (fail closed), and no addUser is sent', async () => {
		chainIdentityRead.read = async () => { throw new Error('rpc down') }
		await expect(createRecover('synthtag', '123456', { deps: { checkStatus: emptyStore, createWallet: newWallet } })).rejects.toMatchObject({ step: 'registration_unknown' })
		expect(posts).toEqual([])
	})
})

export {}
