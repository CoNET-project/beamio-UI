/**
 * @jest-environment node
 *
 * Per 1c: a restored mnemonic is written in the PWA's own format. Checks: the stored blob has no plain mnemonic, the
 * read-back opens to the same phrase, and the derived address equals the native account. SYNTHETIC values only: the BIP-39 public test
 * vector (zero entropy), not an account.
 */
import { webcrypto } from 'crypto'
import { ethers } from 'ethers'
if (!(globalThis as { crypto?: { subtle?: unknown } }).crypto?.subtle) {
	Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })
}
import { isWrapRecord } from '@/services/passcode/walletWrap'
import { openWalletForStartup, wrapForDisk, type Loose } from '@/services/passcode/walletVault'
import { checkRecoveredRecord, recoveredPageRecord } from './recoveredMnemonicRecord'
import { memoryAtomicKeyValueDb, passcodeAttemptRecordStore } from './passcode/passcodeWrapStore'
const attemptDb = memoryAtomicKeyValueDb()

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const EOA = '0x9858effd232b4033e47d90003d41ec34ecaeda94'
const BLOB = 'synthetic-sealed-blob'

function memoryStores(initial: Loose | null) {
	let devKey: CryptoKey | null = null
	let stored: Loose | null = initial
	const write = async (data: Loose) => {
		stored = JSON.parse(JSON.stringify(data))
	}
	return {
		write,
		stores: {
			readInit: async () => (stored ? JSON.parse(JSON.stringify(stored)) : null),
			probeInit: async () => (stored ? JSON.parse(JSON.stringify(stored)) : null),
			writeInit: write,
			readMeta: async () => ({ failures: 0, nextAt: 0 }),
			attemptsFor: (e: string) => passcodeAttemptRecordStore(attemptDb, e),
			writeMeta: async () => undefined,
			deviceKeys: {
				load: async () => devKey,
				save: async (k: CryptoKey) => {
					devKey = k
				},
			},
		} as never,
		read: () => stored,
	}
}

describe('1c: a restored mnemonic is written in the PWA format and reads back as the same account', () => {
	const seed: Loose = { profiles: [{ keyID: EOA, isPrimary: true }], beamio: {}, isReady: true }

	it('no-passcode state (unit f3, 2026-11-22: device key removed): the phrase is written as plain, the blob is kept', async () => {
		const { stores, read, write } = memoryStores({})
		const out = await wrapForDisk(stores, recoveredPageRecord(seed, PHRASE, BLOB))
		await write(out)
		const onDisk = read() as Loose
		expect(isWrapRecord(onDisk.mnemonicPhrase)).toBe(false)
		expect(onDisk.mnemonicPhrase).toBe(PHRASE)
		expect(onDisk.walletCredentialBlob).toBe(BLOB)
	})

	it('the read-back opens to the same phrase and derives the native address', async () => {
		const { stores, read, write } = memoryStores({})
		await write(await wrapForDisk(stores, recoveredPageRecord(seed, PHRASE, BLOB)))
		const opened = await openWalletForStartup(stores, read() as Loose)
		expect(opened.status).toBe('loaded')
		const back = (opened as { data: Loose }).data
		expect(back.mnemonicPhrase).toBe(PHRASE)
		expect(ethers.Wallet.fromPhrase(String(back.mnemonicPhrase)).address.toLowerCase()).toBe(EOA)
		expect(checkRecoveredRecord(back, EOA)).toBe('valid')
	})

	it('a read-back for another account is a mismatch, and a record without a phrase is missing', () => {
		expect(checkRecoveredRecord({ mnemonicPhrase: PHRASE }, '0x' + '1'.repeat(40))).toBe('mismatch')
		expect(checkRecoveredRecord({ profiles: [] }, EOA)).toBe('missing')
		expect(checkRecoveredRecord(null, EOA)).toBe('missing')
	})
})

describe('checkShellReadBack (review 2026-11-17): the shell read-back compares the keyID, never requires the phrase', () => {
	const { checkShellReadBack } = jest.requireActual<typeof import('./recoveredMnemonicRecord')>('./recoveredMnemonicRecord')
	const EOA = '0x9858effd232b4033e47d90003d41ec34ecaeda94'
	it('a stripped read-back (no mnemonicPhrase) with the matching keyID is valid', () => {
		expect(checkShellReadBack({ profiles: [{ keyID: EOA }], beamio: {} }, EOA)).toBe('valid')
	})
	it('a keyID in another case still matches (lower-cased comparison)', () => {
		expect(checkShellReadBack({ profiles: [{ keyID: EOA.toUpperCase().replace('0X', '0x') }] }, EOA)).toBe('valid')
	})
	it('no profile is missing; another account is mismatch', () => {
		expect(checkShellReadBack({ beamio: {} }, EOA)).toBe('missing')
		expect(checkShellReadBack(null, EOA)).toBe('missing')
		expect(checkShellReadBack({ profiles: [{ keyID: '0x' + '1'.repeat(40) }] }, EOA)).toBe('mismatch')
	})
	it('the browser check still requires the phrase (unchanged)', () => {
		const { checkRecoveredRecord } = jest.requireActual<typeof import('./recoveredMnemonicRecord')>('./recoveredMnemonicRecord')
		expect(checkRecoveredRecord({ profiles: [{ keyID: EOA }] }, EOA)).toBe('missing')
	})
})
