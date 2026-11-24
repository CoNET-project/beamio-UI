#!/usr/bin/env node
/**
 * Browser cold-start smoke: an ordinary browser opens the built page with an empty store, and the create page must appear.
 *
 *   node scripts/browser-cold-start-smoke.mjs <build-dir-or-zip> [--base /app] [--chrome <path>] [--budget-ms 60000] [--min-ms 20000]
 *
 * - <build-dir-or-zip>: a built `build/` directory or a SilentPassUI ZIP (unzipped to a temp folder with the system `unzip`).
 * - --base: the URL prefix the build was made for (the web build uses /app, the embedded build /). Default /.
 * - Use the WEB build (no REACT_APP_SHELL_BUILD): a shell-kind build never takes the page-key path, even with no bridge.
 * - Serves it from 127.0.0.1 on a free port, starts Google Chrome headless with a brand new empty profile (no storage, no native bridge),
 *   polls the rendered page text once a second up to the budget (real time) and records the console.
 * - PASS when the rendered page holds the create page text and the console shows nativeShell=false with none of the wait-loop lines.
 * - FAIL (exit 1) when the page stays on the start page, the create text is missing, or the console shows the wait loop
 *   ("onboarding confirmation read unknown", "retry, no onboarding", "startup retry").
 * - It runs twice, at the short budget (default 20 s) and the long one (default 60 s), and both must pass.
 * No WebSocket and no debugging port: Chrome is driven over --remote-debugging-pipe (file descriptors 3 and 4).
 * Nothing is written outside a temp folder; the profile and the unzipped files are removed at the end.
 */
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join, normalize, sep } from 'node:path'

const args = process.argv.slice(2)
const source = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--chrome' && args[args.indexOf(a) - 1] !== '--base' && args[args.indexOf(a) - 1] !== '--budget-ms' && args[args.indexOf(a) - 1] !== '--min-ms')
const opt = (name, fallback) => {
	const i = args.indexOf(name)
	return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const chrome = opt('--chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
const base = opt('--base', '/').replace(/\/+$/, '')
const longMs = Number(opt('--budget-ms', '60000'))
const shortMs = Number(opt('--min-ms', '20000'))
const CREATE_TEXT = /create your beamio id/i
const WAIT_LOOP = /onboarding confirmation read unknown|retry, no onboarding|startup retry: attempt/

if (!source || !existsSync(source)) {
	console.error('usage: browser-cold-start-smoke.mjs <build-dir-or-zip> [--chrome path] [--budget-ms 60000] [--min-ms 20000]')
	process.exit(2)
}
if (!existsSync(chrome)) {
	console.error(`Chrome not found at ${chrome}`)
	process.exit(2)
}

const work = mkdtempSync(join(tmpdir(), 'beamio-cold-smoke-'))
let root = source
if (statSync(source).isFile()) {
	root = join(work, 'site')
	const r = spawnSync('unzip', ['-q', source, '-d', root])
	if (r.status !== 0) {
		console.error('unzip failed')
		process.exit(2)
	}
}
if (!existsSync(join(root, 'index.html'))) {
	console.error(`no index.html in ${root}`)
	process.exit(2)
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.ico': 'image/x-icon' }
const server = createServer((req, res) => {
	let rel = decodeURIComponent((req.url ?? '/').split('?')[0])
	if (base && (rel === base || rel.startsWith(base + '/'))) rel = rel.slice(base.length) || '/'
	const path = normalize(rel).replace(/^(\.\.[/\\])+/, '')
	let file = join(root, path)
	if (!file.startsWith(root + sep) && file !== root) {
		res.writeHead(403).end()
		return
	}
	if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, 'index.html')
	res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' })
	res.end(readFileSync(file))
})

/** Drives Chrome over --remote-debugging-pipe (fd 3 in, fd 4 out, NUL-delimited JSON): no network port, no WebSocket. */
function runOnce(url, budgetMs, label) {
	return new Promise((resolve) => {
		const profile = mkdtempSync(join(work, 'profile-'))
		const child = spawn(
			chrome,
			['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`, '--remote-debugging-pipe', 'about:blank'],
			{ stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] },
		)
		const out = child.stdio[3]
		const inn = child.stdio[4]
		let id = 0
		const pending = new Map()
		const consoleLines = []
		let buf = ''
		const send = (method, params = {}, sessionId) =>
			new Promise((res) => {
				const myId = ++id
				pending.set(myId, res)
				out.write(JSON.stringify({ id: myId, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0')
			})
		inn.on('data', (chunk) => {
			buf += chunk.toString('utf8')
			let i
			while ((i = buf.indexOf('\0')) >= 0) {
				const raw = buf.slice(0, i)
				buf = buf.slice(i + 1)
				let m
				try {
					m = JSON.parse(raw)
				} catch {
					continue
				}
				if (m.id && pending.has(m.id)) {
					pending.get(m.id)(m.result ?? m.error)
					pending.delete(m.id)
				} else if (m.method === 'Runtime.consoleAPICalled') {
					consoleLines.push((m.params.args ?? []).map((a) => (typeof a.value === 'string' ? a.value : a.description ?? '')).join(' '))
				}
			}
		})
		const finish = async (created, text) => {
			const loop = consoleLines.some((l) => WAIT_LOOP.test(l))
			const bridgeOff = consoleLines.some((l) => /nativeShell=false/.test(l))
			const ok = created && !loop && bridgeOff
			console.log(`[${label}] budget=${budgetMs}ms create_page=${created} wait_loop=${loop} nativeShell_false_logged=${bridgeOff} -> ${ok ? 'PASS' : 'FAIL'}`)
			if (!ok) console.log(`[${label}] page text: ${text.replace(/\s+/g, ' ').slice(0, 200)}`)
			child.kill('SIGTERM')
			await new Promise((r) => setTimeout(r, 500))
			rmSync(profile, { recursive: true, force: true })
			resolve(ok)
		}
		;(async () => {
			await new Promise((r) => setTimeout(r, 1500))
			const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
			const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
			await send('Runtime.enable', {}, sessionId)
			await send('Page.navigate', { url }, sessionId)
			const t0 = Date.now()
			let text = ''
			let created = false
			while (Date.now() - t0 < budgetMs) {
				await new Promise((r) => setTimeout(r, 1000))
				const r = await send('Runtime.evaluate', { expression: 'document.body ? document.body.innerText : ""', returnByValue: true }, sessionId)
				text = r?.result?.value ?? ''
				if (CREATE_TEXT.test(text)) {
					created = true
					break
				}
			}
			await finish(created, text)
		})().catch(async (e) => {
			console.log(`[${label}] driver error: ${e?.message ?? e}`)
			await finish(false, '')
		})
	})
}

server.listen(0, '127.0.0.1', async () => {
	const { port } = server.address()
	const url = `http://127.0.0.1:${port}${base}/`
	let ok = false
	try {
		ok = (await runOnce(url, shortMs, 'short')) && (await runOnce(url, longMs, 'long'))
	} finally {
		server.close()
		rmSync(work, { recursive: true, force: true })
	}
	console.log(ok ? 'SMOKE PASS: the create page appears from an empty browser store' : 'SMOKE FAIL: the create page did not appear (or the wait loop ran)')
	process.exit(ok ? 0 : 1)
})
