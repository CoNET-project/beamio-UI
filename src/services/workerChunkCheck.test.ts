/**
 * @jest-environment node
 */
/**
 * R82 build-level regression: the gossip worker chunk must contain its listener and replies. The check is the same code the build runs
 * (scripts/check-worker-chunks.js). Fixtures: a chunk with the markers passes; a chunk without them fails and names what is missing.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { checkWorkerBuild, REQUIRED, WORKERS } = require('../../scripts/check-worker-chunks.js')

function build(chunkName: string, body: string): string {
	const root = mkdtempSync(join(tmpdir(), 'worker-chunk-'))
	mkdirSync(join(root, 'static', 'js'), { recursive: true })
	writeFileSync(join(root, 'static', 'js', chunkName), body)
	return root
}

describe('gossip worker chunk regression (R82)', () => {
	it('a chunk that carries the listener and the replies passes', () => {
		const body = REQUIRED.join(';')
		const r = checkWorkerBuild(build('beamio-chat-gossip-relay.abc123.chunk.js', body))
		// the gossip worker's own result: its listener and replies are present (the other workers are checked in the whole-build tests below)
		expect(r.workers[0].ok).toBe(true)
		expect(r.missing).toEqual([])
	})

	it('a 378-byte chunk without the listener (the dropped side-effect import) fails and names the missing markers', () => {
		const r = checkWorkerBuild(build('beamio-chat-gossip-relay.ab951151.chunk.js', 'x'.repeat(378)))
		expect(r.ok).toBe(false)
		expect(r.missing).toEqual(REQUIRED)
	})

	it('no gossip worker chunk at all fails', () => {
		const root = mkdtempSync(join(tmpdir(), 'worker-chunk-empty-'))
		expect(checkWorkerBuild(root).ok).toBe(false)
	})
})

/** R82 extension: every project worker has its own named chunk with a listener and a reply. */
function buildAll(skip?: string, dropListener?: string): string {
	const root = mkdtempSync(join(tmpdir(), 'worker-chunks-all-'))
	mkdirSync(join(root, 'static', 'js'), { recursive: true })
	for (const w of WORKERS as Array<{ name: string; markers: string[] }>) {
		if (w.name === skip) continue
		const body = w.name === dropListener ? 'x'.repeat(400) : w.markers.join(';')
		writeFileSync(join(root, 'static', 'js', `${w.name}.abc123.chunk.js`), body)
	}
	return root
}

describe('every project worker chunk is checked (R82 extension)', () => {
	it('all named worker chunks with their listeners pass', () => {
		const r = checkWorkerBuild(buildAll())
		expect(r.ok).toBe(true)
		expect(r.workers.map((w: { name: string }) => w.name)).toEqual(WORKERS.map((w: { name: string }) => w.name))
	})

	it('a worker chunk that is missing fails the build and is named', () => {
		const r = checkWorkerBuild(buildAll('beamio-argon2'))
		expect(r.ok).toBe(false)
		const argon = r.workers.find((w: { name: string }) => w.name === 'beamio-argon2')
		expect(argon.ok).toBe(false)
	})

	it('a worker chunk without a message listener fails the build', () => {
		const r = checkWorkerBuild(buildAll(undefined, 'beamio-tag'))
		expect(r.ok).toBe(false)
		expect(r.workers.find((w: { name: string }) => w.name === 'beamio-tag').ok).toBe(false)
	})
})

describe('shell mode of the worker check (R83): the shell compiles the gossip worker out', () => {
	function shellBuild(opts: { gossip: boolean; listenersOff?: string }): string {
		const root = mkdtempSync(join(tmpdir(), 'worker-chunks-shell-'))
		mkdirSync(join(root, 'static', 'js'), { recursive: true })
		for (const w of WORKERS as Array<{ name: string; markers: string[] }>) {
			if (w.name === 'beamio-chat-gossip-relay') {
				if (opts.gossip) writeFileSync(join(root, 'static', 'js', `${w.name}.abc123.chunk.js`), w.markers.join(';'))
				continue
			}
			const body = w.name === opts.listenersOff ? 'x'.repeat(300) : w.markers.join(';')
			writeFileSync(join(root, 'static', 'js', `${w.name}.abc123.chunk.js`), body)
		}
		return root
	}

	it('a shell build without the gossip worker passes (no worker chunk is required in shell mode)', () => {
		const r = checkWorkerBuild(shellBuild({ gossip: false }), { shell: true })
		expect(r.ok).toBe(true)
		expect(r.mode).toBe('shell')
	})

	it('a shell build that still carries the gossip worker fails: the shell must not ship it', () => {
		const r = checkWorkerBuild(shellBuild({ gossip: true }), { shell: true })
		expect(r.ok).toBe(false)
		expect(r.workers[0].missing).toEqual(['must-be-absent-in-shell'])
	})

	it('a browser build without the gossip worker fails (browser mode requires every worker)', () => {
		const r = checkWorkerBuild(shellBuild({ gossip: false }), { shell: false })
		expect(r.ok).toBe(false)
	})

	it('a present worker in shell mode without its listener still fails', () => {
		const r = checkWorkerBuild(shellBuild({ gossip: false, listenersOff: 'beamio-tag' }), { shell: true })
		expect(r.ok).toBe(false)
	})
})
