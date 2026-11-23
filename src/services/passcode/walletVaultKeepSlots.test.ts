/**
 * @jest-environment node
 *
 * The keep rule of the write layer (0.53.39, independent review): a slot that is empty in memory keeps the stored value, whether
 * that is a wrap record or a plain non-empty string (an old plaintext key). Synthetic values only (no real key).
 */
import { keepStoredSecretsForEmptySlots } from './walletVault'

const KEY = '0x' + '11'.repeat(32) // synthetic
const EOA = '0x' + '22'.repeat(20)

describe('keepStoredSecretsForEmptySlots (the write keeps a stored key when memory is empty)', () => {
	it('an old plaintext key on disk survives a write made while the in-memory slot is empty', () => {
		const stored = { profiles: [{ keyID: EOA, privateKeyArmor: KEY }] }
		const out = { profiles: [{ keyID: EOA, privateKeyArmor: '' }] }
		const written = keepStoredSecretsForEmptySlots(out, stored)
		expect((written as { profiles: { privateKeyArmor: string }[] }).profiles[0].privateKeyArmor).toBe(KEY)
	})

	it('a wrap record on disk survives the same write (the earlier rule, unchanged; v3 passcode shape)', () => {
		// the shape isWrapRecord checks (synthetic fields; not a real ciphertext)
		const wrap = { v: 3, mode: 'passcode', kdf: 'argon2id-aes256gcm/m32768/t3/p1', salt: 'c3ludGhldGljLXNhbHQ=', ct: 'synthetic-ct', iv: 'synthetic-iv', eoa: EOA }
		const stored = { profiles: [{ keyID: EOA, privateKeyArmor: wrap }] }
		const out = { profiles: [{ keyID: EOA, privateKeyArmor: '' }] }
		const written = keepStoredSecretsForEmptySlots(out, stored) as { profiles: { privateKeyArmor: unknown }[] }
		expect(written.profiles[0].privateKeyArmor).toBe(wrap)
	})

	it('a non-empty in-memory slot is never replaced by the stored value', () => {
		const stored = { profiles: [{ keyID: EOA, privateKeyArmor: KEY }] }
		const newer = '0x' + '33'.repeat(32)
		const out = { profiles: [{ keyID: EOA, privateKeyArmor: newer }] }
		const written = keepStoredSecretsForEmptySlots(out, stored) as { profiles: { privateKeyArmor: string }[] }
		expect(written.profiles[0].privateKeyArmor).toBe(newer)
	})

	it('nothing stored and nothing in memory: the slot stays empty (nothing is invented)', () => {
		const out = { profiles: [{ keyID: EOA, privateKeyArmor: '' }] }
		const written = keepStoredSecretsForEmptySlots(out, { profiles: [{ keyID: EOA }] }) as { profiles: { privateKeyArmor: string }[] }
		expect(written.profiles[0].privateKeyArmor).toBe('')
	})

	it('multi-account: each slot keeps its own stored value', () => {
		const KEY_B = '0x' + '44'.repeat(32)
		const EOA_B = '0x' + '55'.repeat(20)
		const stored = { profiles: [{ keyID: EOA, privateKeyArmor: KEY }, { keyID: EOA_B, privateKeyArmor: KEY_B }] }
		const out = { profiles: [{ keyID: EOA, privateKeyArmor: '' }, { keyID: EOA_B, privateKeyArmor: '' }] }
		const written = keepStoredSecretsForEmptySlots(out, stored) as { profiles: { privateKeyArmor: string }[] }
		expect(written.profiles.map((p) => p.privateKeyArmor)).toEqual([KEY, KEY_B])
	})

	it('a wrap made in memory for the slot is kept over the stored plain value (no plaintext is written back)', () => {
		const stored = { profiles: [{ keyID: EOA, privateKeyArmor: KEY }] }
		const newWrap = { v: 3, mode: 'passcode', kdf: 'argon2id-aes256gcm/m32768/t3/p1', salt: 'c3ludGhldGljLXNhbHQ=', ct: 'new-synthetic-ct', iv: 'new-synthetic-iv', eoa: EOA }
		const out = { profiles: [{ keyID: EOA, privateKeyArmor: newWrap }] }
		const written = keepStoredSecretsForEmptySlots(out, stored) as { profiles: { privateKeyArmor: unknown }[] }
		expect(written.profiles[0].privateKeyArmor).toBe(newWrap)
	})

	it('control: the previous rule (before 3bd71a4) drops an old plaintext key on a write with an empty memory slot', () => {
		// the previous rule, reproduced here only as the control: it kept a stored value only when that value was a wrap record
		const oldRule = (out: { profiles: Array<{ privateKeyArmor: unknown }> }, stored: { profiles: Array<{ privateKeyArmor: unknown }> }) => {
			const written = JSON.parse(JSON.stringify(out))
			const kept = stored.profiles[0].privateKeyArmor
			const isWrap = typeof kept === 'object' && kept !== null && (kept as { v?: unknown }).v === 1
			if (written.profiles[0].privateKeyArmor === '' && isWrap) written.profiles[0].privateKeyArmor = kept
			return written
		}
		const stored = { profiles: [{ keyID: EOA, privateKeyArmor: KEY }] }
		const out = { profiles: [{ keyID: EOA, privateKeyArmor: '' }] }
		expect((oldRule(out, stored) as { profiles: { privateKeyArmor: unknown }[] }).profiles[0].privateKeyArmor).toBe('') // dropped by the old rule
		expect((keepStoredSecretsForEmptySlots(out, stored) as { profiles: { privateKeyArmor: unknown }[] }).profiles[0].privateKeyArmor).toBe(KEY) // kept now
	})

	it('pairing is by keyID, not by position: the account order reversed keeps each account its own key (independent review 4fd31f0a)', () => {
		const KEY_B = '0x' + '44'.repeat(32)
		const EOA_B = '0x' + '55'.repeat(20)
		// stored: A then B. memory: B then A (empty slots). Each account must get its own stored key back.
		const stored = { profiles: [{ keyID: EOA, privateKeyArmor: KEY }, { keyID: EOA_B, privateKeyArmor: KEY_B }] }
		const out = { profiles: [{ keyID: EOA_B, privateKeyArmor: '' }, { keyID: EOA, privateKeyArmor: '' }] }
		const written = keepStoredSecretsForEmptySlots(out, stored) as { profiles: { keyID: string; privateKeyArmor: string }[] }
		const byId = Object.fromEntries(written.profiles.map((p) => [p.keyID, p.privateKeyArmor]))
		expect(byId[EOA]).toBe(KEY)
		expect(byId[EOA_B]).toBe(KEY_B)
	})

	it('an account with no key in the store never receives another account\'s key (the cross-account write the review reproduced)', () => {
		const KEY_B = '0x' + '44'.repeat(32)
		const EOA_B = '0x' + '55'.repeat(20)
		// stored: only B holds a key. memory: A (empty, no stored key) then B (empty).
		const stored = { profiles: [{ keyID: EOA_B, privateKeyArmor: KEY_B }] }
		const out = { profiles: [{ keyID: EOA, privateKeyArmor: '' }, { keyID: EOA_B, privateKeyArmor: '' }] }
		const written = keepStoredSecretsForEmptySlots(out, stored) as { profiles: { keyID: string; privateKeyArmor: string }[] }
		const byId = Object.fromEntries(written.profiles.map((p) => [p.keyID, p.privateKeyArmor]))
		expect(byId[EOA]).toBe('') // A must not get B's key
		expect(byId[EOA_B]).toBe(KEY_B)
	})
})
