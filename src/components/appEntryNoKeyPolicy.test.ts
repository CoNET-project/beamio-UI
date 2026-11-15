/**
 *. The native no-key signal shows the import route only when the gate
 * decided, no wallet is established, and the page store was read and is empty. Trigger orders covered: before the storage
 * read; after the read with an account; the empty control; storage unavailable; and a creation in the session followed by a
 * late no_key (the wallet stays, no import route).
 */
import { nativeNoKeyTakesOver } from './appEntryNoKeyPolicy'

describe('native no-key takeover policy', () => {
	it('order A: no_key before the storage read (gate undecided) never shows the import route', () => {
		expect(nativeNoKeyTakesOver({ gateDecided: false, walletEstablished: false, storageConfirmedEmpty: false })).toBe(false)
	})

	it('order A, then the storage read finds an account: the import route is never shown', () => {
		expect(nativeNoKeyTakesOver({ gateDecided: false, walletEstablished: false, storageConfirmedEmpty: false })).toBe(false)
		expect(nativeNoKeyTakesOver({ gateDecided: true, walletEstablished: true, storageConfirmedEmpty: false })).toBe(false)
	})

	it('order B: no_key after the storage read with an account: the import route is not shown', () => {
		expect(nativeNoKeyTakesOver({ gateDecided: true, walletEstablished: true, storageConfirmedEmpty: false })).toBe(false)
	})

	it('control C: decided, storage read and empty, no wallet: the import route is allowed', () => {
		expect(nativeNoKeyTakesOver({ gateDecided: true, walletEstablished: false, storageConfirmedEmpty: true })).toBe(true)
	})

	it('D: decided with storage unavailable (not confirmed empty): the import route never overrides it', () => {
		expect(nativeNoKeyTakesOver({ gateDecided: true, walletEstablished: false, storageConfirmedEmpty: false })).toBe(false)
	})

	it('E: onboarding (empty store), a creation succeeds in the session, then a late no_key: the wallet stays, no import route', () => {
		// The gate decided onboarding with an empty store; the wallet-ready event after creation sets walletEstablished and
		// clears storageConfirmedEmpty (the gate does both live). The late no_key must not take over.
		expect(nativeNoKeyTakesOver({ gateDecided: true, walletEstablished: false, storageConfirmedEmpty: true })).toBe(true)
		expect(nativeNoKeyTakesOver({ gateDecided: true, walletEstablished: true, storageConfirmedEmpty: false })).toBe(false)
	})

	it('F: a late no_key when the store was read empty but a native wallet is already present: never takes over', () => {
		expect(nativeNoKeyTakesOver({ gateDecided: true, walletEstablished: true, storageConfirmedEmpty: true })).toBe(false)
	})
})
