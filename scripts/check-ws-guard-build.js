/**
 * Build-level check of the WebSocket refusal. Runs after every artifact build (package.json build:react).
 *
 * The built artifact must carry:
 * - the app's probe report path in the main bundle: the report text and the probe global must survive the minifier
 * (craco drop_console removes console calls, so the report is not on console alone);
 * - in each standalone page (receive-wallet-send.html, receive-wallet-send-sw.html): the refusal, the probe global, and no
 * WebSocket URL in the page.
 *
 * Usage: node scripts/check-ws-guard-build.js <buildDir> (exit 0 = ok, 1 = failed; prints one JSON line)
 */
const fs = require('fs')
const path = require('path')

const REPORT = '[ws-guard] WebSocket refusal is not the project guard'
const PROBE_GLOBAL = '__beamioWsProbe'
const REFUSAL = 'websocket_disabled_by_project_rule'
const PAGES = ['receive-wallet-send.html', 'receive-wallet-send-sw.html']

function checkWsGuardBuild(buildDir) {
	const checks = []
	const add = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail })

	const jsDir = path.join(buildDir, 'static', 'js')
	const mains = fs.existsSync(jsDir) ? fs.readdirSync(jsDir).filter((f) => /^main\..+\.js$/.test(f)) : []
	add('main bundle: exactly one', mains.length === 1, `found ${mains.length}`)
	if (mains.length === 1) {
		const text = fs.readFileSync(path.join(jsDir, mains[0]), 'utf8')
		add('main bundle keeps the probe report text', text.includes(REPORT))
		add('main bundle keeps the probe global', text.includes(PROBE_GLOBAL))
		add('main bundle carries the refusal', text.includes(REFUSAL))
	}

	for (const page of PAGES) {
		const file = path.join(buildDir, page)
		if (!fs.existsSync(file)) {
			add(`${page}: present`, false, 'missing')
			continue
		}
		const html = fs.readFileSync(file, 'utf8')
		add(`${page}: refusal in the head`, html.includes(REFUSAL))
		add(`${page}: probe global`, html.includes(PROBE_GLOBAL))
		add(`${page}: no WebSocket URL`, !/wss?:\/\//.test(html))
	}

	return { ok: checks.every((c) => c.ok), checks }
}

module.exports = { checkWsGuardBuild, REPORT, PROBE_GLOBAL, REFUSAL, PAGES }

if (require.main === module) {
	const dir = process.argv[2] || 'build'
	const result = checkWsGuardBuild(dir)
	console.log(JSON.stringify(result))
	process.exit(result.ok ? 0 : 1)
}
