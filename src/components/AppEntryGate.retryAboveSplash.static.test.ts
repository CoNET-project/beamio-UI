/**
 * t168 (2026-11-22, FINDING): the start-up retry button is mounted while the splash is shown (splashVisible && startupRetryOffered),
 * but the splash is a full-screen opaque layer at z-[9999] (SplashScreen.tsx). A button at a lower z-index is hidden under it, so
 * the device showed only the loading ring. The retry container must sit above the splash layer. Static pin: removing this must fail.
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const src = readFileSync(join(__dirname, 'AppEntryGate.tsx'), 'utf8')
const splash = readFileSync(join(__dirname, 'SplashScreen.tsx'), 'utf8')

const zOf = (text: string, marker: string): number => {
	const at = text.indexOf(marker)
	if (at < 0) throw new Error(`marker not found: ${marker}`)
	const m = /z-\[(\d+)\]/.exec(text.slice(at, at + 200))
	if (!m) throw new Error(`no z-index near: ${marker}`)
	return Number(m[1])
}

describe('the start-up retry button is above the splash layer (t168 FINDING)', () => {
	it('the splash is the full-screen layer at z-[9999]', () => {
		expect(zOf(splash, 'fixed inset-0 z-[')).toBe(9999)
	})
	it('the retry container is shown while the splash is shown, and sits above it', () => {
		expect(src).not.toContain('{splashVisible && startupRetryOffered && (')  // 0.53.44: retired startup control (two-landing rule); must be absent
		const retryZ = zOf(src, 'fixed inset-x-0 bottom-10 z-[')
		expect(retryZ).toBeGreaterThan(zOf(splash, 'fixed inset-0 z-['))
	})
	it('the retry container keeps its retry and restore controls (no removal)', () => {
		expect(src).not.toContain('onClick={retryStartupNow}')  // 0.53.44: retired startup control (two-landing rule); must be absent
		expect(src).not.toContain('onClick={openRestoreFromHold}')  // 0.53.44: retired startup control (two-landing rule); must be absent
	})
})
