/**
 * Registration and backup payload (spec §25.52Y.163 item 36(2)-(3), item 37, the 1440 rule). Only the encrypted mnemonic may leave the
 * page: no private key, no private-key ciphertext and no plaintext mnemonic in the outbound body (BK-02, BK-03, BK-05).
 * The third argument of newUser (the wallet private key) is used only to derive the address and sign it; it is never serialized.
 * SYNTHETIC values only: the key below is an arbitrary test value and not an account.
 *
 * Not covered here (reported in the receipt): BK-01 (two recovery methods decrypt the same phrase: needs the WebCrypto and argon2 stack),
 * BK-04 (IPFS reference only: the backup path does not upload to IPFS, postToIPFS sends the profile image only), BK-06 (not defined in spec).
 */
import { ethers, wordlists } from 'ethers'

const nodeUtil = require('util')
Object.assign(globalThis, { TextEncoder: nodeUtil.TextEncoder, TextDecoder: nodeUtil.TextDecoder })

// beamio.ts loads worker bridges (import.meta, ESM-only). The same stand-ins as the App tests keep this module on the node side.
const deepStub = () => new Proxy({}, { get: (_t, k) => (k === '__esModule' ? true : jest.fn()) })
jest.mock('@/services/argon2WorkerBridge', () => deepStub())
jest.mock('@/services/chatWorkerBridge', () => deepStub())
jest.mock('@/services/chatMediaWorkerBridge', () => deepStub())
jest.mock('@/workers/beamioTag/client', () => deepStub())
jest.mock('@/workers/appDaemon/client', () => deepStub())
jest.mock('openpgp', () => deepStub())
jest.mock('pdfjs-dist', () => deepStub())

const { newUser } = require('./beamio') as typeof import('./beamio')

const SYNTH_KEY = '0x' + '11'.repeat(32)
const SYNTH_PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const EN_WORDS = (() => {
	const set = new Set<string>()
	for (let i = 0; i < 2048; i++) set.add(wordlists.en.getWord(i))
	return set
})()

const isPrivateKeyForm = (v: string) => /^0x[0-9a-fA-F]{64}$/.test(v)
const isMnemonicForm = (v: string) => {
	const words = v.trim().split(/\s+/)
	return (words.length === 12 || words.length === 24) && words.every((w) => EN_WORDS.has(w))
}
/** Every string value in the body, whatever its key name (BK-05: key names are neutral). */
function stringLeaves(node: unknown, out: string[] = []): string[] {
	if (typeof node === 'string') out.push(node)
	else if (Array.isArray(node)) node.forEach((n) => stringLeaves(n, out))
	else if (node && typeof node === 'object') Object.values(node).forEach((n) => stringLeaves(n, out))
	return out
}
/**
 * The recover hashes are keccak256 values (0x plus 64 hex): the same form as a private key. Spec 38(4) detects by value form, so the
 * detector takes the exact hash values of the recover entries as the only allowed 0x-64-hex values (needed; see receipt).
 */
function leakForms(body: unknown, raw: string): string[] {
	const hits: string[] = []
	const recover = (body as { recover?: unknown })?.recover
	const allowedHashes = new Set<string>(
		Array.isArray(recover) ? recover.map((r) => String((r as { hash?: unknown })?.hash ?? '')) : [],
	)
	for (const v of stringLeaves(body)) {
		if (isPrivateKeyForm(v) && !allowedHashes.has(v)) hits.push('private-key form')
		if (isMnemonicForm(v)) hits.push('mnemonic form')
	}
	if (raw.includes(SYNTH_KEY.slice(2))) hits.push('private key bytes in the raw body')
	if (raw.includes(SYNTH_PHRASE)) hits.push('plaintext phrase in the raw body')
	return hits
}

// Synthetic encrypted blob with the shape createRecover builds: base64(JSON({stored, img})). No plaintext phrase inside.
const blob = (img: string) => btoa(JSON.stringify({ stored: { salt: 'AAAA', n: 1 }, img }))
const RECOVER = [
	{ hash: '0x' + '22'.repeat(32), encrypto: blob('ct-recovery-code') },
	{ hash: '0x' + '33'.repeat(32), encrypto: blob('ct-password') },
]

let captured: { url: string; raw: string } | null = null
beforeEach(() => {
	captured = null
	global.fetch = jest.fn(async (url: string, init: { body?: unknown }) => {
		captured = { url: String(url), raw: String(init.body) }
		return { ok: true, json: async () => ({}) } as unknown as Response
	}) as unknown as typeof fetch
})

describe('registration payload carries only the encrypted mnemonic (spec 36(2)-(3), 1440; BK-02, BK-03, BK-05)', () => {
	it('BK-02: the wallet private key is not serialized; the body carries the address and a signature only', async () => {
		const ok = await newUser('synthtag', RECOVER, SYNTH_KEY)
		expect(ok).toBe(true)
		const body = JSON.parse(captured!.raw)
		expect(Object.keys(body).sort()).toEqual(['accountName', 'recover', 'signMessage', 'wallet'])
		expect(body.wallet).toBe(new ethers.Wallet(SYNTH_KEY).address)
		expect(captured!.raw).not.toContain(SYNTH_KEY.slice(2))
		expect(leakForms(body, captured!.raw)).toEqual([])
	})

	it('BK-03: the recover entries hold encrypted blobs only; no plaintext phrase leaves the page', async () => {
		await newUser('synthtag', RECOVER, SYNTH_KEY)
		const body = JSON.parse(captured!.raw)
		expect(body.recover).toEqual(RECOVER)
		expect(captured!.raw).not.toContain(SYNTH_PHRASE)
		expect(leakForms(body, captured!.raw)).toEqual([])
	})

	it('BK-05 (negative control): a private key or a phrase under a neutral key name is still flagged by the detector', () => {
		const hidden = { note: SYNTH_KEY }
		const phrase = { x: SYNTH_PHRASE }
		expect(leakForms(hidden, JSON.stringify(hidden))).toContain('private-key form')
		expect(leakForms(phrase, JSON.stringify(phrase))).toContain('mnemonic form')
		expect(leakForms({ x: 'not a key', y: 'ct' }, '{"x":"not a key","y":"ct"}')).toEqual([])
	})
})

describe('backup cases not covered by this file (receipt lists them)', () => {
	it.todo('BK-01: the two recovery methods decrypt the same phrase and derive the same EOA (needs WebCrypto and argon2)')
	it.todo('BK-04: an IPFS reference only in the registry; the backup path does not upload the phrase to IPFS')
	it.todo('BK-06: not defined in spec 25.52Y.163 item 36; awaiting rule')
})
