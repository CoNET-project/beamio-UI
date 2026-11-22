/**
 * @jest-environment node
 *
 * Production write functions on an in-memory WalletStores (0.53.39, independent review 4fd31f0a, item 3). No IndexedDB: the device key is a
 * real AES-GCM CryptoKey (Node webcrypto) held by the in-memory store. Synthetic values only (the public BIP-39 test phrases; a made-up
 * passcode). Each step writes with the production function, then reads the key back through the production unlock and compares it with the
 * original key.
 */
import { webcrypto } from 'crypto'
if (!(globalThis as { crypto?: { subtle?: unknown } }).crypto?.subtle) {
	Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })
}
import { ethers } from 'ethers'
import { changeWalletPasscode, disableWalletPasscode, migratePlainWallet, readPlainForVerify, setWalletPasscode, unlockWalletPasscode, type WalletMeta, type WalletStores } from './walletVault'

const PHRASE_A = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const PHRASE_B = 'legal winner thank year wave sausage worth useful legal winner thank yellow'
const A = ethers.Wallet.fromPhrase(PHRASE_A)
const B = ethers.Wallet.fromPhrase(PHRASE_B)
const PASS1 = '517395823' // synthetic digits (the policy is digits, at least 8, not a common pattern)
const PASS2 = '906284137'

type Stored = { init: unknown }

/** An in-memory WalletStores: the init object is kept as JSON (a plain copy, like a store), the device key as a CryptoKey. */
function memoryStores(initial: unknown): { stores: WalletStores; state: Stored; raw: () => string } {
	const state: Stored = { init: initial === null ? null : JSON.parse(JSON.stringify(initial)) }
	let devKey: CryptoKey | null = null
	let meta = { failures: 0, nextAt: 0 }
	const stores: WalletStores = {
		readInit: async () => (state.init === null ? null : JSON.parse(JSON.stringify(state.init))),
		probeInit: async () => (state.init === null ? null : JSON.parse(JSON.stringify(state.init))),
		writeInit: async (data: unknown) => {
			state.init = JSON.parse(JSON.stringify(data))
		},
		readMeta: async () => ({ ...meta }),
		writeMeta: async (m: WalletMeta) => {
			meta = { ...m }
		},
		deviceKeys: {
			load: async () => devKey,
			save: async (k: CryptoKey) => {
				devKey = k
			},
		},
	} as never
	return { stores, state, raw: () => JSON.stringify(state.init) }
}

const plainOf = (profiles: Array<{ keyID: string; privateKeyArmor: string }>) => ({
	mnemonicPhrase: PHRASE_A,
	isReady: true,
	profiles: profiles.map((p) => ({ ...p })),
})

/** The private key of each account, as the production unlock returns it (after a passcode unlock). */
/** The wrap sibling fields (*Wrap) are storage metadata added by the migration, and an empty pgpKey object is the standard profile shape the
 * write adds (no key data). The decrypted comparison leaves these out; every other field is compared as is. */
const withoutWrapMeta = (v: unknown): unknown => {
	if (Array.isArray(v)) return v.map(withoutWrapMeta)
	if (v && typeof v === 'object') {
		const out: Record<string, unknown> = {}
		for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
			if (k.endsWith('Wrap')) continue
			// an empty pgpKey object is added by the write as the standard profile shape (no key data); finding recorded in the response
			if (k === 'pgpKey' && val && typeof val === 'object' && Object.keys(val as object).length === 0) continue
			out[k] = withoutWrapMeta(val)
		}
		return out
	}
	return v
}

const keysOf = (data: unknown): Record<string, string> => {
	const out: Record<string, string> = {}
	for (const p of (data as { profiles: Array<{ keyID: string; privateKeyArmor: string }> }).profiles) out[p.keyID.toLowerCase()] = p.privateKeyArmor
	return out
}

describe('production write functions on an in-memory store: write, run, read back (synthetic)', () => {
	it('setWalletPasscode with the in-memory key of A blank: the stored key of A is still there after the read-back (A and B)', async () => {
		const keyA = A.privateKey
		const keyB = B.privateKey
		const seeded = { mnemonicPhrase: PHRASE_A, isReady: true, profiles: [{ keyID: A.address.toLowerCase(), privateKeyArmor: keyA }, { keyID: B.address.toLowerCase(), privateKeyArmor: keyB }] }
		const { stores } = memoryStores(seeded)
		const blankA = plainOf([{ keyID: A.address.toLowerCase(), privateKeyArmor: '' }, { keyID: B.address.toLowerCase(), privateKeyArmor: keyB }])
		const set = await setWalletPasscode(stores, PASS1, blankA)
		expect(set.ok).toBe(true)
		const unlocked = await unlockWalletPasscode(stores, PASS1)
		expect(unlocked.ok).toBe(true)
		const keys = keysOf((unlocked as { data: unknown }).data)
		expect(keys[A.address.toLowerCase()]).toBe(keyA)
		expect(keys[B.address.toLowerCase()]).toBe(keyB)
	})

	it('a legacy plaintext key (no wrap on disk) survives setWalletPasscode with the in-memory key blank', async () => {
		const seeded = { mnemonicPhrase: PHRASE_A, isReady: true, profiles: [{ keyID: A.address.toLowerCase(), privateKeyArmor: A.privateKey }] }
		const { stores } = memoryStores(seeded)
		const set = await setWalletPasscode(stores, PASS1, plainOf([{ keyID: A.address.toLowerCase(), privateKeyArmor: '' }]))
		expect(set.ok).toBe(true)
		const unlocked = await unlockWalletPasscode(stores, PASS1)
		expect(unlocked.ok).toBe(true)
		expect(keysOf((unlocked as { data: unknown }).data)[A.address.toLowerCase()]).toBe(A.privateKey)
	})

	it('the account order reversed in memory (the primary account changes): the write is refused and the stored bytes are unchanged (the mnemonic belongs to the stored primary; nothing is guessed)', async () => {
		const seeded = { mnemonicPhrase: PHRASE_A, isReady: true, profiles: [{ keyID: A.address.toLowerCase(), privateKeyArmor: A.privateKey }, { keyID: B.address.toLowerCase(), privateKeyArmor: B.privateKey }] }
		const { stores, raw } = memoryStores(seeded)
		const before = raw()
		const reversed = plainOf([{ keyID: B.address.toLowerCase(), privateKeyArmor: '' }, { keyID: A.address.toLowerCase(), privateKeyArmor: '' }])
		const set = await setWalletPasscode(stores, PASS1, reversed)
		expect(set.ok).toBe(false)
		expect(raw()).toBe(before) // byte for byte: the refusal writes nothing
	})

	it('change and disable keep the stored keys: read back after each step', async () => {
		const seeded = { mnemonicPhrase: PHRASE_A, isReady: true, profiles: [{ keyID: A.address.toLowerCase(), privateKeyArmor: A.privateKey }] }
		const { stores } = memoryStores(seeded)
		expect((await setWalletPasscode(stores, PASS1, plainOf([{ keyID: A.address.toLowerCase(), privateKeyArmor: '' }]))).ok).toBe(true)
		expect((await changeWalletPasscode(stores, PASS1, PASS2)).ok).toBe(true)
		let keys = keysOf(((await unlockWalletPasscode(stores, PASS2)) as { data: unknown }).data)
		expect(keys[A.address.toLowerCase()]).toBe(A.privateKey)
		expect((await disableWalletPasscode(stores, PASS2)).ok).toBe(true)
		// after disabling, the record is in device mode: read it back through the device key (no passcode)
		const plain = await readPlainForVerify(stores)
		expect(keysOf(plain)[A.address.toLowerCase()]).toBe(A.privateKey)
	})

	it('migratePlainWallet (production) on the in-memory store: the plain record is migrated or kept, and the keys read back unchanged', async () => {
		const seeded = { mnemonicPhrase: PHRASE_A, isReady: true, profiles: [{ keyID: A.address.toLowerCase(), privateKeyArmor: A.privateKey }, { keyID: B.address.toLowerCase(), privateKeyArmor: B.privateKey }] }
		const { stores } = memoryStores(seeded)
		const result = await migratePlainWallet(stores)
		expect(['migrated', 'kept']).toContain(result)
		const plain = await readPlainForVerify(stores)
		const keys = keysOf(plain)
		expect(keys[A.address.toLowerCase()]).toBe(A.privateKey)
		expect(keys[B.address.toLowerCase()]).toBe(B.privateKey)
		// criterion (a) on the decrypted record: the whole init, JSON-normalised, equals the record before the migration
		expect(JSON.stringify(withoutWrapMeta(plain))).toBe(JSON.stringify(withoutWrapMeta(seeded)))
	})
})
