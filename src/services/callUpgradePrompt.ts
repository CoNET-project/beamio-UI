/**
 * The update prompt of an old shell, shown only when the user taps the call button in the chat (never as a standing banner).
 * The official consumer channels are fixed here; the user opens one by tapping it. Nothing opens by itself.
 */
import { callAllowed, type CallCapabilityState } from './callCapability'

export type UpgradeLink = { id: 'app_store' | 'website' | 'google_play'; url: string; labelKey: string }

export const APP_STORE_URL = 'https://apps.apple.com/us/app/beamio-smart-local-pass/id6755375110'
export const ANDROID_WEBSITE_APK_URL = 'https://beamio.ca/beamio-android.apk'
export const GOOGLE_PLAY_URL = 'https://play.google.com/store/apps/details?id=com.beamio.app'

const APP_STORE: UpgradeLink = { id: 'app_store', url: APP_STORE_URL, labelKey: 'call.upgrade.link.app_store' }
const WEBSITE: UpgradeLink = { id: 'website', url: ANDROID_WEBSITE_APK_URL, labelKey: 'call.upgrade.link.website' }
const GOOGLE_PLAY: UpgradeLink = { id: 'google_play', url: GOOGLE_PLAY_URL, labelKey: 'call.upgrade.link.google_play' }

/** iOS: one entry. Android: two separate entries. An old shell whose platform cannot be told shows all three. */
export function upgradeLinksFor(host: 'ios' | 'android' | null): UpgradeLink[] {
	if (host === 'ios') return [APP_STORE]
	if (host === 'android') return [WEBSITE, GOOGLE_PLAY]
	return [APP_STORE, WEBSITE, GOOGLE_PLAY]
}

/**
 * The tap on the call button, decided on the capability state the page already holds:
 * - old_shell: the prompt shows and the tap returns before any dial step (no bridge call, no signalling);
 * - browser or compatible: the existing dial flow; loading: the button is already disabled, and the flow's own gate still refuses a call.
 */
export function dialTapAction(state: CallCapabilityState): 'prompt_upgrade' | 'dial' {
	if (state === 'old_shell') return 'prompt_upgrade'
	return callAllowed(state) || state === 'loading' ? 'dial' : 'prompt_upgrade'
}

/**
 * The state of the chat call button.
 * - An old shell: always enabled, whatever the peer's presence (a tap shows the update prompt and dials nothing); its label says to update.
 * - A new shell and a browser: enabled by presence or a wakeable native peer, as before; busy while a call is running or the capability is checked.
 */
export function callButtonView(input: { oldShell: boolean; online: boolean; nativeWakeable?: boolean; callBusy?: boolean }): {
	canPlaceCall: boolean
	disabled: boolean
	label: 'update_app' | 'unavailable' | 'calling' | 'start'
} {
	if (input.oldShell && !input.callBusy) return { canPlaceCall: true, disabled: false, label: 'update_app' }
	const canPlaceCall = input.online || !!input.nativeWakeable
	return {
		canPlaceCall,
		disabled: !canPlaceCall || !!input.callBusy,
		label: !canPlaceCall ? 'unavailable' : input.callBusy ? 'calling' : 'start',
	}
}
