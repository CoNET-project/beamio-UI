/**
 * @jest-environment node
 */
/**
 * the runtime chain id check in the production lookupRecipientRecord (chat.ts), with a stub provider. SYNTHETIC values only.
 * Scenarios: chain mismatch, chain id read fails, chain correct but the record is another one (vectors cover the trust verdict), the actual chain id in the source,
 * and the session cache of the check (kept per endpoint, dropped after an endpoint change and after a read failure).
 */
import { ethers } from 'ethers'

jest.mock('@/workers/appDaemon/client', () => ({}))
jest.mock('@/workers/beamioTag/client', () => ({}))
jest.mock('@/services/chatWorkerBridge', () => ({}))
jest.mock('@/services/chatMediaWorkerBridge', () => ({}))
jest.mock('@/services/argon2WorkerBridge', () => ({}))

const WALLET = '0x00000000000000000000000000000000000000a1'
const b64 = (s: string) => Buffer.from(s).toString('base64')
const ABI = ['function searchKey(address to) view returns (string userPgpKeyID, string userPublicKeyArmored, string routePgpKeyID, string routePublicKeyArmored, bool routeOnline)']

type Chain = string | Error
function load(opts: { answers?: Array<unknown[] | Error>; chainIds?: Chain[]; url?: { v: string } }) {
	const iface = new ethers.Interface(ABI)
	const chainCalls: string[] = []
	let callIdx = 0
	let chainIdx = 0
	const url = opts.url ?? { v: 'https://rpc-a.invalid' }
	const provider = {
		provider: null,
		resolveName: async (n: string) => n,
		_getConnection: () => ({ url: url.v }),
		send: async (method: string) => {
			if (method !== 'eth_chainId') throw new Error('unexpected ' + method)
			chainCalls.push(url.v)
			const c = (opts.chainIds ?? ['0x36ca6'])[Math.min(chainIdx++, (opts.chainIds ?? ['0x36ca6']).length - 1)]
			if (c instanceof Error) throw c
			return c
		},
		call: async () => {
			const a = (opts.answers ?? [['uid', b64('USERKEY'), 'rid', b64('ROUTEKEY'), true]])[Math.min(callIdx++, (opts.answers ?? [1]).length - 1)]
			if (a instanceof Error) throw a
			return iface.encodeFunctionResult('searchKey', a as unknown[])
		},
	}
	let chat: typeof import('./chat') | undefined
	jest.isolateModules(() => {
		jest.doMock('@/utils/constants', () => ({ ...jest.requireActual('@/utils/constants'), conetDepinProvider: provider }))
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		chat = require('./chat')
	})
	return { chat: chat!, chainCalls, url, calls: () => callIdx }
}

describe('lookupRecipientRecord: the runtime chain check', () => {
	it('the chain the RPC reports is the source chain id (the ACTUAL value), and a read goes through', async () => {
		const { chat } = load({})
		const r = await chat.lookupRecipientRecord(WALLET)
		expect(r).toMatchObject({ status: 'ok', source: { chainId: 224422, contract: '0x684b0ac760cEE9c9b85de36d69746420648Cf9e2', queriedAddress: WALLET } })
	})

	it('chain MISMATCH (the RPC says it is another chain): network_error, nothing is read, no source, nothing could be trusted or sent', async () => {
		const { chat, calls } = load({ chainIds: ['0x1'] })
		const r = await chat.lookupRecipientRecord(WALLET)
		expect(r).toEqual({ status: 'network_error', reason: 'chain_id_mismatch' })
		expect(calls()).toBe(0)
	})

	it('the chain id read FAILS: network_error (unavailable), nothing is read', async () => {
		const { chat, calls } = load({ chainIds: [new Error('rpc down')] })
		const r = await chat.lookupRecipientRecord(WALLET)
		expect(r).toEqual({ status: 'network_error', reason: 'chain_id_unavailable' })
		expect(calls()).toBe(0)
	})

	it('chain correct but the record is empty or the call fails: the usual results (the trust verdict on a record that does not match is in the vectors)', async () => {
		expect(await load({ answers: [['', '', '', '', false]] }).chat.lookupRecipientRecord(WALLET)).toEqual({ status: 'no_record' })
		expect((await load({ answers: [new Error('boom')] }).chat.lookupRecipientRecord(WALLET)).status).toBe('network_error')
	})

	it('the chain id is asked once per endpoint for many lookups (session cache)', async () => {
		const { chat, chainCalls } = load({})
		await chat.lookupRecipientRecord(WALLET)
		await chat.lookupRecipientRecord(WALLET)
		await chat.lookupRecipientRecord(WALLET)
		expect(chainCalls).toEqual(['https://rpc-a.invalid'])
	})

	it('an ENDPOINT change drops the kept answer: the new endpoint is asked (and a wrong chain there is a mismatch)', async () => {
		const { chat, chainCalls, url } = load({ chainIds: ['0x36ca6', '0x1'] })
		expect((await chat.lookupRecipientRecord(WALLET)).status).toBe('ok')
		url.v = 'https://rpc-b.invalid'
		expect(await chat.lookupRecipientRecord(WALLET)).toEqual({ status: 'network_error', reason: 'chain_id_mismatch' })
		expect(chainCalls).toEqual(['https://rpc-a.invalid', 'https://rpc-b.invalid'])
	})

	it('a failed record READ drops the kept answer: the next lookup asks for the chain id again', async () => {
		const { chat, chainCalls } = load({ answers: [new Error('boom'), ['uid', b64('USERKEY'), 'rid', b64('ROUTEKEY'), true]], chainIds: ['0x36ca6', '0x36ca6'] })
		expect((await chat.lookupRecipientRecord(WALLET)).status).toBe('network_error')
		expect((await chat.lookupRecipientRecord(WALLET)).status).toBe('ok')
		expect(chainCalls).toHaveLength(2)
	})

	it('an old good answer is never reused after the chain id itself fails: the next lookup asks again and can end in a mismatch', async () => {
		const { chat, chainCalls } = load({ chainIds: ['0x36ca6', new Error('x'), '0x1'] })
		expect((await chat.lookupRecipientRecord(WALLET)).status).toBe('ok')
		chat.pgpChainIdGuard.noteReadFailure()
		expect(await chat.lookupRecipientRecord(WALLET)).toEqual({ status: 'network_error', reason: 'chain_id_unavailable' })
		expect(await chat.lookupRecipientRecord(WALLET)).toEqual({ status: 'network_error', reason: 'chain_id_mismatch' })
		expect(chainCalls).toHaveLength(3)
	})

	// a first contact asks the RPC for its chain id again for this lookup (freshChain); a contact that already has a pinned value reuses the session answer
	it('freshChain: the chain id is asked again for EVERY such lookup (the session cache does not serve it), while plain lookups still share one answer', async () => {
		const { chat, chainCalls } = load({})
		await chat.lookupRecipientRecord(WALLET)
		await chat.lookupRecipientRecord(WALLET)
		expect(chainCalls).toHaveLength(1)
		await chat.lookupRecipientRecord(WALLET, { freshChain: true })
		await chat.lookupRecipientRecord(WALLET, { freshChain: true })
		expect(chainCalls).toHaveLength(3)
		await chat.lookupRecipientRecord(WALLET) // the answer of the last fresh check serves the plain lookup again
		expect(chainCalls).toHaveLength(3)
	})

	it('freshChain: the chain changed on the SAME endpoint after the chat connected -> the first-contact lookup is unavailable (nothing sent), a plain lookup still follows its session answer', async () => {
		const { chat, chainCalls } = load({ chainIds: ['0x36ca6', '0x1', '0x1'] })
		expect((await chat.lookupRecipientRecord(WALLET)).status).toBe('ok') // the chat connected on the right chain
		expect(await chat.lookupRecipientRecord(WALLET, { freshChain: true })).toEqual({ status: 'network_error', reason: 'chain_id_mismatch' })
		expect(chainCalls).toHaveLength(2)
		// the mismatch dropped the kept answer: nothing old is reused afterwards, the next lookup asks again
		expect(await chat.lookupRecipientRecord(WALLET)).toEqual({ status: 'network_error', reason: 'chain_id_mismatch' })
		expect(chainCalls).toHaveLength(3)
	})

	it('freshChain: a failed fresh chain id read is unavailable and keeps nothing (failure invalidates as before)', async () => {
		const { chat, chainCalls } = load({ chainIds: ['0x36ca6', new Error('x'), '0x36ca6'] })
		expect((await chat.lookupRecipientRecord(WALLET)).status).toBe('ok')
		expect(await chat.lookupRecipientRecord(WALLET, { freshChain: true })).toEqual({ status: 'network_error', reason: 'chain_id_unavailable' })
		expect((await chat.lookupRecipientRecord(WALLET)).status).toBe('ok')
		expect(chainCalls).toHaveLength(3)
	})
})
