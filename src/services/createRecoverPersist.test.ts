/**
 * Browser create (0.53.48.1): the local save after newUser runs inside the restore write window, because the page write gate is closed until the
 * create flow is complete. Before this, the save was discarded, the re-read was empty and a registered account was reported as not created.
 * A save that still fails after newUser does not hide the recovery code. SYNTHETIC values only; IndexedDB is the test seam (deps.persist).
 */
const nodeUtil = require('util')
Object.assign(globalThis, { TextEncoder: nodeUtil.TextEncoder, TextDecoder: nodeUtil.TextDecoder })
if (!(globalThis as { crypto?: { subtle?: unknown } }).crypto?.subtle) Object.defineProperty(globalThis, 'crypto', { value: require('crypto').webcrypto, configurable: true })
const { createRecover, chainIdentityRead, consultPageWriteGate, setPageWritePermit } = require('./beamio') as typeof import('./beamio')
jest.mock('./argon2WorkerBridge', () => ({ argon2idAsync: async (_p: Uint8Array, _s: Uint8Array, o: { dkLen: number }) => new Uint8Array(o.dkLen), warmArgon2Worker: () => undefined }))
jest.mock('./chatMediaWorkerBridge', () => new Proxy({}, { get: () => () => undefined }))
jest.mock('./chatWorkerBridge', () => new Proxy({}, { get: () => () => undefined }))
jest.mock('../workers/beamioTag/client', () => new Proxy({}, { get: () => () => undefined }))
jest.mock('../workers/appDaemon/client', () => new Proxy({}, { get: () => () => undefined }))

const SYN_KEY = '0x' + '11'.repeat(32)
const emptyStore = async () => ({ status: 'empty' }) as never
const newWallet = async () => ({ mnemonicPhrase: 'test test test test test test test test test test test junk', profiles: [{ keyID: '0x1111111111111111111111111111111111111111', privateKeyArmor: SYN_KEY }] }) as never

describe('createRecover: the local save after newUser', () => {
	let posts: string[] = []
	beforeEach(() => {
		posts = []
		setPageWritePermit(null) // the gate is closed at the start of a create, as in AppEntryGate
		chainIdentityRead.read = async () => ({ status: 'no_account' })
		;(globalThis as { fetch?: unknown }).fetch = jest.fn(async (url: unknown) => {
			if (String(url).includes('/api/addUser')) posts.push(String(url))
			return { ok: true, status: 200, json: async () => ({ ok: true }) }
		})
	})
	afterEach(() => setPageWritePermit(null))

	it('the save runs while the write window is open (a closed gate would discard it), and the window is closed again after it', async () => {
		let gateOpenDuringSave: boolean | null = null
		const persist = jest.fn(async () => {
			gateOpenDuringSave = consultPageWriteGate('during_persist')
			return {} as never
		})
		const out = await createRecover('synthtag', '123456', { deps: { checkStatus: emptyStore, createWallet: newWallet, persist: persist as never } })
		expect(posts).toHaveLength(1)
		expect(persist).toHaveBeenCalledTimes(1)
		expect(persist).toHaveBeenCalledWith('synthtag')
		expect(gateOpenDuringSave).toBe(true)
		expect(consultPageWriteGate('after_persist')).toBe(false)
		if (!out) throw new Error('createRecover returned null')
		expect(out).toMatchObject({ pin: '123456' })
		expect((out as { persistFailed?: boolean }).persistFailed).toBeUndefined()
		expect(typeof out.recoverCode).toBe('string')
	})

	it('a save that fails after newUser does not fail the create: the recovery code is returned with persistFailed, and the window is closed', async () => {
		const persist = jest.fn(async () => {
			throw new Error('[persistAndVerifyLocalWallet] re-read failed: empty')
		})
		const out = await createRecover('synthtag', '123456', { deps: { checkStatus: emptyStore, createWallet: newWallet, persist: persist as never } })
		expect(posts).toHaveLength(1) // the account is registered
		if (!out) throw new Error('createRecover returned null')
		expect(out).toMatchObject({ persistFailed: true, pin: '123456' })
		expect(typeof out.recoverCode).toBe('string')
		expect(out.recoverCode.length).toBeGreaterThan(10)
		expect(out.temp.profiles?.length).toBe(1)
		expect(consultPageWriteGate('after_failed_persist')).toBe(false)
	})

	it('order: after a failed save the account is registered; a second createRecover on the same wallet is refused with already_registered and does not call newUser again', async () => {
		const failing = jest.fn(async () => {
			throw new Error('[persistAndVerifyLocalWallet] re-read failed: empty')
		})
		const first = await createRecover('synthtag', '123456', { deps: { checkStatus: emptyStore, createWallet: newWallet, persist: failing as never } })
		if (!first) throw new Error('createRecover returned null')
		expect((first as { persistFailed?: boolean }).persistFailed).toBe(true)
		expect(posts).toHaveLength(1)
		// the chain now holds the account; the same wallet comes back from the local store (the later onboarding save)
		chainIdentityRead.read = async () => ({ status: 'ok', info: { exists: true } as never })
		const loaded = (async () => ({ status: 'loaded', data: first.temp }) as never)
		const persist = jest.fn()
		await expect(createRecover('synthtag', '123456', { deps: { checkStatus: loaded, createWallet: newWallet, persist: persist as never } })).rejects.toMatchObject({ step: 'already_registered' })
		expect(posts).toHaveLength(1) // newUser (addUser) was not called again
		expect(persist).not.toHaveBeenCalled()
	})

	it('a refusal before newUser still throws and sends nothing (the registration check is unchanged)', async () => {
		chainIdentityRead.read = async () => ({ status: 'ok', info: { exists: true } as never })
		const persist = jest.fn()
		await expect(createRecover('synthtag', '123456', { deps: { checkStatus: emptyStore, createWallet: newWallet, persist: persist as never } })).rejects.toMatchObject({ step: 'already_registered' })
		expect(posts).toEqual([])
		expect(persist).not.toHaveBeenCalled()
	})
})

export {}
