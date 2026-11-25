/**
 * registrationStateVia (0.53.51): the registration state of a (tag, wallet) pair through one host, with the chain id check. The same
 * function serves the gate and the completion. SYNTHETIC values only; the three reads are injected.
 */
const nodeUtil = require('util')
Object.assign(globalThis, { TextEncoder: nodeUtil.TextEncoder, TextDecoder: nodeUtil.TextDecoder })
const { registrationStateVia } = require('./beamio') as typeof import('./beamio')
jest.mock('./argon2WorkerBridge', () => ({ argon2idAsync: async (_p: Uint8Array, _s: Uint8Array, o: { dkLen: number }) => new Uint8Array(o.dkLen), warmArgon2Worker: () => undefined }))
jest.mock('./chatMediaWorkerBridge', () => new Proxy({}, { get: () => () => undefined }))
jest.mock('./chatWorkerBridge', () => new Proxy({}, { get: () => () => undefined }))
jest.mock('../workers/beamioTag/client', () => new Proxy({}, { get: () => () => undefined }))
jest.mock('../workers/appDaemon/client', () => new Proxy({}, { get: () => () => undefined }))

const EOA = '0x' + '1'.repeat(40)
const OTHER = '0x' + '2'.repeat(40)
const ZERO = '0x' + '0'.repeat(40)
const CHAIN = '0x36ca6'

type L = { status: 'ok'; info: never } | { status: 'no_account' } | { status: 'network_error'; reason: string }
const run = (over: { chainId?: () => Promise<string>; owner?: () => Promise<string>; lookup?: () => Promise<L> }) =>
	registrationStateVia('https://rpc.test', 'synthtag', EOA, {
		chainId: over.chainId ?? (async () => CHAIN),
		owner: over.owner ?? (async () => ZERO),
		lookup: (over.lookup ?? (async () => ({ status: 'no_account' }))) as never,
	})

describe('registered', () => {
	it('the tag is owned by this wallet (the step-2 meaning), even if the account read says nothing', async () => {
		expect(await run({ owner: async () => EOA.toUpperCase().replace('0X', '0x'), lookup: async () => ({ status: 'network_error', reason: 'x' }) })).toBe('registered')
	})
	it('this wallet has an account, whatever its name', async () => {
		expect(await run({ lookup: async () => ({ status: 'ok', info: {} as never }), owner: async () => OTHER })).toBe('registered')
	})
})

describe('unregistered', () => {
	it('no account for the wallet and the tag has no owner', async () => {
		expect(await run({})).toBe('unregistered')
	})
	it('no account for the wallet and the tag belongs to another wallet (step 2 will answer tag_taken)', async () => {
		expect(await run({ owner: async () => OTHER })).toBe('unregistered')
	})
})

describe('unknown: never "unregistered" on a doubt', () => {
	it.each([
		['the chain id is not 224422', { chainId: async () => '0x1' }],
		['the chain id read fails', { chainId: async () => Promise.reject(new Error('x')) }],
		['the owner read fails (and the account read says no account)', { owner: async () => Promise.reject(new Error('x')) }],
		['the account read fails (and the owner is nobody)', { lookup: async () => ({ status: 'network_error' as const, reason: 'timeout' }) }],
	])('%s', async (_n, over) => {
		expect(await run(over as never)).toBe('unknown')
	})
	it('the chain id compare ignores case', async () => {
		expect(await run({ chainId: async () => '0x36CA6' })).toBe('unregistered')
	})
})
export {}
