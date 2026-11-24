/**
 * @jest-environment node
 */
/**
 * The chat call button on an old shell: the prompt opens on the tap and the tap returns before any dial step; the standing banner is gone.
 * Source pins (the dial flow itself needs a device; see the device acceptance of this change).
 */
import * as fs from 'fs'
import * as path from 'path'

const chat = fs.readFileSync(path.join(__dirname, 'chat.tsx'), 'utf8')

describe('chat call button on an old shell', () => {
	const start = chat.indexOf('const startVoiceCall = useCallback(')
	const body = chat.slice(start, start + 20000)
	it('the tap decision is the first thing after the in-flight guard, before timing, prepare, audio and any bridge request', () => {
		const guard = body.indexOf("dialTapAction(getCallCapabilityState()) === 'prompt_upgrade'")
		expect(guard).toBeGreaterThan(0)
		for (const later of ['beginCallTiming(', "dispatchNativeSystemCallAction('prepareSystemCall'", 'armVoicePlayback()', 'getUserMedia', 'resolveTrustedRoute(', 'probeCallCapabilityNow(']) {
			expect(body.indexOf(later)).toBeGreaterThan(guard)
		}
		const block = body.slice(guard, guard + 200)
		expect(block).toMatch(/setShowCallUpgrade\(true\)\s*return/)
	})
	it('the standing banner for an old shell is removed; the dialog is mounted and nothing opens a link by itself', () => {
		expect(chat).not.toMatch(/callCapState === 'old_shell' \? \(/)
		expect(chat).not.toMatch(/<span>\{tu\('call\.upgrade\.chat'\)\}<\/span>/)
		expect(chat).toMatch(/\{showCallUpgrade \? <CallUpgradeDialog onClose=\{\(\) => setShowCallUpgrade\(false\)\} \/> : null\}/)
		const dialog = fs.readFileSync(path.join(__dirname, '../../components/CallUpgradeDialog.tsx'), 'utf8')
		expect(dialog.match(/openExternalUrl\(/g)).toHaveLength(1)
		expect(dialog).toMatch(/onClick=\{\(\) => openExternalUrl\(l\.url\)\}/)
		expect(dialog).not.toMatch(/useEffect|window\.open|location\./)
	})
	it('the incoming direction is untouched: the answer path keeps its own capability gate and message', () => {
		expect(chat).toMatch(/setVoiceError\(tu\('call\.upgrade\.incoming'\)\)/)
		expect(chat).toMatch(/if \(!callAllowed\(await probeCallCapabilityNow\(\)\)\) \{\n\t\t\t\/\/ Fail closed and visible \(the decision\): the incoming call/)
	})
	it('the header gets the old-shell state, so the button stays tappable offline; the tap path is the guarded one', () => {
		expect(chat).toMatch(/oldShell=\{callCapState === 'old_shell'\}/)
		const header = fs.readFileSync(path.join(__dirname, 'components/ChatHeaderIOS.tsx'), 'utf8')
		expect(header).toMatch(/callButtonView\(\{ oldShell: !!oldShell, online, nativeWakeable, callBusy \}\)/)
		expect(header).toMatch(/disabled=\{view\.disabled\}/)
		expect(header).not.toMatch(/disabled=\{!canPlaceCall/)
	})
})
