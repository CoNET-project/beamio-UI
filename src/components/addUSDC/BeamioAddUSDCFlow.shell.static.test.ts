/**
 * inside a shell the Coinbase deposit never shows the browser-only "browser blocked"screen. A failed or refused external
 * open shows the existing failure screen (coinbase_error, existing copy). Reads BeamioAddUSDCFlow.tsx only.
 */
import fs from 'fs'
import path from 'path'

const src = fs.readFileSync(path.join(__dirname, 'BeamioAddUSDCFlow.tsx'), 'utf8')

describe('the browser-blocked screen is browser-only', () => {
	it('a failed open inside a shell goes to coinbase_error; the browser keeps coinbase', () => {
		expect(src).toContain("setScreen(shell ? 'coinbase_error' : 'coinbase')")
	})

	it('a refusal reported by the shell after the send shows the existing failure screen', () => {
		const at = src.indexOf('navigateReservedOrOpenExternal(popup ?? peekReservedExternalWindow(), onrampUrl, () => {')
		expect(at).toBeGreaterThan(0)
		expect(src.slice(at, at + 420)).toContain("setScreen('coinbase_error')")
	})

	it('back and Try again inside a shell never go to the browser-only screen', () => {
		expect(src).toContain('setScreen(shellOwnsExternalUrls() ? "hub" : "coinbase")')
		expect(src).toContain('if (shellOwnsExternalUrls()) void clickNext(null); else setScreen("coinbase")')
	})

	it('the existing failure copy is used, and no new copy key is added for it', () => {
		expect(src).toContain("Coinbase couldn’t complete this step. Try again, or use another method.")
	})
})
