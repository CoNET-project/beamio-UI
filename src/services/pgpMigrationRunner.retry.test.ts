/**
 * pgpMigrate not_ready: not_ready is unknown and asked again on the cold-start schedule; `started` is set only by a
 * decisive result; after the 180 s window the events ask once each; no_key is asked again once after the identity is ready; a late result for
 * the latest request is taken. SYNTHETIC values.
 */
import { notifyPgpMigrateEvent, resetPgpMigrationRunnerForTest, startPgpMigrationOnce, getPgpMigrationState } from './pgpMigrationRunner'
import { pageStateForAck } from './pgpMigrationClient'

type Win = Window & { CashTreesIOS?: unknown }
const w = window as unknown as Win
let sent: Array<{ type?: string; reqId?: number }> = []
let answers: Array<'not_ready' | 'no_key' | 'accepted' | 'none'> = []

function installShell() {
	sent = []
	w.CashTreesIOS = {
		chatModuleCommand: (raw: Record<string, unknown>) => {
			const cmd = (raw as { command: { type?: string; reqId?: number } }).command
			sent.push(cmd)
			if (cmd.type !== 'pgpMigrate') return
			const a = answers.length > 1 ? answers.shift() : answers[0]
			if (a === 'none') return
			const payload = a === 'accepted' ? { type: 'ack', reqId: cmd.reqId, ok: true, result: { code: 'accepted' } } : { type: 'ack', reqId: cmd.reqId, ok: false, error: a }
			window.dispatchEvent(new CustomEvent('cashtreesios', { detail: { action: 'chatModuleEvent', event: payload } }))
		},
	}
}
const result = (reqId: number, code: string) =>
	window.dispatchEvent(new CustomEvent('cashtreesios', { detail: { action: 'chatModuleEvent', event: { type: 'pgpMigrateResult', reqId, code } } }))
const migrates = () => sent.filter((c) => c.type === 'pgpMigrate')
const flush = async () => {
	for (let i = 0; i < 20; i++) await Promise.resolve()
}

beforeEach(() => {
	jest.useFakeTimers()
	resetPgpMigrationRunnerForTest()
	answers = ['not_ready']
	installShell()
})
afterEach(() => {
	jest.useRealTimers()
	delete w.CashTreesIOS
})

describe('the ack mapping', () => {
	it('not_ready is its own transient state; no_key stays unavailable; locked, busy and hard refusals as before', () => {
		expect(pageStateForAck({ type: 'ack', ok: false, error: 'not_ready' })).toBe('not_ready')
		expect(pageStateForAck({ type: 'ack', ok: false, error: 'no_key' })).toBe('unavailable')
		expect(pageStateForAck({ type: 'ack', ok: false, error: 'locked' })).toBe('locked')
		expect(pageStateForAck({ type: 'ack', ok: false, error: 'busy' })).toBe('busy')
		expect(pageStateForAck({ type: 'ack', ok: false, error: 'bad_request' })).toBe('refused')
	})
})

describe('not_ready is asked again', () => {
	it('after a not_ready answer: 1, 2, 4, 8, 16 s, then every 16 s, one request at a time; not_ready is never "started"', async () => {
		await startPgpMigrationOnce()
		expect(getPgpMigrationState()).toBe('not_ready')
		expect(migrates()).toHaveLength(1)
		const times = [1000, 2000, 4000, 8000, 16000, 16000]
		for (let i = 0; i < times.length; i++) {
			jest.advanceTimersByTime(times[i] - 1)
			await flush()
			expect(migrates()).toHaveLength(i + 1)
			jest.advanceTimersByTime(1)
			await flush()
			expect(migrates()).toHaveLength(i + 2)
		}
		expect(getPgpMigrationState()).toBe('not_ready')
	})
	it('+2.6 s: two not_ready answers, then the snapshot is ready and the next ask gets a decisive result; the run stops asking', async () => {
		answers = ['not_ready', 'not_ready', 'accepted']
		await startPgpMigrationOnce()
		jest.advanceTimersByTime(1000)
		await flush()
		jest.advanceTimersByTime(2000)
		await flush()
		expect(migrates()).toHaveLength(3)
		const last = migrates()[2].reqId as number
		result(last, 'ok')
		await flush()
		expect(getPgpMigrationState()).toBe('verified')
		jest.advanceTimersByTime(120_000)
		await flush()
		expect(migrates()).toHaveLength(3)
	})
	it('a second start while a request is in flight sends nothing (single flight)', async () => {
		answers = ['none']
		const first = startPgpMigrationOnce()
		await flush()
		await startPgpMigrationOnce()
		expect(migrates()).toHaveLength(1)
		jest.advanceTimersByTime(45_000)
		await first
	})
})

describe('the window used up, and the events', () => {
	async function exhaust() {
		await startPgpMigrationOnce()
		for (let i = 0; i < 40; i++) {
			jest.advanceTimersByTime(16_000)
			await flush()
		}
	}
	it('with the 180 s window used up the schedule stops; identity ready, chat started and the foreground each ask once; the visible poll may always ask', async () => {
		await exhaust()
		const base = migrates().length
		jest.advanceTimersByTime(120_000)
		await flush()
		expect(migrates()).toHaveLength(base)
		notifyPgpMigrateEvent('identity_ready')
		await flush()
		expect(migrates()).toHaveLength(base + 1)
		notifyPgpMigrateEvent('identity_ready')
		await flush()
		expect(migrates()).toHaveLength(base + 1)
		notifyPgpMigrateEvent('chat_started')
		await flush()
		notifyPgpMigrateEvent('foreground')
		await flush()
		expect(migrates()).toHaveLength(base + 3)
		notifyPgpMigrateEvent('poll')
		await flush()
		notifyPgpMigrateEvent('poll')
		await flush()
		expect(migrates()).toHaveLength(base + 5)
	})
	it('a decisive result ends it: later events ask nothing', async () => {
		answers = ['accepted']
		void startPgpMigrationOnce()
		await flush()
		result(migrates()[0].reqId as number, 'ok')
		await flush()
		notifyPgpMigrateEvent('chat_started')
		notifyPgpMigrateEvent('poll')
		await flush()
		expect(migrates()).toHaveLength(1)
	})
})

describe('no_key', () => {
	it('is not asked again by itself; once after the identity is ready (or a first identity is done); an account switch starts a fresh run', async () => {
		answers = ['no_key']
		await startPgpMigrationOnce()
		expect(getPgpMigrationState()).toBe('unavailable')
		jest.advanceTimersByTime(120_000)
		await flush()
		expect(migrates()).toHaveLength(1)
		notifyPgpMigrateEvent('chat_started')
		notifyPgpMigrateEvent('foreground')
		notifyPgpMigrateEvent('poll')
		await flush()
		expect(migrates()).toHaveLength(1)
		notifyPgpMigrateEvent('identity_ready')
		await flush()
		expect(migrates()).toHaveLength(2)
		notifyPgpMigrateEvent('first_identity_done')
		await flush()
		expect(migrates()).toHaveLength(2)
		notifyPgpMigrateEvent('account_switch')
		await flush()
		expect(migrates()).toHaveLength(3)
	})
})

describe('a late result', () => {
	it('for the latest request is taken; for an older request it is not', async () => {
		answers = ['accepted']
		const first = startPgpMigrationOnce()
		await flush()
		const req = migrates()[0].reqId as number
		jest.advanceTimersByTime(45_000)
		await first
		expect(getPgpMigrationState()).toBe('retryable')
		result(req + 1000, 'ok')
		await flush()
		expect(getPgpMigrationState()).toBe('retryable')
		result(req, 'ok')
		await flush()
		expect(getPgpMigrationState()).toBe('verified')
	})
})
