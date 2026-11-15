/**
 * when the shell refuses an in-app open, the Coinbase flow ends its wait at once with the existing failure copy
 * (coinbase_could_not_open), before the grace timer, and adds no copy key. Reads Home.tsx and the locale file only.
 */
import fs from 'fs'
import path from 'path'

const home = fs.readFileSync(path.join(__dirname, 'Home.tsx'), 'utf8')
const en = fs.readFileSync(path.join(__dirname, '..', '..', 'locale', 'en.json'), 'utf8')

describe('a refused in-app open ends the Coinbase wait now', () => {
	it('the refused branch comes before the grace timer and uses the existing copy key', () => {
		const at = home.indexOf("if (detail?.reason === 'refused')")
		expect(at).toBeGreaterThan(0)
		const timer = home.indexOf('coinbaseWebViewCloseTimerRef.current = setTimeout(', at)
		expect(timer).toBeGreaterThan(at)
		expect(home.slice(at, timer)).toContain("failCoinbaseWaitingAfterWebViewClose('coinbase_could_not_open')")
	})

	it('the fail function takes its copy key, defaulting to the timeout copy used before', () => {
		expect(home).toContain("(copyKey: 'coinbase_onramp_timeout' | 'coinbase_could_not_open' = 'coinbase_onramp_timeout')")
		expect(home).toContain('setCoinbaseOnrampStatusError(tu(copyKey))')
	})

	it('the copy key exists in the locale file (no new copy)', () => {
		expect(en).toContain('"coinbase_could_not_open"')
	})
})
