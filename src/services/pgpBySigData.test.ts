/**
 * @jest-environment node
 */
/**
 * GAS-1 plan B: the signed registration data of AddressPGP.addPublicPGPBySig (the SDK module, built from vendor/conet-chat-sdk/src). The
 * layout follows src/mainnet/AddressPGP.sol (typehash AddPublicPGP, domain AddressPGP v1). SYNTHETIC values only: a fixed test key.
 */
import { ethers } from 'ethers'
import { ADD_PUBLIC_PGP_TYPES, buildAddPublicPGPTypedData, normalizeAddPublicPGPText, signAddPublicPGPBySig } from '../../vendor/conet-chat-sdk/dist/pgpBySigData.js'

const PK = '0x' + '11'.repeat(32)
const WALLET = new ethers.Wallet(PK)
const PGP_ADDR = '0x684b0ac760cEE9c9b85de36d69746420648Cf9e2'
const BASE = {
	chainId: 224422,
	verifyingContract: PGP_ADDR,
	to: WALLET.address,
	pgpKeyID: 'SYNTH-KEYID-0001',
	publicKeyArmored: '-----BEGIN PGP PUBLIC KEY BLOCK-----\nSYNTH\n-----END PGP PUBLIC KEY BLOCK-----',
	encrypKeyArmored: 'SYNTH-ENCRYPT-BLOB',
	routePgpKeyID: 'SYNTH-ROUTE-0001',
	nonce: 0,
	deadline: 1_800_000_000,
}
const keccakText = (s: string) => ethers.keccak256(ethers.toUtf8Bytes(s))

describe('AddressPGP addPublicPGPBySig signed data (GAS-1 plan B)', () => {
	it('the domain is AddressPGP v1 on the CoNET chain at the AddressPGP address; the struct keeps the contract field order', () => {
		const td = buildAddPublicPGPTypedData(BASE)
		expect(td.domain).toEqual({ name: 'AddressPGP', version: '1', chainId: 224422, verifyingContract: ethers.getAddress(PGP_ADDR) })
		expect(ADD_PUBLIC_PGP_TYPES.AddPublicPGP.map((f) => f.name)).toEqual(['to', 'pgpKeyIDHash', 'publicKeyArmoredHash', 'encrypKeyArmoredHash', 'routePgpKeyIDHash', 'nonce', 'deadline'])
	})

	it('the message holds the keccak hashes of the texts, the route hash (zero without a route), the nonce and the deadline', () => {
		const td = buildAddPublicPGPTypedData(BASE)
		expect(td.message.pgpKeyIDHash).toBe(keccakText('SYNTH-KEYID-0001'))
		expect(td.message.publicKeyArmoredHash).toBe(keccakText(BASE.publicKeyArmored))
		expect(td.message.encrypKeyArmoredHash).toBe(keccakText(BASE.encrypKeyArmored))
		expect(td.message.routePgpKeyIDHash).toBe(keccakText('SYNTH-ROUTE-0001'))
		expect(td.message.nonce).toBe(0n)
		expect(td.message.deadline).toBe(1_800_000_000n)
		const noRoute = buildAddPublicPGPTypedData({ ...BASE, routePgpKeyID: '' })
		expect(noRoute.message.routePgpKeyIDHash).toBe(ethers.ZeroHash)
	})

	it('the texts are trimmed before they are hashed and submitted (the hash is the hash of the submitted string)', () => {
		const padded = buildAddPublicPGPTypedData({ ...BASE, publicKeyArmored: `${BASE.publicKeyArmored}\n`, pgpKeyID: '  SYNTH-KEYID-0001 ' })
		const clean = buildAddPublicPGPTypedData(BASE)
		expect(padded.submitted.publicKeyArmored).toBe(BASE.publicKeyArmored)
		expect(padded.message.publicKeyArmoredHash).toBe(clean.message.publicKeyArmoredHash)
		expect(padded.message.pgpKeyIDHash).toBe(clean.message.pgpKeyIDHash)
		expect(normalizeAddPublicPGPText('  x \n')).toBe('x')
	})

	it('the wallet signature recovers the wallet (the contract requires signer == to)', async () => {
		const sig = await signAddPublicPGPBySig(WALLET as unknown as ethers.Wallet, { ...BASE, nonce: 3 })
		const td = buildAddPublicPGPTypedData({ ...BASE, nonce: 3 })
		expect(ethers.verifyTypedData(td.domain, td.types, td.message, sig)).toBe(WALLET.address)
	})

	it('a different nonce gives a different digest (a signature is for one nonce)', () => {
		const digest = (nonce: number) => {
			const td = buildAddPublicPGPTypedData({ ...BASE, nonce })
			return ethers.TypedDataEncoder.hash(td.domain, td.types, td.message)
		}
		expect(digest(3)).not.toBe(digest(4))
		expect(digest(3)).toBe(digest(3))
	})

	it('a signer that is not the wallet in `to` is refused before anything is signed', async () => {
		const other = new ethers.Wallet('0x' + '22'.repeat(32))
		await expect(signAddPublicPGPBySig(other as unknown as ethers.Wallet, BASE)).rejects.toThrow('signer_is_not_to')
	})

	it('the reserved PGP possession signature is carried, and it is never part of the on-chain struct', () => {
		const td = buildAddPublicPGPTypedData({ ...BASE, pgpPossessionSignature: '0xabc' })
		expect(td.pgpPossessionSignature).toBe('0xabc')
		expect(Object.keys(td.message).sort()).toEqual(['deadline', 'encrypKeyArmoredHash', 'nonce', 'pgpKeyIDHash', 'publicKeyArmoredHash', 'routePgpKeyIDHash', 'to'])
	})
})
