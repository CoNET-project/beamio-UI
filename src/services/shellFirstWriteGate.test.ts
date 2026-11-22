/**
 * @jest-environment node
 */
/**
 * 2026-11-20: the first write that creates the native record waits for the native pwaWalletSync of the same account to be
 * confirmed ok. The native side is a fake at the transport (it keeps its own wallet fields, as a native store does after the sync).
 * Synthetic values only: the BIP-39 public test vector and its address.
 */
import { ethers } from 'ethers'
const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const WALLET = ethers.Wallet.fromPhrase(PHRASE)
const KEY_ID = WALLET.address.toLowerCase()
const KEY_HEX = WALLET.privateKey
const OTHER_ID = '0x0000000000000000000000000000000000000001'

type Native = { keys?: Loose; record?: Loose; rev: number; writes: Loose[] }
type Loose = Record<string, any>
const fake = (): Native => (globalThis as { __fakeNative?: Native }).__fakeNative as Native

jest.mock('./shellRecordTransport', () => {
	const actual = jest.requireActual('./shellRecordTransport')
	return {
		...actual,
		sendShellRecordCommand: async (cmd: Loose) => {
			const n = (globalThis as { __fakeNative?: Native }).__fakeNative as Native
			if (cmd.type === 'shellRecordRead') {
				if (n.record === undefined) return { kind: 'payload', payload: { type: 'ack', reqId: cmd.reqId, ok: true, result: { code: 'absent' } } }
				return { kind: 'payload', payload: { type: 'ack', reqId: cmd.reqId, ok: true, result: { code: 'ok', record: JSON.parse(JSON.stringify(n.record)) } } }
			}
			// a write: the native keeps its own wallet fields (the page never sends them), and the revision must match
			n.writes.push(JSON.parse(JSON.stringify(cmd.record)))
			if (n.record !== undefined && cmd.record.rev !== n.rev) {
				return { kind: 'payload', payload: { type: 'ack', reqId: cmd.reqId, ok: true, result: { code: 'conflict', currentRev: n.rev } } }
			}
			const next = JSON.parse(JSON.stringify(cmd.record))
			if (n.keys) {
				next.mnemonicPhrase = n.keys.mnemonicPhrase
				for (const p of next.profiles ?? []) {
					const k = (n.keys.profiles ?? []).find((x: Loose) => x.keyID === p.keyID)
					if (k) p.privateKeyArmor = k.privateKeyArmor
				}
			}
			n.rev = n.rev + 1
			next.rev = n.rev
			n.record = next
			return { kind: 'payload', payload: { type: 'ack', reqId: cmd.reqId, ok: true, result: { code: 'ok', rev: n.rev } } }
		},
	}
})

const copyOf = (keyID: string, userName: string): Loose => ({
	isReady: true,
	profiles: [{ keyID, userName }],
})

describe('first native write of a record waits for the confirmed native sync of the same account', () => {
	beforeEach(() => {
		jest.useFakeTimers()
		jest.resetModules()
		;(globalThis as { __fakeNative?: Native }).__fakeNative = { keys: { mnemonicPhrase: PHRASE, profiles: [{ keyID: KEY_ID, privateKeyArmor: KEY_HEX }] }, rev: 0, writes: [] }
	})
	afterEach(() => {
		jest.clearAllTimers()
		jest.useRealTimers()
	})

	it('the gate is closed: a first write creates nothing on the native side and throws nothing; the change is kept as an intent', async () => {
		const store = require('./shellRecordStore')
		store.resetShellRecordStoreForTest?.()
		await store.shellRecordRead({ source: 'init' })
		await store.shellRecordWrite(copyOf(KEY_ID, 'edited-name'))
		expect(fake().writes.length).toBe(0)
		expect(fake().record).toBeUndefined()
		expect(store.deferredWriteForTest()).not.toBeNull()
	})

	it('the gate is open for another account: the write of this account stays deferred', async () => {
		const store = require('./shellRecordStore')
		await store.shellRecordRead({ source: 'init' })
		store.allowFirstNativeWrite(OTHER_ID)
		await store.shellRecordWrite(copyOf(KEY_ID, 'edited-name'))
		await store.retryDeferredWriteNow()
		expect(fake().writes.length).toBe(0)
	})

	it('after the confirmed sync of this account, the deferred first write creates the record once, with the native wallet fields kept', async () => {
		const store = require('./shellRecordStore')
		await store.shellRecordRead({ source: 'init' })
		await store.shellRecordWrite(copyOf(KEY_ID, 'edited-name'))
		expect(fake().writes.length).toBe(0)
		store.allowFirstNativeWrite(KEY_ID)
		await store.retryDeferredWriteNow()
		expect(fake().writes.length).toBe(1)
		expect(fake().record?.profiles[0].userName).toBe('edited-name')
		expect(fake().record?.mnemonicPhrase).toBe(PHRASE)
		expect(fake().record?.profiles[0].privateKeyArmor).toBe(KEY_HEX)
		// the page's copy sent nothing that the native side does not allow
		expect(JSON.stringify(fake().writes[0])).not.toMatch(/privateKeyArmor|mnemonicPhrase/)
	})

	it('a native record already present is not gated (the gate only covers the first write)', async () => {
		fake().record = { isReady: true, rev: 1, mnemonicPhrase: PHRASE, beamio: { firstName: 'old' }, profiles: [{ keyID: KEY_ID, privateKeyArmor: KEY_HEX }] }
		fake().rev = 1
		const store = require('./shellRecordStore')
		await store.shellRecordRead({ source: 'init' })
		await store.shellRecordWrite({ isReady: true, beamio: { firstName: 'edited-name' }, profiles: [{ keyID: KEY_ID }] })
		expect(fake().writes.length).toBe(1)
		expect(fake().record?.beamio.firstName).toBe('edited-name')
	})

	it('an edit made before the first native write survives a restart: after the confirmed sync the restarted store writes it', async () => {
		// a minimal storage for the page (the node test has no window): the intent is stored there and read after the restart
		const mem = new Map<string, string>()
		;(globalThis as { window?: unknown }).window = { localStorage: { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) } }
		const first = require('./shellRecordStore')
		await first.shellRecordRead({ source: 'init' })
		await first.shellRecordWrite(copyOf(KEY_ID, 'edited-name'))
		expect(fake().writes.length).toBe(0)
		// restart: a fresh module, the intent is read from the page storage
		jest.resetModules()
		const second = require('./shellRecordStore')
		second.allowFirstNativeWrite(KEY_ID)
		second.resumeDeferredWrite()
		await second.retryDeferredWriteNow()
		expect(fake().writes.length).toBe(1)
		expect(fake().record?.profiles[0].userName).toBe('edited-name')
		delete (globalThis as { window?: unknown }).window
	})

	it('while the gate is closed a retry is not counted and schedules no timer; the gate opening retries at once', async () => {
		const store = require('./shellRecordStore')
		await store.shellRecordRead({ source: 'init' })
		await store.shellRecordWrite(copyOf(KEY_ID, 'edited-name'))
		const before = store.deferredWriteForTest()
		expect(before).not.toBeNull()
		await store.retryDeferredWriteNow()
		await store.retryDeferredWriteNow()
		expect(store.deferredWriteForTest().attempts).toBe(before.attempts)
		expect(jest.getTimerCount()).toBe(0)
		expect(fake().writes.length).toBe(0)
		store.allowFirstNativeWrite(KEY_ID)
		await store.retryDeferredWriteNow()
		expect(fake().writes.length).toBe(1)
		expect(store.deferredWriteForTest()).toBeNull()
	})
})
