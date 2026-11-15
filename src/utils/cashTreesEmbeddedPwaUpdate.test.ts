/**
 * OTA-off protocol checks (0.52.935).
 * Test data only. No real keys, no real user data.
 */
import fs from 'fs'
import path from 'path'

type Globals = Record<string, unknown>

function clearShellGlobals(): void {
	const w = window as unknown as Globals
	delete w.CashTreesIOS
	delete w.CashTreesAndroid
	delete w.__CT_IOS_CAPS__
	delete w.__CT_ANDROID_CAPS__
}

/** Load a fresh copy of the module so the per-session "not supported" flag starts clean. */
function loadModule(): typeof import('./cashTreesEmbeddedPwaUpdate') {
	let mod: typeof import('./cashTreesEmbeddedPwaUpdate') | undefined
	jest.isolateModules(() => {
		mod = require('./cashTreesEmbeddedPwaUpdate')
	})
	if (!mod) throw new Error('module did not load')
	return mod
}

function installIosBridge(opts: { capability: boolean }): { apply: jest.Mock } {
	const apply = jest.fn()
	;(window as unknown as Globals).CashTreesIOS = {
		applyEmbeddedPwaUpdate: apply,
		getEmbeddedPwaVersion: () => '0.52.935',
		getEmbeddedPwaPendingVersion: () => '',
	}
	if (opts.capability) {
		;(window as unknown as Globals).__CT_IOS_CAPS__ = { 'pwa.embedded-ota.v1': true }
	}
	return { apply }
}

describe('embedded PWA OTA protocol (0.52.935)', () => {
	beforeEach(() => {
		clearShellGlobals()
		jest.resetModules()
	})

	afterEach(() => {
		clearShellGlobals()
	})

	it('(positive): bridge function AND capability declared -> OTA supported, apply is forwarded', () => {
		const { apply } = installIosBridge({ capability: true })
		const mod = loadModule()
		expect(mod.isEmbeddedPwaOtaSupported()).toBe(true)
		mod.requestEmbeddedPwaUpdateApply()
		expect(apply).toHaveBeenCalledTimes(1)
	})

	it('(negative): store build, no bridge function and no capability -> not supported, no call', () => {
		const mod = loadModule()
		expect(mod.isEmbeddedPwaOtaSupported()).toBe(false)
		// Nothing to call; request must be a no-op and must not throw.
		expect(() => mod.requestEmbeddedPwaUpdateApply()).not.toThrow()
	})

	it('(negative): bridge function present but capability NOT declared -> not supported, bridge not called', () => {
		const { apply } = installIosBridge({ capability: false })
		const mod = loadModule()
		expect(mod.isEmbeddedPwaOtaSupported()).toBe(false)
		mod.requestEmbeddedPwaUpdateApply()
		expect(apply).not.toHaveBeenCalled()
	})

	it('W3b (negative): capability declared on the Android global with the same name is honoured, bridge still required', () => {
		;(window as unknown as Globals).__CT_ANDROID_CAPS__ = { 'pwa.embedded-ota.v1': true }
		const mod = loadModule()
		// No Android bridge function -> still not supported.
		expect(mod.isEmbeddedPwaOtaSupported()).toBe(false)
	})

	it('(negative): reply reason "not_supported" -> no error, further calls suppressed for the session', () => {
		const { apply } = installIosBridge({ capability: true })
		const mod = loadModule()
		const seen: Array<{ ok: boolean; reason?: string; error?: string }> = []
		const off = mod.subscribeApplyEmbeddedPwaUpdateResult((d) => seen.push(d))
		window.dispatchEvent(
			new CustomEvent('cashtreesios', {
				detail: { action: 'applyEmbeddedPwaUpdate', ok: false, reason: 'not_supported' },
			}),
		)
		off()
		expect(seen).toHaveLength(1)
		expect(seen[0].reason).toBe('not_supported')
		expect(seen[0].error).toBeUndefined()
		expect(mod.isEmbeddedPwaOtaSupported()).toBe(false)
		mod.requestEmbeddedPwaUpdateApply()
		expect(apply).not.toHaveBeenCalled()
	})

	it('(negative): embeddedPwaUpdateAvailable while unsupported -> listener never called', () => {
		installIosBridge({ capability: false })
		const mod = loadModule()
		const listener = jest.fn()
		const off = mod.subscribeEmbeddedPwaUpdateAvailable(listener)
		window.dispatchEvent(
			new CustomEvent('cashtreesios', {
				detail: { action: 'embeddedPwaUpdateAvailable', currentVer: '0.52.935', pendingVer: '0.52.999' },
			}),
		)
		off()
		expect(listener).not.toHaveBeenCalled()
	})

	it('W5b (positive control): the same event is delivered when the shell declares the capability', () => {
		installIosBridge({ capability: true })
		const mod = loadModule()
		const listener = jest.fn()
		const off = mod.subscribeEmbeddedPwaUpdateAvailable(listener)
		window.dispatchEvent(
			new CustomEvent('cashtreesios', {
				detail: { action: 'embeddedPwaUpdateAvailable', currentVer: '0.52.935', pendingVer: '0.52.999' },
			}),
		)
		off()
		expect(listener).toHaveBeenCalledWith({ currentVer: '0.52.935', pendingVer: '0.52.999' })
	})

	it('(static): every call of the apply bridge in source sits in the guarded util module', () => {
		const srcRoot = path.resolve(__dirname, '..')
		const offenders: string[] = []
		const walk = (dir: string) => {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const full = path.join(dir, entry.name)
				if (entry.isDirectory()) {
					walk(full)
					continue
				}
				if (!/\.(ts|tsx)$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue
				const text = fs.readFileSync(full, 'utf8')
				if (!/applyEmbeddedPwaUpdate\s*\?*\.?\(/.test(text)) continue
				if (path.resolve(full) !== path.resolve(srcRoot, 'utils', 'cashTreesEmbeddedPwaUpdate.ts')) {
					offenders.push(path.relative(srcRoot, full))
				}
			}
		}
		walk(srcRoot)
		expect(offenders).toEqual([])
	})
})
