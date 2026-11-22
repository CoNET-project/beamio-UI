/**
 * / wiring in the SDK source (vendor/conet-chat-sdk/src/worker/gossip-core.ts): the connect timer starts before the entry wrap,
 * the wrap and the signing round trip run under their step timeouts, and the start-up error log carries the class. Source checks; the
 * timeout behaviour is in listenStepTimeouts.test.ts.
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const core = readFileSync(join(__dirname, '../../vendor/conet-chat-sdk/src/worker/gossip-core.ts'), 'utf8')
const spawnBody = core.slice(core.indexOf('private spawnGossip('), core.indexOf('private spawnGossip(') + 6000)
const startBody = core.slice(core.indexOf('private async startListen('), core.indexOf('private spawnGossip('))

describe('SSE start wiring', () => {
	it('the connect timer is set before the entry wrap (the wrap is inside the connect window)', () => {
		const timer = spawnBody.indexOf("connectTimer = setTimeout(() => controller.abort('connect_timeout'), config.connectTimeout)")
		const wrap = spawnBody.indexOf('withStepTimeout(wrapArmorToEntryRoute(innerArmor, node.armoredPublicKey), \'wrap\', WRAP_TIMEOUT_MS)')
		expect(timer).toBeGreaterThan(0)
		expect(wrap).toBeGreaterThan(timer)
	})

	it('the entry wrap has its own timeout (no bare wrap call in the connect path)', () => {
		expect(spawnBody).not.toMatch(/const armored = await wrapArmorToEntryRoute\(/)
	})

	it('the signing round trip of startListen has its own timeout', () => {
		expect(startBody).toMatch(/const innerArmor = await withStepTimeout\(encryptRouteCommand\(/)
		expect(startBody).toMatch(/\), 'sign', LISTEN_SIGN_TIMEOUT_MS\)/)
	})

	it('the start-up catch passes the class only to the status; the log line is built by the sanitizing helper', () => {
		expect(startBody).toMatch(/this\.emit\.status\('error', listenStatusReason\(ex\)\)/)
		expect(startBody).not.toMatch(/emit\.status\('error', \(ex as Error\)/)
		expect(startBody).toMatch(/this\.emit\.log\('error', listenErrorLogLine\(ex\)\)/)
	})

	it('the start-up error log line is built by listenErrorLogLine (the class, and a sanitized message only for other)', () => {
		expect(startBody).toMatch(/this\.emit\.log\('error', listenErrorLogLine\(ex\)\)/)
	})
})
