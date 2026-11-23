/**
 * @jest-environment node
 */
/**
 * and: the reuse invariant (EOA and private-key hash unchanged), at run time.
 * SYNTHETIC wallets only; no network, no chain.
 */
import { ethers } from 'ethers'
import { reuseKeepsKey } from './reuseKeepsKey'
// 模块加载桩：beamio.ts 静态导入 argon2WorkerBridge（import.meta，Jest 无法加载）。本用例不派生 KDF，不提供 argon2idAsync。
jest.mock('@/services/argon2WorkerBridge', () => ({}))
// Same for the BeamioTag search worker (beamio.ts imports it for the lookup path only).
jest.mock('@/services/beamioTagWorkerBridge', () => ({ searchBeamioTagRemote: jest.fn() }))
import { ensureProfilePrivateKeyArmorFromMnemonic } from './beamio'

const hashOf = (s: string) => ethers.id(s)

const walletWith = (w: ethers.HDNodeWallet | ethers.Wallet, phrase?: string) => ({
	mnemonicPhrase: phrase,
	profiles: [{ keyID: w.address, privateKeyArmor: w.privateKey, publicKeyArmor: w.signingKey.publicKey }],
	beamio: {},
}) as any

describe('reuseKeepsKey (pure)', () => {
	it('the same EOA and the same private key: kept', () => {
		const w = ethers.Wallet.createRandom()
		const before = walletWith(w)
		expect(reuseKeepsKey(before, walletWith(w))).toBe(true)
	})
	it('a different private key with the same EOA field: not kept', () => {
		const w = ethers.Wallet.createRandom()
		const other = ethers.Wallet.createRandom()
		expect(reuseKeepsKey(walletWith(w), { profiles: [{ keyID: w.address, privateKeyArmor: other.privateKey }] })).toBe(false)
	})
	it('a different EOA: not kept', () => {
		const w = ethers.Wallet.createRandom()
		const other = ethers.Wallet.createRandom()
		expect(reuseKeepsKey(walletWith(w), { profiles: [{ keyID: other.address, privateKeyArmor: w.privateKey }] })).toBe(false)
	})
	it('no key after the step: not kept (never a silent empty result)', () => {
		const w = ethers.Wallet.createRandom()
		expect(reuseKeepsKey(walletWith(w), { profiles: [{ keyID: w.address }] })).toBe(false)
		expect(reuseKeepsKey(walletWith(w), null)).toBe(false)
	})
	it('a record with only a recovery phrase may gain its key by derivation, EOA must match', () => {
		const w = ethers.Wallet.createRandom()
		const phraseOnly = { mnemonicPhrase: w.mnemonic?.phrase, profiles: [{ keyID: w.address }] } as any
		expect(reuseKeepsKey(phraseOnly, { profiles: [{ keyID: w.address, privateKeyArmor: w.privateKey }] })).toBe(true)
		const other = ethers.Wallet.createRandom()
		expect(reuseKeepsKey(phraseOnly, { profiles: [{ keyID: other.address, privateKeyArmor: other.privateKey }] })).toBe(false)
	})
})

describe('reuse step on the real beamio module: EOA and private-key hash unchanged before and after entering the create page', () => {
	it('a record with a key and a recovery phrase keeps its EOA and key hash through ensureProfilePrivateKeyArmorFromMnemonic', () => {
		const w = ethers.Wallet.createRandom()
		const record = walletWith(w, w.mnemonic?.phrase)
		const before = { eoa: record.profiles[0].keyID, keyHash: hashOf(record.profiles[0].privateKeyArmor) }
		const after = ensureProfilePrivateKeyArmorFromMnemonic(record)
		expect(reuseKeepsKey(record, after)).toBe(true)
		expect(after?.profiles?.[0]?.keyID).toBe(before.eoa)
		expect(hashOf(after?.profiles?.[0]?.privateKeyArmor ?? '')).toBe(before.keyHash)
	})
	it('a record with a key and no recovery phrase is returned unchanged', () => {
		const w = ethers.Wallet.createRandom()
		const record = walletWith(w)
		const after = ensureProfilePrivateKeyArmorFromMnemonic(record)
		expect(reuseKeepsKey(record, after)).toBe(true)
		expect(hashOf(after?.profiles?.[0]?.privateKeyArmor ?? '')).toBe(hashOf(w.privateKey))
	})
})
