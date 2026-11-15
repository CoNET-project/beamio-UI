/**
 * The sealed blob survives the record's own codec: stripping the shell secrets keeps it, and the encoded page record reads back with the
 * same value. The record never holds a phrase or a private key in this path. SYNTHETIC values only.
 */
import { encodeInitRaw, parseInitRaw } from './initRecordCodec'
import { stripShellSecrets } from './shellProfile'

const EOA = '0x' + 'a'.repeat(40)
const BLOB = 'native-sealed-blob-v1:AAAA'

const record = (withBlob: boolean): Record<string, unknown> => ({
	profiles: [{ keyID: EOA, accountName: 'Synthetic', chats: [] }],
	isReady: true,
	ver: 0,
	nonce: 0,
	webFilter: true,
	...(withBlob ? { walletCredentialBlob: BLOB } : {}),
})

describe('the sealed blob round-trips through the record codec', () => {
	it('the blob survives stripping and the encode and parse of the page record, unchanged', () => {
		const stored = encodeInitRaw(stripShellSecrets(record(true)))
		const back = parseInitRaw(stored)
		expect(back?.walletCredentialBlob).toBe(BLOB)
		expect((back?.profiles as Array<{ keyID: string }>)[0].keyID).toBe(EOA)
	})
	it('a record without a blob stays without one (no field is invented)', () => {
		const back = parseInitRaw(encodeInitRaw(stripShellSecrets(record(false))))
		expect(back && 'walletCredentialBlob' in back).toBe(false)
	})
	it('the stored text does not contain a phrase field', () => {
		const stored = Buffer.from(encodeInitRaw(stripShellSecrets(record(true))), 'base64').toString()
		expect(stored).not.toMatch(/mnemonic|mnemonicPhrase|recoveryWords/)
	})
})
