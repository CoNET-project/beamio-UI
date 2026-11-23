/**
 * Regression tests: the Recovery Code (MasterKey) must never stay in a URL.
 * Test data only (TESTKEY_*). Covers the query, the HashRouter hash query, the
 * startup scrub (history.replaceState) and the hashchange scrub.
 */
import { stripSecretParamsFromUrl, urlHasSecretParams, isSecretUrlParamName } from './secretUrlParams'

const KEY_A = 'TESTKEY_0001'
const KEY_B = 'TESTKEY_0002'
const KEY_C = 'TESTKEY_0003'

describe('stripSecretParamsFromUrl (pure)', () => {
	it('removes MasterKey, RecoveryCode and recovercode from the query in any case and keeps other params', () => {
		const href = `https://beamio.ca/app/?MasterKey=${KEY_A}&x=1&RecoveryCode=${KEY_B}&recovercode=${KEY_C}#/home`
		const out = stripSecretParamsFromUrl(href)
		expect(out).not.toMatch(/masterkey|recoverycode|recovercode/i)
		expect(out).not.toContain(KEY_A)
		expect(out).not.toContain(KEY_B)
		expect(out).not.toContain(KEY_C)
		expect(out).toContain('x=1')
		expect(out).toContain('#/home')
	})

	it('removes secret params from the HashRouter query and keeps the route path', () => {
		const href = `https://beamio.ca/app/#/wallet?recoverycode=${KEY_A}&tab=assets`
		const out = stripSecretParamsFromUrl(href)
		expect(out).not.toMatch(/recoverycode/i)
		expect(out).not.toContain(KEY_A)
		expect(out).toContain('#/wallet')
		expect(out).toContain('tab=assets')
	})

	it('removes beamiotag only when alsoCompanions is set', () => {
		const href = `https://beamio.ca/app/?beamioTag=@testtag&MasterKey=${KEY_A}`
		expect(stripSecretParamsFromUrl(href)).toContain('beamioTag=')
		expect(stripSecretParamsFromUrl(href, { alsoCompanions: true })).not.toMatch(/beamiotag/i)
	})

	it('returns an empty string for input that is not a URL', () => {
		expect(stripSecretParamsFromUrl('not a url')).toBe('')
	})
})

describe('urlHasSecretParams and isSecretUrlParamName', () => {
	it('detects a secret param in the query and in the hash query', () => {
		expect(urlHasSecretParams(`https://beamio.ca/app/?MasterKey=${KEY_A}`)).toBe(true)
		expect(urlHasSecretParams(`https://beamio.ca/app/#/x?recovercode=${KEY_A}`)).toBe(true)
	})

	it('reports false for a clean URL', () => {
		expect(urlHasSecretParams('https://beamio.ca/app/?x=1#/home')).toBe(false)
	})

	it('matches the three secret names in any case and nothing else', () => {
		expect(isSecretUrlParamName('MASTERKEY')).toBe(true)
		expect(isSecretUrlParamName('RecoveryCode')).toBe(true)
		expect(isSecretUrlParamName('recovercode')).toBe(true)
		expect(isSecretUrlParamName('beamioTag')).toBe(false)
	})
})

describe('startup scrub and hashchange scrub (jsdom history)', () => {
	beforeEach(() => {
		jest.resetModules()
	})

	it('takes the query MasterKey out of the address bar and keeps it in memory once', () => {
		window.history.replaceState(null, '', `/app/?beamioTag=@testtag&MasterKey=${KEY_A}`)
		jest.isolateModules(() => {
			const mod = require('./secretUrlParams')
			mod.captureLegacyRestoreLink()
			expect(window.location.href).not.toMatch(/masterkey/i)
			expect(window.location.href).not.toContain(KEY_A)
			expect(window.location.search).not.toMatch(/beamiotag/i)
			expect(mod.takeLegacyRestoreLink()).toEqual({ beamioTag: 'testtag', masterKey: KEY_A })
			expect(mod.takeLegacyRestoreLink()).toBeNull()
		})
	})

	it('takes a hash-query recoverycode out of the address bar', () => {
		window.history.replaceState(null, '', `/app/#/wallet?recoverycode=${KEY_B}&tab=assets`)
		jest.isolateModules(() => {
			const mod = require('./secretUrlParams')
			mod.captureLegacyRestoreLink()
			expect(window.location.href).not.toMatch(/recoverycode/i)
			expect(window.location.href).not.toContain(KEY_B)
			expect(window.location.hash).toContain('#/wallet')
			expect(window.location.hash).toContain('tab=assets')
		})
	})

	it('scrubs a secret param that appears in the hash after startup (hashchange path)', () => {
		window.history.replaceState(null, '', '/app/#/home')
		jest.isolateModules(() => {
			const mod = require('./secretUrlParams')
			mod.captureLegacyRestoreLink()
			window.history.replaceState(null, '', `/app/#/send?MasterKey=${KEY_C}`)
			window.dispatchEvent(new HashChangeEvent('hashchange'))
			expect(window.location.href).not.toMatch(/masterkey/i)
			expect(window.location.href).not.toContain(KEY_C)
			expect(window.location.hash).toContain('#/send')
		})
	})
})
