/**
 * the global destroy that the logout and lock path sends carries a valid reqId.
 * Reads the sign-out source as well. SYNTHETIC values only.
 */
import fs from 'fs'
import path from 'path'
import { buildGlobalDestroyCommand, sendGlobalDestroyOnLogout } from './nativeKeyState'

const win = window as unknown as { CashTreesIOS?: unknown; BeamioChat?: unknown; CashTreesAndroid?: unknown }

afterEach(() => {
	delete win.CashTreesIOS
	delete win.BeamioChat
	delete win.CashTreesAndroid
})

describe('the global destroy carries a valid reqId', () => {
	it('the command is {type:"destroy", reqId} with an integer reqId in 0..2^53-1, and each one is new', () => {
		const a = buildGlobalDestroyCommand()
		const b = buildGlobalDestroyCommand()
		expect(Object.keys(a).sort()).toEqual(['reqId', 'type'])
		expect(a.type).toBe('destroy')
		expect(Number.isInteger(a.reqId)).toBe(true)
		expect(a.reqId).toBeGreaterThanOrEqual(0)
		expect(a.reqId).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER)
		expect(b.reqId).not.toBe(a.reqId)
	})

	it('the logout teardown is sent through the iOS shell with the reqId, and reports true', () => {
		const sent: Array<{ action: string; command: { type: string; reqId: number } }> = []
		win.CashTreesIOS = {
			chatModuleCommand: (p: { action: string; command: { type: string; reqId: number } }) => sent.push(p),
		}
		expect(sendGlobalDestroyOnLogout()).toBe(true)
		expect(sent).toHaveLength(1)
		expect(sent[0].command.type).toBe('destroy')
		expect(Number.isInteger(sent[0].command.reqId)).toBe(true)
	})

	it('with no shell channel, nothing is sent and it reports false', () => {
		expect(sendGlobalDestroyOnLogout()).toBe(false)
	})

	it('the sign-out path sends the teardown before the passcode layer is locked (static)', () => {
		const src = fs.readFileSync(path.join(__dirname, 'signOutLocal.ts'), 'utf8')
		const at = src.indexOf('sendGlobalDestroyOnLogout()')
		expect(at).toBeGreaterThan(0)
		expect(at).toBeLessThan(src.indexOf('lockWalletVaultOnLogout()'))
	})
})
