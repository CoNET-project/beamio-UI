/**
 * and (CU-01 to CU-08): the pending cleanup after a recovery. SYNTHETIC values only.
 */
import { ethers } from 'ethers'
import { CLEANUP_PENDING_KEY, readCleanupPending, resetCleanupGuardsForTest, startCleanupAfterRecovery } from './accountCleanupPending'

beforeEach(() => resetCleanupGuardsForTest())
import { sendAccountCleanupOld } from './accountCleanupOld'
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
const PUBLIC_PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about' // public BIP-39 test vector
const PUBLIC_PHRASE_EOA = '0x9858effd232b4033e47d90003d41ec34ecaeda94'

/**
 * jsdom realm: ethers derivation and the checksum fail in this environment (the same limit as the App suites). The fixture table answers only
 * the public test vector; any other phrase is invalid. Installed before each test (CRA resets mocks).
 */
beforeEach(() => {
	jest.spyOn(ethers.Wallet, 'fromPhrase').mockImplementation(((p: string) => {
		if (p.trim() !== PUBLIC_PHRASE) throw new Error('invalid mnemonic (fixture)')
		return { address: PUBLIC_PHRASE_EOA } as never
	}) as never)
	jest.spyOn(ethers.Mnemonic, 'fromPhrase').mockImplementation(((p: string) => {
		if (p.trim() !== PUBLIC_PHRASE) throw new Error('invalid mnemonic (fixture)')
		return {} as never
	}) as never)
})
const ack = { kind: 'payload', payload: { type: 'ack', ok: true } }
const incomplete = { kind: 'payload', payload: { type: 'ack', ok: false, error: 'clear_incomplete' } }
const refused = { kind: 'payload', payload: { type: 'ack', ok: false, error: 'not_recovered' } }

describe('accountCleanupOld after recovery', () => {
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

describe('2026-11-17 rule: a page recovery never starts the cleanup; only the native ok does', () => {
	it('the page-side restore does not start it: LoadingPage has no trigger and imports nothing from the cleanup module', () => {
		const loading = readFileSync(join(__dirname, '..', 'pages', 'Home', 'LoadingPage.tsx'), 'utf8')
		expect(loading).not.toContain('cleanupAfterOnboardingRecovery')
		expect(loading).not.toContain("from '@/services/accountCleanupPending'")
	})

	it('the cleanup helper that took a page-restored record is gone (no dead code)', () => {
		const mod = readFileSync(join(__dirname, 'accountCleanupPending.ts'), 'utf8')
		expect(mod).not.toContain('cleanupAfterOnboardingRecovery')
		expect(mod).not.toContain('eoaOfRestoredRecord')
	})

	it('the gate connects the silent cleanup on the recovery ok branch only, and resumes a pending marker at start (approval 75edef25)', () => {
		const gate = readFileSync(join(__dirname, '..', 'components', 'AppEntryGate.tsx'), 'utf8')
		const okAt = gate.indexOf("if (code === 'ok') {")
		const callAt = gate.indexOf('cleanupAfterVerifiedRecovery(window.localStorage, eoa, readPageDerivedAddress)')
		expect(okAt).toBeGreaterThan(0)
		expect(callAt).toBeGreaterThan(okAt)
		expect(gate).toContain('readCleanupPending(window.localStorage)')
	})

	it('the marker is written before the native request, so an interrupted run resumes; the request is sent only after that', async () => {
		const store = memStore()
		let markerAtSend: string | null = null
		await startCleanupAfterRecovery(store, ACC, () => 'key-N', async (cmd) => {
			markerAtSend = store.getItem(CLEANUP_PENDING_KEY)
			return ack
		})
		expect(markerAtSend).not.toBeNull()
		expect(readCleanupPending(store)).toBeNull() // ok clears it
	})

	it('no native bridge (browser): the send is refused at once, the marker stays, nothing retries in a loop, and nothing is deleted', async () => {
		const store = memStore()
		const calls: number[] = []
		const t0 = Date.now()
		const out = await startCleanupAfterRecovery(store, ACC, () => 'key-B', async (cmd) => {
			calls.push(1)
			return sendAccountCleanupOld(cmd)
		})
		const elapsed = Date.now() - t0
		expect(out.kind).toBe('refused')
		expect(elapsed).toBeLessThan(1000) // not a wait of seconds or the 180 s budget
		expect(calls.length).toBe(1) // no retry loop after an unavailable answer
		expect(readCleanupPending(store)?.idempotencyKey).toBe('key-B') // kept for a later native start
	})
})
