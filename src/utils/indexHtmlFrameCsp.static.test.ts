/**
 * Static guard: public/index.html carries a meta CSP that limits frames only. Frames may come from this origin, from blob:
 * (the PDF preview fallback in chat.tsx) and from the wallet-probe schemes in mobileWalletApps.ts. No default-src or child-src is set,
 * so scripts, images, connections and workers are not restricted by this policy. Reads source files only. The built index.html is
 * checked once by hand (see the commit message), not in this suite.
 */
import fs from 'fs'
import path from 'path'

const SRC = path.resolve(__dirname, '..')
const ROOT = path.resolve(__dirname, '..', '..')
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8')
const probeSource = fs.readFileSync(path.join(SRC, 'utils', 'mobileWalletApps.ts'), 'utf8')

const POLICY = "frame-src 'self' blob: metamask: okx: base: cbwallet: coinbase: tpdapp: tpoutside:"

const cspMetas = html.match(/<meta[^>]*http-equiv=["']Content-Security-Policy["'][^>]*>/gi) || []
const cspMeta = cspMetas[0] ?? ''

describe('the page CSP limits frame-src only', () => {
	it('exactly one CSP meta, with exactly the agreed frame-src policy', () => {
		expect(cspMetas).toHaveLength(1)
		const content = /content="([^"]*)"/.exec(cspMeta)?.[1]
		expect(content).toBe(POLICY)
	})

	it('the CSP meta sits inside <head>, before the first script', () => {
		const at = html.indexOf(cspMeta)
		expect(at).toBeGreaterThan(html.indexOf('<head>'))
		expect(at).toBeLessThan(html.indexOf('</head>'))
		expect(at).toBeLessThan(html.indexOf('<script'))
	})

	it('only the frame-src directive is set (no default-src, child-src, script-src, worker-src or connect-src)', () => {
		const directives = (/content="([^"]*)"/.exec(cspMeta)?.[1] ?? '')
			.split(';')
			.map((d) => d.trim().split(/\s+/)[0])
			.filter(Boolean)
		expect(directives).toEqual(['frame-src'])
	})

	it('every wallet-probe scheme in mobileWalletApps.ts PROBE_SCHEMES is allowed by frame-src', () => {
		const start = probeSource.indexOf('const PROBE_SCHEMES')
		expect(start).toBeGreaterThan(0)
		const block = probeSource.slice(start, probeSource.indexOf('}', start))
		const schemes = [...block.matchAll(/'([a-z][a-z0-9+.-]*):\/\//g)].map((m) => m[1])
		expect(schemes.length).toBeGreaterThan(0)
		const allowed = POLICY.replace(/^frame-src\s+/, '').split(/\s+/)
		for (const scheme of new Set(schemes)) {
			expect(allowed).toContain(`${scheme}:`)
		}
	})
})
