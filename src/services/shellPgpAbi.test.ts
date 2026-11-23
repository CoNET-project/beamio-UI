/**
 * @jest-environment node
 */
/**
 * Shell build keeps the minimal AddressPGP ABI (`searchKey` only). Without it every contact lookup in the shell failed with a TypeError
 * that was reported as a network error. SYNTHETIC values only; the chain call is a stub runner.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs'
import { readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ethers } from 'ethers'
import { isProgrammingError, readRecipientRecord, RecipientInternalError } from './recipientRecord'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { checkWorkerBuild, checkShellPgpAbi } = require('../../scripts/check-worker-chunks.js')

const WALLET = '0x00000000000000000000000000000000000000a1'
const b64 = (s: string) => Buffer.from(s).toString('base64')
const decode = (s: string) => Buffer.from(s, 'base64').toString()

function loadContracts(shell: boolean) {
	const saved = process.env.REACT_APP_SHELL_BUILD
	process.env.REACT_APP_SHELL_BUILD = shell ? 'true' : 'false'
	let mod: typeof import('../utils/contracts')
	try {
		jest.isolateModules(() => {
			// eslint-disable-next-line @typescript-eslint/no-var-requires
			mod = require('../utils/contracts')
		})
	} finally {
		if (saved === undefined) delete process.env.REACT_APP_SHELL_BUILD
		else process.env.REACT_APP_SHELL_BUILD = saved
	}
	return mod!
}

/** A runner that answers searchKey with the given values (or throws), like a provider would. */
function stubRunner(abi: ethers.InterfaceAbi, answer: unknown[] | Error) {
	const iface = new ethers.Interface(abi)
	return {
		provider: null,
		resolveName: async (n: string) => n,
		call: async () => {
			if (answer instanceof Error) throw answer
			return iface.encodeFunctionResult('searchKey', answer)
		},
	} as unknown as ethers.ContractRunner
}

/** Mirrors lookupRecipientRecord: the contract from the page ABI, a named guard, then the reader. */
async function lookup(abi: ethers.InterfaceAbi, answer: unknown[] | Error) {
	return readRecipientRecord(() => {
		const pgp = new ethers.Contract(WALLET, abi, stubRunner(abi, answer))
		if (typeof pgp.searchKey !== 'function') throw new RecipientInternalError('abi_missing')
		return pgp.searchKey(WALLET)
	}, decode)
}

describe('shell AddressPGP ABI', () => {
	const shell = loadContracts(true).default?.constPgpManager ?? (loadContracts(true) as unknown as { contracts: never }).contracts
	it('the shell ABI holds searchKey and no backup field', () => {
		const abi = new ethers.Interface(shell.abi as ethers.InterfaceAbi)
		expect(abi.getFunction('searchKey')).not.toBeNull()
		expect(abi.fragments.filter((f) => f.type === 'function').map((f) => (f as ethers.FunctionFragment).name)).toEqual(['searchKey'])
		expect(JSON.stringify(shell.abi)).not.toContain('getEncryptedPrivateKey')
	})

	it('shell build: a registered address reads ok', async () => {
		const r = await lookup(shell.abi as ethers.InterfaceAbi, ['uid', b64('USERKEY'), 'rid', b64('ROUTEKEY'), true])
		expect(r).toMatchObject({ status: 'ok', publicArmored: 'USERKEY', routersArmoreds: 'ROUTEKEY' })
	})

	it('shell build: an empty answer is no_record, an incomplete registration is network_error', async () => {
		expect(await lookup(shell.abi as ethers.InterfaceAbi, ['', '', '', '', false])).toEqual({ status: 'no_record' })
		expect(await lookup(shell.abi as ethers.InterfaceAbi, ['uid', b64('USERKEY'), '', '', false])).toEqual({ status: 'network_error', reason: 'incomplete_registration' })
	})

	it('a real network error is still network_error', async () => {
		const r = await lookup(shell.abi as ethers.InterfaceAbi, new Error('could not detect network'))
		expect(r.status).toBe('network_error')
	})

	it('an empty ABI fails by name and is not network_error', async () => {
		const r = await lookup([], ['uid', b64('K'), 'rid', b64('R'), true])
		expect(r).toEqual({ status: 'internal_error', reason: 'abi_missing' })
	})

	it('a TypeError from the reader is internal_error, never network_error', async () => {
		const r = await readRecipientRecord(() => Promise.reject(new TypeError('x is not a function')), decode)
		expect(r).toEqual({ status: 'internal_error', reason: 'TypeError' })
		expect(isProgrammingError(new ReferenceError('y'))).toBe(true)
		expect(isProgrammingError(new Error('timeout'))).toBe(false)
	})

	it('the page code keeps the named guard and logs the internal error', () => {
		const src = readFileSync(join(__dirname, 'chat.ts'), 'utf8')
		expect(src).toContain("new RecipientInternalError('abi_missing')")
		expect(src).toContain('recipient lookup internal error')
	})
})

describe('shell artifact check (searchKey present, backup field name absent)', () => {
	function build(body: string): string {
		const root = mkdtempSync(join(tmpdir(), 'shell-abi-'))
		mkdirSync(join(root, 'static', 'js'), { recursive: true })
		writeFileSync(join(root, 'static', 'js', 'main.abc.js'), body)
		return join(root, '')
	}
	const GOOD = 'function searchKey(address to) view returns (string userPgpKeyID, string userPublicKeyArmored, string routePgpKeyID, string routePublicKeyArmored, bool routeOnline)'

	it('passes with the fragment and without the backup field', () => {
		const root = build(GOOD)
		expect(checkShellPgpAbi(join(root, 'static', 'js')).ok).toBe(true)
	})
	it('fails when the fragment is missing', () => {
		const r = checkShellPgpAbi(join(build('nothing'), 'static', 'js'))
		expect(r.ok).toBe(false)
		expect(r.missing.length).toBeGreaterThan(0)
	})
	it('fails when the backup field name is present', () => {
		const r = checkShellPgpAbi(join(build(GOOD + ';getEncryptedPrivateKey'), 'static', 'js'))
		expect(r.ok).toBe(false)
		expect(r.forbidden).toEqual(['getEncryptedPrivateKey'])
	})
	it('the whole-build shell check includes it', () => {
		const r = checkWorkerBuild(build(GOOD + ';getEncryptedPrivateKey'), { shell: true })
		expect(r.ok).toBe(false)
		expect(r.pgpAbi.ok).toBe(false)
	})
})

describe('send path: an internal fault is not shown as a network failure', () => {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const { resolveRecipientPublicArmored, refreshRecipient } = require('../utils/recipientPublicKey')
	const chat = { address: WALLET, chatData: null }
	it('an internal_error lookup is recipient_key_unavailable (resolve and refresh)', async () => {
		const fetchInternal = async () => ({ status: 'internal_error', reason: 'abi_missing' })
		expect(await resolveRecipientPublicArmored(chat, fetchInternal)).toEqual({ ok: false, code: 'recipient_key_unavailable' })
		expect(await refreshRecipient(chat, fetchInternal)).toEqual({ ok: false, code: 'recipient_key_unavailable' })
	})
	it('a TypeError thrown by the fetch is recipient_key_unavailable; another throw stays network_error', async () => {
		expect(await resolveRecipientPublicArmored(chat, async () => { throw new TypeError('x') })).toEqual({ ok: false, code: 'recipient_key_unavailable' })
		expect(await resolveRecipientPublicArmored(chat, async () => { throw new Error('socket') })).toEqual({ ok: false, code: 'network_error' })
		expect(await resolveRecipientPublicArmored(chat, async () => ({ status: 'network_error', reason: 'rpc' }))).toEqual({ ok: false, code: 'network_error' })
	})
})

describe('first-open claim gate: an internal fault is an unknown chain read', () => {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const { skipAutoBUnitClaimForFirstOpen } = require('./firstOpenClaimGate')
	it('internal_error behaves like network_error: the claim is not skipped on it', () => {
		const base = { shell: false, localChatKeyComplete: false, pendingPresent: false }
		expect(skipAutoBUnitClaimForFirstOpen({ ...base, lookup: { status: 'internal_error' } })).toBe(skipAutoBUnitClaimForFirstOpen({ ...base, lookup: { status: 'network_error' } }))
		expect(skipAutoBUnitClaimForFirstOpen({ ...base, lookup: { status: 'internal_error' } })).toBe(false)
	})
})
