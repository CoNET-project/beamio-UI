/**
 * @jest-environment node
 */
/**
 * R76 section 8, C1: the registration message the wallet signs is the layout the endpoint verifies (x402sdk chatRouteAuth.ts,
 * candidate 07823354). The shared PWA vectors (PV-1..PV-4) carry the expected message and the recovered address for each positive case.
 * SYNTHETIC values only; the vector file is a copy of the public request fields.
 */
import { createHash } from 'crypto'
import { readFileSync } from 'fs'
import { join } from 'path'
import { ethers } from 'ethers'
import { buildRegiestChatRouteMessage } from './pgpBlob'

const VECTOR_FILE = join(__dirname, '__fixtures__', 'chat-route-register-pwa-vectors.v1.json')
const VECTOR_SHA256 = 'd5a1b23700072cc54b8e2359b0ec3845d6d6877240b7a96a325542fb2d57cffe'

type Positive = {
	id: string
	message: string
	recoveredAddress: string
	body: { wallet: string; keyID: string; publicKeyArmored: string; encrypKeyArmored: string; routeKeyID: string; timestamp: number; nonce: string; signature: string }
}

const raw = readFileSync(VECTOR_FILE)
const doc = JSON.parse(raw.toString('utf8')) as { positives: Positive[] }
const keccak = (s: string) => ethers.keccak256(ethers.toUtf8Bytes(s))

const build = (b: Positive['body']) =>
	buildRegiestChatRouteMessage({
		wallet: b.wallet,
		keyID: b.keyID,
		publicKeyArmored: b.publicKeyArmored,
		encrypKeyArmored: b.encrypKeyArmored,
		routeKeyID: b.routeKeyID,
		timestamp: b.timestamp,
		nonce: b.nonce,
		keccak,
	})

describe('regiestChatRoute signed message (R76 section 8, C1)', () => {
	it('the vector file is the pinned copy (sha256 d5a1b237...7cffe) with four positive cases', () => {
		expect(createHash('sha256').update(raw).digest('hex')).toBe(VECTOR_SHA256)
		expect(doc.positives.map((p) => p.id)).toEqual(['PV-1', 'PV-2', 'PV-3', 'PV-4'])
	})

	it.each(['PV-1', 'PV-2', 'PV-3', 'PV-4'])('%s: the message is byte-equal to the endpoint layout, and the signature recovers the wallet', (id) => {
		const c = doc.positives.find((p) => p.id === id) as Positive
		expect(build(c.body)).toBe(c.message)
		expect(ethers.verifyMessage(c.message, c.body.signature).toLowerCase()).toBe(c.recoveredAddress.toLowerCase())
	})

	it('PV-4: a keyID with surrounding whitespace is trimmed before it is written (the endpoint trims every text field)', () => {
		const c = doc.positives.find((p) => p.id === 'PV-4') as Positive
		expect(c.body.keyID).not.toBe(c.body.keyID.trim())
		expect(build(c.body)).toContain('\nkeyID:6629DED57B806861\n')
	})

	it('a PGP armor with a trailing newline is hashed without it (the same hash the endpoint computes)', () => {
		const c = doc.positives.find((p) => p.id === 'PV-1') as Positive
		const withNewline = { ...c.body, publicKeyArmored: `${c.body.publicKeyArmored}\n` }
		expect(build(withNewline)).toBe(c.message)
	})

	it('the wallet is written in lowercase and the nonce in lowercase hex', () => {
		const c = doc.positives.find((p) => p.id === 'PV-2') as Positive
		const upper = { ...c.body, wallet: c.body.wallet.toUpperCase().replace('0X', '0x'), nonce: c.body.nonce.toUpperCase().replace('0X', '0x') }
		expect(build(upper)).toBe(c.message)
	})
})
