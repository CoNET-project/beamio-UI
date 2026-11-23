/**
 * @jest-environment node
 */
/**
 * The production lookupRecipientRecord (chat.ts) in the shell build and in the web build, with a stub provider (the CONET RPC is replaced by
 * a runner that answers eth_call). SYNTHETIC values only.
 */
import { ethers } from 'ethers'

jest.mock('@/workers/appDaemon/client', () => ({}))
jest.mock('@/workers/beamioTag/client', () => ({}))
jest.mock('@/services/chatWorkerBridge', () => ({}))
jest.mock('@/services/chatMediaWorkerBridge', () => ({}))
jest.mock('@/services/argon2WorkerBridge', () => ({}))

const WALLET = '0x00000000000000000000000000000000000000a1'
const b64 = (s: string) => Buffer.from(s).toString('base64')

type Answer = unknown[] | Error
function stubProvider(abiForEncoding: ethers.InterfaceAbi, answer: Answer) {
	const iface = new ethers.Interface(abiForEncoding)
	return {
		provider: null,
		resolveName: async (n: string) => n,
		call: async () => {
			if (answer instanceof Error) throw answer
			return iface.encodeFunctionResult('searchKey', answer)
		},
	}
}

function loadChat(shell: boolean, answer: Answer) {
	const saved = process.env.REACT_APP_SHELL_BUILD
	process.env.REACT_APP_SHELL_BUILD = shell ? 'true' : 'false'
	let chat: typeof import('./chat') | undefined
	try {
		jest.isolateModules(() => {
			jest.doMock('@/utils/constants', () => {
				const actual = jest.requireActual('@/utils/constants')
				// the full searchKey fragment is enough to encode the stub's answer in both builds
				const enc = ['function searchKey(address to) view returns (string userPgpKeyID, string userPublicKeyArmored, string routePgpKeyID, string routePublicKeyArmored, bool routeOnline)']
				return { ...actual, conetDepinProvider: stubProvider(enc, answer) }
			})
			// eslint-disable-next-line @typescript-eslint/no-var-requires
			chat = require('./chat')
		})
	} finally {
		if (saved === undefined) delete process.env.REACT_APP_SHELL_BUILD
		else process.env.REACT_APP_SHELL_BUILD = saved
	}
	return chat!
}

for (const shell of [true, false]) {
	describe(`lookupRecipientRecord, ${shell ? 'shell' : 'web'} build`, () => {
		it('a registered address reads ok', async () => {
			const chat = loadChat(shell, ['uid', b64('USERKEY'), 'rid', b64('ROUTEKEY'), true])
			expect(await chat.lookupRecipientRecord(WALLET)).toMatchObject({ status: 'ok', publicArmored: 'USERKEY', routersArmoreds: 'ROUTEKEY' })
		})
		it('an empty answer is no_record; a failed call is network_error', async () => {
			expect(await loadChat(shell, ['', '', '', '', false]).lookupRecipientRecord(WALLET)).toEqual({ status: 'no_record' })
			expect((await loadChat(shell, new Error('could not detect network')).lookupRecipientRecord(WALLET)).status).toBe('network_error')
		})
	})
}
