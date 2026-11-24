/**
 * The old-shell update prompt (tap on the chat call button). Pure rules and the fixed links. SYNTHETIC values.
 */
import { ANDROID_WEBSITE_APK_URL, APP_STORE_URL, GOOGLE_PLAY_URL, dialTapAction, upgradeLinksFor } from './callUpgradePrompt'
import { callCapabilityStateOf, VOICE_CALL_V4_CAPABILITY } from './callCapability'

const NATIVE_APP = { platform: 'android', version: '1.5.8', build: '188' }
const hello = (over: Record<string, unknown>) => ({ answered: true, capabilities: [VOICE_CALL_V4_CAPABILITY], nativeApp: NATIVE_APP, ...over })

describe('the fixed official links', () => {
	it('iOS has one entry (App Store); Android has two separate entries (website APK, Google Play); the exact consumer URLs', () => {
		expect(upgradeLinksFor('ios').map((l) => l.url)).toEqual(['https://apps.apple.com/us/app/beamio-smart-local-pass/id6755375110'])
		expect(upgradeLinksFor('android').map((l) => [l.id, l.url])).toEqual([
			['website', 'https://beamio.ca/beamio-android.apk'],
			['google_play', 'https://play.google.com/store/apps/details?id=com.beamio.app'],
		])
		expect(APP_STORE_URL).toBe('https://apps.apple.com/us/app/beamio-smart-local-pass/id6755375110')
		expect(ANDROID_WEBSITE_APK_URL).toBe('https://beamio.ca/beamio-android.apk')
		expect(GOOGLE_PLAY_URL).toBe('https://play.google.com/store/apps/details?id=com.beamio.app')
	})
	it('an old shell of an unknown platform shows all three, each once', () => {
		expect(upgradeLinksFor(null).map((l) => l.id)).toEqual(['app_store', 'website', 'google_play'])
	})
	it('no link goes to a POS app or a retired domain', () => {
		for (const h of [null, 'ios', 'android'] as const) {
			for (const l of upgradeLinksFor(h)) {
				const u = new URL(l.url)
				expect(u.protocol).toBe('https:')
				expect(['apps.apple.com', 'beamio.ca', 'play.google.com']).toContain(u.hostname)
				expect(l.url).not.toMatch(/pos|cashtrees|softpos|silentpass/i)
			}
		}
	})
})

describe('the tap decision follows the existing old/new shell rule', () => {
	it('an old iOS shell (hello without voiceCallV4, e.g. iOS 110) and an old Android shell: the tap prompts', () => {
		for (const platform of ['ios', 'android']) {
			const s = callCapabilityStateOf({ inShell: true, probe: hello({ capabilities: ['identity.native-keys.v1'], nativeApp: { ...NATIVE_APP, platform } }) })
			expect(s).toBe('old_shell')
			expect(dialTapAction(s)).toBe('prompt_upgrade')
		}
	})
	it('a shell whose hello has no valid native version (missing, wrong format, wrong platform): the tap prompts', () => {
		for (const nativeApp of [undefined, null, {}, { platform: 'ios', version: 'x', build: '1' }, { platform: 'windows', version: '1.0', build: '1' }, { platform: 'ios', version: '1.5.8', build: '' }]) {
			const s = callCapabilityStateOf({ inShell: true, probe: hello({ nativeApp }) })
			expect(s).toBe('old_shell')
			expect(dialTapAction(s)).toBe('prompt_upgrade')
		}
	})
	it('an unanswered, failed or timed-out hello in a shell: the tap prompts', () => {
		expect(dialTapAction(callCapabilityStateOf({ inShell: true, probe: 'failed' }))).toBe('prompt_upgrade')
		expect(dialTapAction(callCapabilityStateOf({ inShell: true, probe: { answered: false, capabilities: [] } }))).toBe('prompt_upgrade')
	})
	it('a new shell (voiceCallV4 and a valid native version), iOS and Android: the existing dial, no prompt', () => {
		for (const platform of ['ios', 'android']) {
			const s = callCapabilityStateOf({ inShell: true, probe: hello({ nativeApp: { ...NATIVE_APP, platform } }) })
			expect(s).toBe('compatible')
			expect(dialTapAction(s)).toBe('dial')
		}
	})
	it('a plain browser is never an old shell, with or without a native version: the existing dial, no prompt', () => {
		for (const probe of ['pending', 'failed', { answered: false, capabilities: [] }, hello({ nativeApp: undefined })] as const) {
			const s = callCapabilityStateOf({ inShell: false, probe })
			expect(s).toBe('browser')
			expect(dialTapAction(s)).toBe('dial')
		}
	})
	it('a shell still checking is not prompted (the button is disabled; the dial flow gate still refuses a call)', () => {
		expect(dialTapAction(callCapabilityStateOf({ inShell: true, probe: 'pending' }))).toBe('dial')
	})
})

import { callButtonView } from './callUpgradePrompt'

describe('the chat call button state', () => {
  it('an old shell: always enabled, peer offline and not wakeable included, labelled to update', () => {
    for (const online of [true, false]) {
      for (const nativeWakeable of [true, false, undefined]) {
        expect(callButtonView({ oldShell: true, online, nativeWakeable, callBusy: false })).toEqual({ canPlaceCall: true, disabled: false, label: 'update_app' })
      }
    }
  })
  it('a new shell or a browser (not old): still decided by presence or a wakeable peer', () => {
    expect(callButtonView({ oldShell: false, online: false, nativeWakeable: false })).toEqual({ canPlaceCall: false, disabled: true, label: 'unavailable' })
    expect(callButtonView({ oldShell: false, online: true })).toEqual({ canPlaceCall: true, disabled: false, label: 'start' })
    expect(callButtonView({ oldShell: false, online: false, nativeWakeable: true })).toEqual({ canPlaceCall: true, disabled: false, label: 'start' })
    expect(callButtonView({ oldShell: false, online: true, callBusy: true })).toEqual({ canPlaceCall: true, disabled: true, label: 'calling' })
  })
})
