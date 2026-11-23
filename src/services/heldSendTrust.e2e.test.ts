/**
 * @jest-environment node
 */
/**
 * BCHAT 36, end to end at the service level (real OpenPGP keys, injected fetch, no UI, no network):
 *   first contact held -> "Verified, continue" writes the trust -> the trust is persisted (a JSON round trip of the stored rows)
 *   -> the held message goes out on the verified key -> after a restart the trust still holds -> a changed key is held, never sent.
 * The page code (chat.tsx applyPeerRoute) is the same sequence as `applyLikePage` below; a static test pins that wiring.
 * The browser run of the same flow is the QA harness (harness/v2/bidi-text.mjs) on the candidate build.
 */
import { generateKey } from 'openpgp'
import { fingerprintOfArmor, sendWithFreshRoute, sendWithPinnedRoute, type HeldKey, type RecipientLookup } from '../utils/recipientPublicKey'
import { heldWireFromMessage } from './heldWire'
import { applyPeerRouteToRows, nextPeerChatData, routeFieldsDiffer, type PeerRouteFields } from './peerRouteRecord'
import { storedKeyFingerprint } from '../utils/pgpFingerprint'

const ADDRESS = '0x5555555555555555555555555555555555555555'
let KEY_A = ''
let KEY_B = ''
let FP_A = ''

beforeAll(async () => {
	KEY_A = (await generateKey({ type: 'curve25519', userIDs: [{ name: 'contact a' }], format: 'armored' })).publicKey.trim()
	KEY_B = (await generateKey({ type: 'curve25519', userIDs: [{ name: 'contact b' }], format: 'armored' })).publicKey.trim()
	FP_A = await fingerprintOfArmor(KEY_A)
}, 120_000)

type Row = { address: string; messages: unknown[]; chatData: PeerRouteFields }

const emptyRow = (): Row => ({
	address: ADDRESS,
	messages: [],
	chatData: { publicArmored: '', routersArmoreds: '', online: false, routePgpKeyID: '' },
})

/** The page's applyPeerRoute, step by step: a new chatData on the copy, the comparison against the object before the write, then the rows. */
function applyLikePage(copy: Row, rows: Row[], r: { publicArmored: string; routersArmoreds: string; routePgpKeyID?: string; fingerprint?: string }, trusted: boolean) {
	const before = copy.chatData
	const next = nextPeerChatData(before, r, trusted)
	const moved = routeFieldsDiffer(before, next)
	copy.chatData = next
	return applyPeerRouteToRows(rows, copy.address, next, moved)
}

/** What the profile storage does: the rows come back as plain data after a restart. */
const reload = (rows: Row[]): Row[] => JSON.parse(JSON.stringify(rows))

const lookupOf = (key: string, route: string): (() => Promise<RecipientLookup>) => async () => ({
	status: 'ok',
	publicArmored: key,
	routersArmoreds: route,
	routePgpKeyID: 'R1',
})

describe('first contact: hold, verify, send, restart', () => {
	it('the first send is held and nothing goes out', async () => {
		const copy = { ...emptyRow() }
		const send = jest.fn(async (..._args: unknown[]) => true)
		const r = await sendWithFreshRoute(copy, 'hello', 'pk', [], { fetchKeys: lookupOf(KEY_A, 'ROUTE-A'), send })
		expect(r).toMatchObject({ ok: false, code: 'first_fetch_pending' })
		expect(send).not.toHaveBeenCalled()
	})

	it('Verified, continue persists the trust; the held message goes out on the verified key; a restart keeps the trust', async () => {
		const rows: Row[] = [emptyRow()]
		const copy: Row = { ...rows[0] }
		const send = jest.fn(async (..._args: unknown[]) => true)

		// 1. the first send is held and carries the key that was read
		const held = await sendWithFreshRoute(copy, 'hello', 'pk', [], { fetchKeys: lookupOf(KEY_A, 'ROUTE-A'), send })
		if (held.ok || held.code !== 'first_fetch_pending' || !held.held) throw new Error('expected a held send')

		// 2. the user compares the fingerprint and taps "Verified, continue": the trust is written and stored
		const written = applyLikePage(copy, rows, held.held, true)
		expect(written.changed).toBe(true)
		const stored = reload(written.rows)
		expect(stored[0].chatData.verifiedFingerprint).toBe(storedKeyFingerprint(FP_A))

		// 3. the held message is sent again: read again and checked against the verified key (no bypass)
		const resendCopy: Row = { ...stored[0] }
		const resent = await sendWithFreshRoute(resendCopy, 'hello', 'pk', [], { fetchKeys: lookupOf(KEY_A, 'ROUTE-A'), send })
		expect(resent).toEqual({ ok: true, viaUnconfirmedRoute: false })
		expect(send).toHaveBeenCalledTimes(1)
		expect(send.mock.calls[0]?.[0]).toBe(KEY_A)

		// 4. restart: the stored row is read again; the trust still holds and a new message goes out without a hold
		const afterRestart: Row = { ...reload(stored)[0] }
		const again = await sendWithFreshRoute(afterRestart, 'second', 'pk', [], { fetchKeys: lookupOf(KEY_A, 'ROUTE-A'), send })
		expect(again.ok).toBe(true)
		expect(send).toHaveBeenCalledTimes(2)
	})

	it('a changed key is held, never sent, and the trust is not overwritten by a route refresh', async () => {
		const rows: Row[] = [emptyRow()]
		const copy: Row = { ...rows[0] }
		const send = jest.fn(async (..._args: unknown[]) => true)
		const held = await sendWithFreshRoute(copy, 'hello', 'pk', [], { fetchKeys: lookupOf(KEY_A, 'ROUTE-A'), send })
		if (held.ok || !held.held) throw new Error('expected a held send')
		const verified = reload(applyLikePage(copy, rows, held.held, true).rows)

		const changedCopy: Row = { ...verified[0] }
		const r = await sendWithFreshRoute(changedCopy, 'hello', 'pk', [], { fetchKeys: lookupOf(KEY_B, 'ROUTE-B'), send })
		expect(r).toMatchObject({ ok: false, code: 'fingerprint_changed' })
		expect(send).not.toHaveBeenCalled()

		// a route refresh (untrusted) with the other key does not replace the verified fingerprint
		const refreshed = applyLikePage(changedCopy, verified, { publicArmored: KEY_B, routersArmoreds: 'ROUTE-B' }, false)
		expect(reload(refreshed.rows)[0].chatData.verifiedFingerprint).toBe(storedKeyFingerprint(FP_A))
	})
})

describe('"Verify and send" on the banner: the pinned key is trusted and sent', () => {
	it('the pinned key is written as verified and stored, then sent', async () => {
		const rows: Row[] = [emptyRow()]
		const copy: Row = { ...rows[0] }
		const send = jest.fn(async (..._args: unknown[]) => true)
		const held = await sendWithFreshRoute(copy, 'hello', 'pk', [], { fetchKeys: lookupOf(KEY_A, 'ROUTE-A'), send })
		if (held.ok || !held.held) throw new Error('expected a held send')
		const pinned: HeldKey = held.held
		let stored: Row[] = rows
		const r = await sendWithPinnedRoute('hello', 'pk', [], {
			pinned,
			send,
			onAccepted: (p) => {
				const res = applyLikePage(copy, rows, p, true)
				stored = reload(res.rows)
			},
		})
		expect(r).toEqual({ ok: true, viaUnconfirmedRoute: false })
		expect(send.mock.calls[0]?.[0]).toBe(KEY_A)
		expect(stored[0].chatData.verifiedFingerprint).toBe(storedKeyFingerprint(FP_A))
	})
})

describe('the defect this fixes', () => {
	it('a write done in place before the comparison is seen as no change (the stored row is never written)', () => {
		const row = emptyRow()
		const copy: Row = { ...row } // shares chatData with the stored row
		const before = copy.chatData
		const next = nextPeerChatData(before, { publicArmored: KEY_A, routersArmoreds: 'ROUTE-A', fingerprint: FP_A }, true)
		// the old code wrote the fields into `before` first:
		Object.assign(before, next)
		expect(routeFieldsDiffer(before, next)).toBe(false)
		const { changed } = applyPeerRouteToRows([row], ADDRESS, next, false)
		expect(changed).toBe(false)
	})
})

describe('after a reload: the verify panel writes the trust, and only then the held text goes out (BCHAT 38, R86 item 1)', () => {
	/** The first send is held before the reload; the message is held and keeps its wire. */
	async function heldBeforeReload() {
		const rows0: Row[] = [emptyRow()]
		const copy0: Row = { ...rows0[0] }
		const held = await sendWithFreshRoute(copy0, 'hello', 'pk', [], { fetchKeys: lookupOf(KEY_A, 'ROUTE-A'), send: jest.fn(async (..._args: unknown[]) => true) })
		if (held.ok || !held.held) throw new Error('expected a held send')
		const message = { sendId: 'sid-1', from: 'me' as const, text: 'hello', createdAt: 1_700_000_000_000, status: 'first_fetch_pending', sendFingerprint: held.held.fingerprint }
		return { message, storedRows: reload(rows0) }
	}

	it('after the reload the send is held again with the key to compare; the verify panel writes the trust; the held text goes out; the trust survives a restart', async () => {
		const { message, storedRows } = await heldBeforeReload()
		const wire = heldWireFromMessage(message)
		expect(wire).not.toBeNull()
		const send = jest.fn(async (..._args: unknown[]) => true)
		// after the reload nothing is trusted: a send is held with the key the panel shows
		const copy: Row = { ...storedRows[0] }
		const again = await sendWithFreshRoute(copy, wire as string, 'pk', [], { fetchKeys: lookupOf(KEY_A, 'ROUTE-A'), send })
		expect(again).toMatchObject({ ok: false, code: 'first_fetch_pending' })
		expect(send).not.toHaveBeenCalled()
		const panelKey = (again as { held?: HeldKey }).held as HeldKey
		expect(panelKey.fingerprint).toBe(FP_A)
		// "Verified, continue" writes the trust; the stored row is read back; the held text goes out on it
		let stored: Row[] = storedRows
		stored = applyLikePage(copy, stored, panelKey, true).rows
		const persisted = reload(stored)
		expect(persisted[0].chatData.verifiedFingerprint).toBe(storedKeyFingerprint(FP_A))
		const resent = await sendWithFreshRoute({ ...persisted[0] }, wire as string, 'pk', [], { fetchKeys: lookupOf(KEY_A, 'ROUTE-A'), send })
		expect(resent).toEqual({ ok: true, viaUnconfirmedRoute: false })
		expect(send.mock.calls[0]?.[0]).toBe(KEY_A)
		expect(send.mock.calls[0]?.[1]).toBe(wire)
		// restart: a new message goes out without a hold
		const afterRestart = await sendWithFreshRoute({ ...reload(persisted)[0] }, 'second', 'pk', [], { fetchKeys: lookupOf(KEY_A, 'ROUTE-A'), send })
		expect(afterRestart.ok).toBe(true)
	})

	it('without the confirmation no trust is written: a send after the reload is held again and nothing is sent', async () => {
		const { message, storedRows } = await heldBeforeReload()
		const copy: Row = { ...storedRows[0] }
		const send = jest.fn(async (..._args: unknown[]) => true)
		const r = await sendWithFreshRoute(copy, heldWireFromMessage(message) as string, 'pk', [], { fetchKeys: lookupOf(KEY_A, 'ROUTE-A'), send })
		expect(r).toMatchObject({ ok: false, code: 'first_fetch_pending' })
		expect(send).not.toHaveBeenCalled()
		expect(reload(storedRows)[0].chatData.verifiedFingerprint).toBeUndefined()
	})

	it('a key that changed after the confirmation is held (fingerprint_changed): nothing is sent', async () => {
		const { message, storedRows } = await heldBeforeReload()
		const copy: Row = { ...storedRows[0] }
		const send = jest.fn(async (..._args: unknown[]) => true)
		const confirmed = applyLikePage(copy, storedRows, { publicArmored: KEY_A, routersArmoreds: 'ROUTE-A', fingerprint: FP_A }, true).rows
		const r = await sendWithFreshRoute({ ...reload(confirmed)[0] }, heldWireFromMessage(message) as string, 'pk', [], { fetchKeys: lookupOf(KEY_B, 'ROUTE-B'), send })
		expect(r).toMatchObject({ ok: false, code: 'fingerprint_changed' })
		expect(send).not.toHaveBeenCalled()
	})
})
