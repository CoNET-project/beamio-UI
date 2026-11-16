/**
 * Y.91 and Y.100 (CU-01 to CU-08): the pending cleanup after a recovery. SYNTHETIC values only.
 */
import { ethers } from 'ethers'
import { CLEANUP_PENDING_KEY, cleanupAfterOnboardingRecovery, eoaOfRestoredRecord, readCleanupPending, startCleanupAfterRecovery } from './accountCleanupPending'
import type { AccountCleanupCommand } from './accountCleanupOld'
import { readFileSync } from 'fs'
import { join } from 'path'

function memStore() {
	const m = new Map<string, string>()
	return {
		getItem: (k: string) => (m.has(k) ? (m.get(k) as string) : null),
		setItem: (k: string, v: string) => void m.set(k, v),
		removeItem: (k: string) => void m.delete(k),
		raw: m,
	}
}
const ACC = '0x' + 'ab'.repeat(20)
const ack = { kind: 'payload', payload: { type: 'ack', ok: true } }
const incomplete = { kind: 'payload', payload: { type: 'ack', ok: false, error: 'clear_incomplete' } }
const refused = { kind: 'payload', payload: { type: 'ack', ok: false, error: 'not_recovered' } }

describe('accountCleanupOld after recovery (Y.91, Y.100)', () => {
	it('CU-01: the four-field request is sent, and ok clears the marker', async () => {
		const store = memStore()
		const sent: AccountCleanupCommand[] = []
		const out = await startCleanupAfterRecovery(store, ACC, () => 'key-1', async (cmd) => (sent.push(cmd), ack))
		expect(out).toEqual({ kind: 'ok' })
		expect(sent).toHaveLength(1)
		expect(Object.keys(sent[0]).sort()).toEqual(['accountKey', 'idempotencyKey', 'reqId', 'type'])
		expect(sent[0].idempotencyKey).toBe('key-1')
		expect(store.raw.has(CLEANUP_PENDING_KEY)).toBe(false)
	})

	it('CU-07: clear_incomplete keeps the new account marker and resumes with the same idempotencyKey', async () => {
		const store = memStore()
		const keys: string[] = []
		const first = await startCleanupAfterRecovery(store, ACC, () => 'key-2', async (cmd) => (keys.push(cmd.idempotencyKey), incomplete))
		expect(first).toEqual({ kind: 'incomplete' })
		expect(readCleanupPending(store)).toEqual({ accountKey: ACC, idempotencyKey: 'key-2', keepNewAccount: true })
		const second = await startCleanupAfterRecovery(store, ACC, () => 'key-NEW', async (cmd) => (keys.push(cmd.idempotencyKey), ack))
		expect(second).toEqual({ kind: 'ok' })
		expect(new Set(keys)).toEqual(new Set(['key-2']))
		expect(store.raw.has(CLEANUP_PENDING_KEY)).toBe(false)
	})

	it('a refusal keeps the marker and never clears it', async () => {
		const store = memStore()
		const out = await startCleanupAfterRecovery(store, ACC, () => 'key-3', async () => refused)
		expect(out.kind).toBe('refused')
		expect(readCleanupPending(store)?.idempotencyKey).toBe('key-3')
	})

	it('a malformed marker is never a reason to delete, and is read as no marker', () => {
		const store = memStore()
		store.setItem(CLEANUP_PENDING_KEY, '{not json')
		expect(readCleanupPending(store)).toBeNull()
		store.setItem(CLEANUP_PENDING_KEY, JSON.stringify({ accountKey: '', idempotencyKey: 'x' }))
		expect(readCleanupPending(store)).toBeNull()
	})

	it('the account is normalised to lower case, and the marker is per account', async () => {
		const store = memStore()
		await startCleanupAfterRecovery(store, ACC.toUpperCase().replace('0X', '0x'), () => 'key-4', async () => incomplete)
		expect(readCleanupPending(store)?.accountKey).toBe(ACC)
	})

	it('the presence and gate judgement never read the cleanup marker (no-account is not decided by it)', () => {
		const presence = readFileSync(join(__dirname, 'accountPresence.ts'), 'utf8')
		expect(presence).not.toContain('accountCleanupPending')
		expect(presence).not.toContain('CLEANUP_PENDING_KEY')
	})
})

describe('onboarding recovery and app-start resume (Y.91 c, Y.100)', () => {
	const SYNTH_KEY = '0x' + '11'.repeat(32)

	it('the EOA of a restored record: the keyID when it is an address, else the address of its key (lower case)', () => {
		expect(eoaOfRestoredRecord({ profiles: [{ keyID: ACC.toUpperCase().replace('0X', '0x') }] })).toBe(ACC)
		expect(eoaOfRestoredRecord({ profiles: [{ privateKeyArmor: SYNTH_KEY }] })).toBe(new ethers.Wallet(SYNTH_KEY).address.toLowerCase())
		expect(eoaOfRestoredRecord({ profiles: [{ keyID: 'not-an-address', privateKeyArmor: 'bad' }] })).toBe('')
		expect(eoaOfRestoredRecord({})).toBe('')
		expect(eoaOfRestoredRecord(null)).toBe('')
	})

	it('a restore whose EOA cannot be read writes no marker and triggers no cleanup', () => {
		const before = window.localStorage.getItem(CLEANUP_PENDING_KEY)
		cleanupAfterOnboardingRecovery({ profiles: [] })
		expect(window.localStorage.getItem(CLEANUP_PENDING_KEY)).toBe(before)
	})

	it('a restore with a known EOA writes the pending marker before the request (interrupted runs resume)', () => {
		window.localStorage.removeItem(CLEANUP_PENDING_KEY)
		cleanupAfterOnboardingRecovery({ profiles: [{ keyID: ACC }] })
		const marker = readCleanupPending(window.localStorage)
		expect(marker?.accountKey).toBe(ACC)
		expect(marker?.keepNewAccount).toBe(true)
		window.localStorage.removeItem(CLEANUP_PENDING_KEY)
	})

	it('CU-07 resume: the same idempotencyKey is reused across a restart, and only ok ends the marker', async () => {
		const store = memStore()
		store.setItem(CLEANUP_PENDING_KEY, JSON.stringify({ accountKey: ACC, idempotencyKey: 'key-R', keepNewAccount: true }))
		const seen: string[] = []
		const out = await startCleanupAfterRecovery(store, ACC, () => 'key-NEW', async (cmd) => (seen.push(cmd.idempotencyKey), incomplete))
		expect(out).toEqual({ kind: 'incomplete' })
		expect(new Set(seen)).toEqual(new Set(['key-R']))
		expect(readCleanupPending(store)?.idempotencyKey).toBe('key-R')
	})

	it('the app-start resume and the onboarding call sites are wired (static)', () => {
		const gate = readFileSync(join(__dirname, '..', 'components', 'AppEntryGate.tsx'), 'utf8')
		expect(gate).toContain('readCleanupPending(window.localStorage)')
		const loading = readFileSync(join(__dirname, '..', 'pages', 'Home', 'LoadingPage.tsx'), 'utf8')
		expect(loading.split('cleanupAfterOnboardingRecovery(temp)').length - 1).toBe(2)
	})
})
