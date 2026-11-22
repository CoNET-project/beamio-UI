/**
 * Static wiring check for the unlock chat restart (route 2). Reads the source only; the claim protocol itself is run in
 * unlockChatRestart.test.ts. Rendering App is not done here (honest scope).
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const read = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8')

describe('unlock chat restart wiring (static)', () => {
	test('App: init takes the claim first, skips its own initChat when owned, and registers the explicit start', () => {
		const app = read('App.tsx')
		const start = app.indexOf('const initProceed = async')
		expect(start).toBeGreaterThan(-1)
		const head = app.slice(start, start + 1200)
		expect(head).toContain('const unlockOwnsChatStart = takeUnlockChatOwnership()')
		expect(app).toContain('if (unlockOwnsChatStart) {')
		expect(app).toContain('await initChat(setProfiles,setAllNodes, setGossip, gossipActiveRef.current, handleInitChatLine)')
		expect(app).toContain("registerUnlockChatRestart(() => runUnlockChatStart({")
		expect(app).toContain('initChat: (gossip) => initChat(setProfiles, setAllNodes, setGossip, gossip, handleInitChatLine),')
		expect(app).toContain('return () => registerUnlockChatRestart(null)')
	})

	test('AppEntryGate: the unlock callback claims the restart before init()', () => {
		const gate = read('components/AppEntryGate.tsx')
		const at = gate.indexOf('onUnlocked={() => {')
		expect(at).toBeGreaterThan(-1)
		const body = gate.slice(at, gate.indexOf('}}', at))
		expect(body.indexOf('requestChatRestartAfterUnlock()')).toBeGreaterThan(-1)
		expect(body.indexOf('requestChatRestartAfterUnlock()')).toBeLessThan(body.indexOf('void init()'))
	})
})
