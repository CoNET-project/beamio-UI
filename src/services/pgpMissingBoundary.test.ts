/**
 * PG-01 to PG-06 (pgpMissingBoundaryCases in pgp-migration-vectors.v2.json, sha256 3ced6796…e613). SYNTHETIC values only.
 * The PGP signals (pgpReady, pgpUpgradeState, pgp_source_unavailable) decide chat only. The account is judged by the mnemonic
 *presence logic never reads the PGP signals, and walletStatus without its status key is unknown.
 */
import { chatEnabledOf } from './chatCryptoAvailability'
import { decideAccountReset, idbPresenceOf, nativePresenceOfState, parseWalletStatusResult } from './accountPresence'

const isAddress = (v: string) => /^0x[0-9a-fA-F]{40}$/.test(v)
const EOA = '0x1111111111111111111111111111111111111111'

describe('PGP missing boundary (PG-01 to PG-06)', () => {
	it('PG-01: PGP missing, the mnemonic is present: the account continues; chat is disabled; no account loss', () => {
		// The mnemonic (native has, IndexedDB present) decides: continue_account. The PGP signals are not an input.
		expect(decideAccountReset({ idb: idbPresenceOf('valid_mnemonic'), native: nativePresenceOfState({ status: 'not_ready', notReadyReason: 'g1_uninitialized' }, undefined), userConfirmedRecovery: false, newAccountEstablished: false })).toBe('continue_account')
		expect(chatEnabledOf({ pgpReady: false })).toBe(false)
	})

	it('PG-02: PGP missing, IndexedDB and native confirm no mnemonic: onboarding (the mnemonic decides); chat is disabled', () => {
		expect(decideAccountReset({ idb: idbPresenceOf('absent'), native: nativePresenceOfState({ status: 'no_key' }, false), userConfirmedRecovery: false, newAccountEstablished: false })).toBe('onboarding')
		expect(chatEnabledOf({ pgpReady: false })).toBe(false)
	})

	it('PG-03: pgpUpgradeState pgp_migration_retry, the mnemonic is present: the account continues; chat is disabled', () => {
		expect(decideAccountReset({ idb: idbPresenceOf('absent'), native: nativePresenceOfState({ status: 'not_ready', notReadyReason: 'g1_uninitialized' }, undefined), userConfirmedRecovery: false, newAccountEstablished: false })).toBe('continue_account')
		expect(chatEnabledOf({ pgpReady: true, pgpUpgradeState: 'pgp_migration_retry' })).toBe(false)
	})

	it('PG-04: PGP complete, the mnemonic is present: the account continues; chat is enabled', () => {
		expect(decideAccountReset({ idb: idbPresenceOf('valid_mnemonic'), native: nativePresenceOfState({ status: 'not_ready', notReadyReason: 'g1_uninitialized' }, undefined), userConfirmedRecovery: false, newAccountEstablished: false })).toBe('continue_account')
		expect(chatEnabledOf({ pgpReady: true, pgpUpgradeState: 'upgraded_from_L' })).toBe(true)
	})

	it('pgp_source_unavailable disables chat only; it never decides the account', () => {
		expect(chatEnabledOf({ pgpReady: true, pgpSourceUnavailable: true })).toBe(false)
		expect(decideAccountReset({ idb: idbPresenceOf('valid_mnemonic'), native: 'has', userConfirmedRecovery: false, newAccountEstablished: false })).toBe('continue_account')
	})

	it('PG-05: walletStatus locked and the status key missing: unknown, not has, not onboarding', () => {
		const parsed = parseWalletStatusResult({ accountKey: EOA + ':default' }, isAddress)
		expect(parsed).toEqual({ status: 'unknown' })
		expect(nativePresenceOfState(parsed, undefined)).toBe('unknown')
		expect(decideAccountReset({ idb: 'confirmed_none', native: nativePresenceOfState(parsed, undefined), userConfirmedRecovery: false, newAccountEstablished: false })).toBe('retry_unknown')
	})

	it('PG-06: walletStatus locked with the status key present (passcode lock): unknown, never a release (LK-P7)', () => {
		const parsed = parseWalletStatusResult({ status: 'locked', accountKey: EOA + ':default' }, isAddress)
		expect(parsed).toEqual({ status: 'locked', eoa: EOA })
		expect(nativePresenceOfState(parsed, undefined)).toBe('unknown')
	})

	it('a status key that is not a known state, or a locked answer without a valid account key, is unknown', () => {
		expect(parseWalletStatusResult({ status: 'weird', accountKey: EOA + ':default' }, isAddress)).toEqual({ status: 'unknown' })
		expect(parseWalletStatusResult({ status: 'locked', accountKey: 'not-an-address:default' }, isAddress)).toEqual({ status: 'unknown' })
		expect(parseWalletStatusResult(null, isAddress)).toEqual({ status: 'unknown' })
	})
})
