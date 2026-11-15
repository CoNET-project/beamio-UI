/**
 * (items 2 and 3): the entry gate's native no-key decision as a small state machine. The gate component
 * only forwards its events here, so the timing (ok answer, ready event, late no_key) can be tested without rendering.
 *
 *   decide()            the gate has made its decision
 *   storageRead(empty)  the page store was read: true only for a successful read that holds no account
 *   established()       a wallet exists now (ok answer of a creation or restore, a native wallet, or a page account)
 *   beginNativeFlow()   a native create or recovery page opened: the import route must not cover it
 *   endNativeFlow()     that page closed (cancelled or unmounted) without an ok answer
 *   onNativeNoKey()     a native no_key answer arrived: true when the import route must show now
 *   capabilityResolved(native)  the shell's hello answer arrived (native = the shell declared identity.native-keys.v1);
 *                               true when a no_key held back before the answer must show the import route now
 *
 * G1 (option A): the import route is for a shell that holds native keys. Until the hello answer
 * is known the capability is `unknown`, and a no_key that arrives then is held back, not shown. A shell without the
 * capability (`blocked`, including a hello that timed out and resolved to a non-native state) never shows it.
 */
import { nativeNoKeyTakesOver } from './appEntryNoKeyPolicy'

type ChatCapability = 'unknown' | 'native' | 'blocked'

export class AppEntryNoKeyController {
	private gateDecided = false
	private walletEstablished = false
	private storageConfirmedEmpty = false
	private nativeFlowOpen = false
	private capability: ChatCapability = 'unknown'
	private noKeyWhileUnknown = false

	decide(): void {
		this.gateDecided = true
	}

	storageRead(empty: boolean): void {
		this.storageConfirmedEmpty = empty && !this.walletEstablished
	}

	established(): void {
		this.walletEstablished = true
		this.storageConfirmedEmpty = false
		this.nativeFlowOpen = false
	}

	beginNativeFlow(): void {
		this.nativeFlowOpen = true
	}

	endNativeFlow(): void {
		this.nativeFlowOpen = false
	}

	onNativeNoKey(): boolean {
		if (this.capability === 'blocked') return false
		if (this.capability === 'unknown') {
			// The entry policy is judged when the signal arrives; only the capability answer is deferred.
			if (this.takesOver()) this.noKeyWhileUnknown = true
			return false
		}
		return this.takesOver()
	}

	capabilityResolved(native: boolean): boolean {
		this.capability = native ? 'native' : 'blocked'
		const held = this.noKeyWhileUnknown
		this.noKeyWhileUnknown = false
		return native && held && this.takesOver()
	}

	private takesOver(): boolean {
		return nativeNoKeyTakesOver({
			gateDecided: this.gateDecided,
			walletEstablished: this.walletEstablished,
			storageConfirmedEmpty: this.storageConfirmedEmpty,
			nativeFlowOpen: this.nativeFlowOpen,
		})
	}
}
