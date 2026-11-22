/**
 * 2.2 (d): the createRecover test seam (`options.deps`) is honoured only under the test runner. A production build fixes NODE_ENV
 * at build time, so a caller cannot inject its own store probe or wallet creation there. SYNTHETIC values only.
 */
// beamio.ts reads TextEncoder at module load (jsdom does not provide it): set the globals before the module is required.
const nodeUtil = require('util')
Object.assign(globalThis, { TextEncoder: nodeUtil.TextEncoder, TextDecoder: nodeUtil.TextDecoder })
jest.mock('./argon2WorkerBridge', () => ({ argon2idAsync: async (_p: Uint8Array, _s: Uint8Array, o: { dkLen: number }) => new Uint8Array(o.dkLen), warmArgon2Worker: () => undefined }))
jest.mock('./chatMediaWorkerBridge', () => new Proxy({}, { get: () => () => undefined }))
jest.mock('./chatWorkerBridge', () => new Proxy({}, { get: () => () => undefined }))
jest.mock('../workers/beamioTag/client', () => new Proxy({}, { get: () => () => undefined }))
jest.mock('../workers/appDaemon/client', () => new Proxy({}, { get: () => () => undefined }))
jest.mock('openpgp', () => ({ readKey: async () => ({ getKeyIDs: () => [] }) }))
const { createRecover } = require('./beamio') as typeof import('./beamio')

describe('createRecover deps seam (2.2 (d))', () => {
	const env = process.env as Record<string, string | undefined>
	const savedEnv = env.NODE_ENV
	afterEach(() => {
		env.NODE_ENV = savedEnv
	})

	it('under the test runner the injected store probe is used (the seam works for tests)', async () => {
		env.NODE_ENV = 'test'
		const checkStatus = jest.fn(async () => ({ status: 'unavailable' as const }))
		await expect(createRecover('synthname', '123456', { deps: { checkStatus: checkStatus as never } })).rejects.toBeDefined()
		expect(checkStatus).toHaveBeenCalled()
	})

	it('a production build ignores the injected deps: the injected store probe is never called, and nothing is written', async () => {
		env.NODE_ENV = 'production'
		const checkStatus = jest.fn(async () => ({ status: 'loaded' as const, data: null }))
		const createWallet = jest.fn(async () => null)
		await createRecover('synthname', '123456', { deps: { checkStatus: checkStatus as never, createWallet: createWallet as never } }).catch(() => undefined)
		expect(checkStatus).not.toHaveBeenCalled()
		expect(createWallet).not.toHaveBeenCalled()
	})
})
