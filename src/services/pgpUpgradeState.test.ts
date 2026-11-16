/**
 * @jest-environment node
 *
 * Y.62 pgpUpgradeState, page side. Vector ids PU-01–06 come from the fixture copied from pgp-migration-vectors.v2.json.
 * The SDK sends only {type, code}; the page shows the notice for pgp_migration_retry only. "page-local" tests are the page's
 * own rules, not spec vectors.
 */
import fixture from './__fixtures__/pgp-upgrade-ra-pu.v2.json'
import {
	getPgpUpgradeState,
	installPgpUpgradeStateListener,
	parsePgpUpgradeStateEvent,
	pgpUpgradeRetryVisible,
	resetPgpUpgradeStateForTest,
	PGP_UPGRADE_STATE_CODES,
} from './pgpUpgradeState'

type Entry = { id: string; input: { action?: string; internalError?: boolean }; expect: { type: string; code: string } }
const entry = (id: string): Entry => {
	const e = (fixture.entries as Entry[]).find((x) => x.id === id)
	if (!e) throw new Error(`fixture missing ${id}`)
	return e
}

type Win = EventTarget
const w = new EventTarget() as Win
;(globalThis as unknown as { window: Win }).window = w
class ShellCustomEvent extends Event {
	readonly detail: unknown
	constructor(type: string, init?: { detail?: unknown }) {
		super(type)
		this.detail = init?.detail
	}
}
;(globalThis as unknown as { CustomEvent: typeof ShellCustomEvent }).CustomEvent = ShellCustomEvent

/** Delivers a chat module event the way the shell does (window event, detail.action chatModuleEvent). */
const dispatch = (event: Record<string, unknown>) =>
	w.dispatchEvent(new ShellCustomEvent('cashtreesios', { detail: { action: 'chatModuleEvent', event } }))

beforeEach(() => {
	resetPgpUpgradeStateForTest()
	installPgpUpgradeStateListener()
})

describe('Y.62 pgpUpgradeState (PU-01–06, page side)', () => {
	for (const id of ['PU-01', 'PU-02', 'PU-03', 'PU-04', 'PU-05']) {
		it(`${id} event ${entry(id).expect.code}: parsed from {type, code} only and recorded`, () => {
			const e = entry(id)
			const payload = { type: e.expect.type, code: e.expect.code }
			expect(parsePgpUpgradeStateEvent(payload)).toBe(e.expect.code)
			dispatch(payload)
			expect(getPgpUpgradeState()).toBe(e.expect.code)
		})
	}

	it('PU-06 internal error reaches the page as pgp_migration_retry and shows the notice', () => {
		const e = entry('PU-06')
		expect(e.input.internalError).toBe(true)
		expect(e.expect.code).toBe('pgp_migration_retry')
		dispatch({ type: 'pgpUpgradeState', code: e.expect.code })
		expect(pgpUpgradeRetryVisible()).toBe(true)
	})

	it('PU-05 pgp_migration_retry shows the notice; the four other codes do not', () => {
		dispatch({ type: 'pgpUpgradeState', code: 'pgp_migration_retry' })
		expect(pgpUpgradeRetryVisible()).toBe(true)
		for (const code of ['upgraded_from_L', 'upgraded_from_chain', 'keep_existing', 'generated_on_user_click']) {
			dispatch({ type: 'pgpUpgradeState', code })
			expect(pgpUpgradeRetryVisible()).toBe(false)
		}
	})

	it('page-local: an unknown code and an event with an extra field (reqId, eoa) are ignored', () => {
		dispatch({ type: 'pgpUpgradeState', code: 'pgp_migration_retry' })
		dispatch({ type: 'pgpUpgradeState', code: 'bogus' })
		expect(pgpUpgradeRetryVisible()).toBe(true)
		dispatch({ type: 'pgpUpgradeState', code: 'keep_existing', reqId: 1 })
		expect(getPgpUpgradeState()).toBe('pgp_migration_retry')
		expect(parsePgpUpgradeStateEvent({ type: 'pgpUpgradeState', code: 'keep_existing', eoa: '0x' })).toBeNull()
	})

	it('page-local: the five codes are exactly the spec set', () => {
		expect([...PGP_UPGRADE_STATE_CODES].sort()).toEqual(
			['generated_on_user_click', 'keep_existing', 'pgp_migration_retry', 'upgraded_from_L', 'upgraded_from_chain'].sort(),
		)
	})
})
