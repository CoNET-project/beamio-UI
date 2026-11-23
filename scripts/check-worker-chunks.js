/**
 * Build-level regression check (R82). The production worker chunk of the gossip worker must contain its message listener and the protocol
 * replies. A chunk without them (a side-effect import dropped by tree shaking, see vendor/conet-chat-sdk/package.json) fails the build.
 *
 * Usage: node scripts/check-worker-chunks.js <buildDir>   (exit 0 = ok, 1 = failed; prints one JSON line)
 */
const fs = require('fs')
const path = require('path')

/** The gossip worker (SDK entry): the listener, the protocol replies and the WebSocket refusal (R82). */
const REQUIRED = ['addEventListener', 'unknown_command', 'signResponse', '"ready"', '"hello"', '"init"', 'websocket_disabled_by_project_rule']
/** The project workers (R82 extension): each chunk must carry a message listener and a reply. Each worker is named in its constructor. */
const LISTENER = ['onmessage', 'postMessage']
const WORKERS = [
	{ name: 'beamio-chat-gossip-relay', markers: REQUIRED },
	{ name: 'beamio-app-daemon', markers: LISTENER },
	{ name: 'beamio-tag', markers: LISTENER },
	{ name: 'beamio-argon2', markers: LISTENER },
	{ name: 'beamio-chat-media', markers: LISTENER },
]
const CHUNK = /^beamio-chat-gossip-relay\..+\.js$/

function checkOne(dir, worker) {
	const pattern = new RegExp('^' + worker.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\..+\\.js$')
	const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => pattern.test(f)) : []
	if (files.length !== 1) return { name: worker.name, ok: false, reason: `expected one chunk, found ${files.length}`, files }
	const text = fs.readFileSync(path.join(dir, files[0]), 'utf8')
	const missing = worker.markers.filter((m) => !text.includes(m))
	return { name: worker.name, ok: missing.length === 0, chunk: files[0], bytes: Buffer.byteLength(text), missing }
}

/**
 * All workers of the build. Browser mode: every worker chunk exists once and carries its listener and replies.
 * Shell mode (REACT_APP_SHELL_BUILD): the shell compiles the gossip worker out, so it must be absent; any other worker chunk that is present
 * must carry its listener and replies.
 */
function checkWorkerBuild(buildDir, opts = {}) {
	const dir = path.join(buildDir, 'static', 'js')
	const shell = opts.shell === true
	const workers = WORKERS.map((w) => {
		if (shell) {
			const present = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => new RegExp('^' + w.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\..+\\.js$').test(f)) : []
			if (w.name === 'beamio-chat-gossip-relay') {
				return { name: w.name, ok: present.length === 0, absent: present.length === 0, files: present, missing: present.length ? ['must-be-absent-in-shell'] : [] }
			}
			if (present.length === 0) return { name: w.name, ok: true, absent: true, missing: [] }
		}
		return checkOne(dir, w)
	})
	const ok = workers.every((w) => w.ok)
	const gossip = workers[0]
	return { ok, mode: shell ? 'shell' : 'browser', chunk: gossip.chunk, bytes: gossip.bytes, missing: gossip.missing || [], workers }
}

module.exports = { checkWorkerBuild, REQUIRED, WORKERS, CHUNK }

if (require.main === module) {
	const dir = process.argv[2] || 'build'
	const shell = process.argv.includes('--shell')
	const result = checkWorkerBuild(dir, { shell })
	console.log(JSON.stringify(result))
	process.exit(result.ok ? 0 : 1)
}
