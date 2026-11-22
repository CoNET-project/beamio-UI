/**
 * @jest-environment node
 */
/**
 * build-level check (scripts/check-ws-guard-build.js): the artifact must keep the probe report and the standalone pages' guard.
 * Fixtures: a build with every marker passes; a build whose main bundle lost the report text fails and names the missing check.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { checkWsGuardBuild, REPORT, PROBE_GLOBAL, REFUSAL, PAGES } = require('../../scripts/check-ws-guard-build.js')

function build(opts: { main?: string; pages?: Record<string, string> }): string {
	const root = mkdtempSync(join(tmpdir(), 'ws-guard-build-'))
	mkdirSync(join(root, 'static', 'js'), { recursive: true })
	if (opts.main !== undefined) writeFileSync(join(root, 'static', 'js', 'main.abc123.js'), opts.main)
	for (const [name, html] of Object.entries(opts.pages ?? {})) writeFileSync(join(root, name), html)
	return root
}

const goodMain = `x();${REPORT} (probe=);${PROBE_GLOBAL};${REFUSAL}`
const goodPage = `<head><script>${REFUSAL};window.${PROBE_GLOBAL}=p</script></head><body></body>`
const goodPages = Object.fromEntries(PAGES.map((p: string) => [p, goodPage]))

describe('WebSocket guard build check', () => {
	it('a build with the report, the probe global and both standalone pages passes', () => {
		const r = checkWsGuardBuild(build({ main: goodMain, pages: goodPages }))
		expect(r.ok).toBe(true)
		expect(r.checks.every((c: { ok: boolean }) => c.ok)).toBe(true)
	})

	it('a main bundle that lost the report text fails and names the check', () => {
		const r = checkWsGuardBuild(build({ main: `x();${PROBE_GLOBAL};${REFUSAL}`, pages: goodPages }))
		expect(r.ok).toBe(false)
		const failed = r.checks.filter((c: { ok: boolean }) => !c.ok).map((c: { name: string }) => c.name)
		expect(failed).toEqual(['main bundle keeps the probe report text'])
	})

	it('a standalone page without the refusal fails', () => {
		const pages = { ...goodPages, [PAGES[0]]: `<head></head><body>${PROBE_GLOBAL}</body>` }
		const r = checkWsGuardBuild(build({ main: goodMain, pages }))
		expect(r.ok).toBe(false)
		expect(r.checks.some((c: { name: string; ok: boolean }) => c.name === `${PAGES[0]}: refusal in the head` && !c.ok)).toBe(true)
	})

	it('a standalone page that names a WebSocket URL fails', () => {
		const pages = { ...goodPages, [PAGES[1]]: `${goodPage}<script>new Socket('wss://relay.example')</script>` }
		const r = checkWsGuardBuild(build({ main: goodMain, pages }))
		expect(r.ok).toBe(false)
	})
})
