/**
 * @jest-environment node
 */
/** The receipt-route offer is joined per contact and spaced out; the guard of the native receipt path holds. SYNTHETIC. */
import { createOfferGate, sharedOfferGate, ROUTE_OFFER_MIN_REREAD_MS } from './routeOfferGate'
import { createRouteTable, applyRouteEligibility, type RouteEntry } from './nativeRouteTable'
import fs from 'fs'
import path from 'path'

const A = '0x' + 'aa'.repeat(20)
const B = '0x' + 'bb'.repeat(20)
const ARMOR = '-----BEGIN PGP PUBLIC KEY BLOCK-----\nSYNTHETIC\n-----END PGP PUBLIC KEY BLOCK-----'

describe('offer gate', () => {
	it('many requests for one contact while a read runs are one read (a burst of inbound messages)', async () => {
		let now = 0
		const gate = createOfferGate(() => now)
		let release: () => void = () => undefined
		const task = jest.fn(() => new Promise<void>((resolve) => void (release = resolve)))
		const runs = [gate.run(A, task), gate.run(A, task), gate.run(A.toUpperCase().replace('0X', '0x'), task)]
		expect(task).toHaveBeenCalledTimes(1)
		release()
		await Promise.all(runs)
		expect(task).toHaveBeenCalledTimes(1)
	})
	it('a second read of the same contact waits the minimum time; another contact is independent', async () => {
		let now = 1_000
		const gate = createOfferGate(() => now)
		const task = jest.fn(async () => undefined)
		await gate.run(A, task)
		now += ROUTE_OFFER_MIN_REREAD_MS - 1
		await gate.run(A, task)
		expect(task).toHaveBeenCalledTimes(1)
		await gate.run(B, task)
		expect(task).toHaveBeenCalledTimes(2)
		now += 2
		await gate.run(A, task)
		expect(task).toHaveBeenCalledTimes(3)
	})
	it('force (the user just verified) reads at once, and after the read that is running when one is', async () => {
		let now = 0
		const gate = createOfferGate(() => now)
		const task = jest.fn(async () => undefined)
		await gate.run(A, task)
		await gate.run(A, task, true)
		expect(task).toHaveBeenCalledTimes(2)
		let release: () => void = () => undefined
		const slow = jest.fn(() => new Promise<void>((resolve) => void (release = resolve)))
		const first = gate.run(B, slow)
		const forced = gate.run(B, task, true)
		release()
		await Promise.all([first, forced])
		expect(slow).toHaveBeenCalledTimes(1)
		expect(task).toHaveBeenCalledTimes(3)
	})
	it('a task that throws does not block the next read', async () => {
		const gate = createOfferGate(() => 0, 0)
		await gate.run(A, async () => {
			throw new Error('x')
		})
		const ok = jest.fn(async () => undefined)
		await gate.run(A, ok)
		expect(ok).toHaveBeenCalledTimes(1)
	})
})

describe('the guard of the native receipt path', () => {
	const mk = () => {
		const sent: RouteEntry[][] = []
		const table = createRouteTable({ send: (r) => (sent.push(r), true), setTimer: (fn) => (fn(), 1), clearTimer: () => undefined })
		return { table, sent }
	}
	it('inactive (an older shell, the browser, hello not answered): nothing is offered or removed', () => {
		const { table, sent } = mk()
		table.note(A, ARMOR, ARMOR)
		sent.length = 0
		expect(applyRouteEligibility(table, () => false, A, 'remove', undefined)).toBe('unchanged')
		expect(table.has(A)).toBe(true)
		expect(applyRouteEligibility(table, () => false, B, 'offer', { publicArmored: ARMOR, routersArmoreds: ARMOR })).toBe('unchanged')
		expect(table.has(B)).toBe(false)
		expect(sent).toHaveLength(0)
	})
	it('active: the decision is followed', () => {
		const { table } = mk()
		expect(applyRouteEligibility(table, () => true, B, 'offer', { publicArmored: ARMOR, routersArmoreds: ARMOR })).toBe('offered')
		expect(applyRouteEligibility(table, () => true, B, 'remove', undefined)).toBe('removed')
	})
	it('the bridge passes the capability check as the guard, and the contact offer skips the network for an unverified contact', () => {
		const bridge = fs.readFileSync(path.join(__dirname, 'chatWorkerBridge.ts'), 'utf8')
		expect(bridge).toContain('applyRouteEligibility(nativeRoutes, nativeReceiptPath, address, eligibility, route)')
		const chat = fs.readFileSync(path.join(__dirname, 'chat.ts'), 'utf8')
		expect(chat).toContain('export const offerContactRoute = (address: string, opts?: { force?: boolean }): Promise<void> => {')
		expect(chat).toContain('return receiptRouteTrust.offer(address, opts)')
		const rt = fs.readFileSync(path.join(__dirname, 'receiptRouteTrust.ts'), 'utf8')
		const fn = rt.slice(rt.indexOf('async offer('))
		expect(fn.indexOf("deps.apply(address, 'remove', undefined)")).toBeLessThan(fn.indexOf('deps.gate.run('))
		expect(fn).toContain('opts?.force === true')
		const chatTsx = fs.readFileSync(path.join(__dirname, '..', 'pages', 'chat', 'chat.tsx'), 'utf8')
		expect(chatTsx).toContain('else void offerContactRoute(addr, { force: true })')
	})
})

describe('an account change or an identity clear also clears the gate', () => {
	it('reset() drops the spacing records and the running reads: the next request reads at once, and a result of the old read does not block it', async () => {
		let now = 0
		const gate = createOfferGate(() => now)
		const task = jest.fn(async () => undefined)
		await gate.run(A, task)
		await gate.run(A, task)
		expect(task).toHaveBeenCalledTimes(1)
		gate.reset()
		await gate.run(A, task)
		expect(task).toHaveBeenCalledTimes(2)
		let release: () => void = () => undefined
		const slow = jest.fn(() => new Promise<void>((resolve) => void (release = resolve)))
		const old = gate.run(B, slow)
		gate.reset()
		const fresh = jest.fn(async () => undefined)
		await gate.run(B, fresh)
		expect(fresh).toHaveBeenCalledTimes(1)
		release()
		await old
	})
	it('the identity clear and the own-account change both clear the table and the shared gate (source guard)', () => {
		const bridge = fs.readFileSync(path.join(__dirname, 'chatWorkerBridge.ts'), 'utf8')
		expect(bridge).toContain('export const clearNativeRouteState = (): void => {\n\tnativeRoutes.clear()\n\tsharedOfferGate.reset()')
		expect(bridge).toMatch(/export const clearNativeChatIdentity = \(\): void => \{\n\tclearNativeRouteState\(\)/)
		expect(bridge).toContain('if (lastOwnEoaForRoutes && eoa !== lastOwnEoaForRoutes) clearNativeRouteState()')
		expect(sharedOfferGate).toBeDefined()
	})
})
