/**
 * Static coverage of the WebSocket refusal in every worker context. Each worker entry must import the guard as its first
 * import, and the chat SDK worker must be reached only through the guarded wrapper.
 */
import fs from 'fs'
import path from 'path'

const srcRoot = path.join(__dirname, '..')
const read = (rel: string) => fs.readFileSync(path.join(srcRoot, rel), 'utf8')

describe('WebSocket refusal in worker contexts', () => {
	const entries = ['workers/appDaemon/entry.ts', 'workers/argon2/entry.ts', 'workers/beamioTag/entry.ts', 'workers/chatMedia/entry.ts', 'workers/chatSdkGossip/entry.ts']

	it.each(entries)('%s imports the guard before any other import', (rel) => {
		const imports = read(rel)
			.split('\n')
			.filter((l) => /^\s*import\s/.test(l))
		expect(imports.length).toBeGreaterThan(0)
		expect(imports[0]).toMatch(/webSocketGuard/)
	})

	it('the chat SDK worker is created only through the guarded wrapper', () => {
		const bridge = read('services/chatWorkerBridge.ts')
		expect(bridge).not.toMatch(/new URL\('@conet\.project\/chat-sdk\/worker'/)
		expect(bridge).toMatch(/workers\/chatSdkGossip\/entry\.ts/)
	})
})
