/**
 * @jest-environment node
 */
/**
 * r92 step 6 (draft 24.2 P2, 24.3): the page sends its mnemonic to the shell only from its own valid evidence. An empty phrase, an
 * unknown read, a confirmed empty store, or a phrase that does not derive to the EOA sends nothing. An unconfirmed reply never counts as
 * synced (the native side confirms after its read-back). P1 (the old-store migration) runs on the native side and is not tested here.
 */
import { ethers } from 'ethers'
import { createShellMnemonicSync, pageSyncPayload } from './shellMnemonicSync'

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const EOA = '0x9858effd232b4033e47d90003d41ec34ecaeda94'

describe('pageSyncPayload (P2: only valid page evidence is sent)', () => {
	it('a valid phrase that derives to the reported EOA is sent (lower case EOA)', () => {
		expect(pageSyncPayload({ kind: 'valid', phrase: PHRASE, eoa: EOA })).toEqual({ phrase: PHRASE, eoa: EOA })
	})

	it('unknown and confirmed empty evidence send nothing', () => {
		expect(pageSyncPayload({ kind: 'unknown' })).toBeNull()
		expect(pageSyncPayload({ kind: 'confirmed_empty' })).toBeNull()
	})

	it('a valid kind whose phrase does not derive to the EOA sends nothing', () => {
		const other = new ethers.Wallet('0x' + '22'.repeat(32)).address.toLowerCase()
		expect(pageSyncPayload({ kind: 'valid', phrase: PHRASE, eoa: other })).toBeNull()
	})

	it('an empty phrase or an empty EOA sends nothing', () => {
		expect(pageSyncPayload({ kind: 'valid', phrase: '   ', eoa: EOA })).toBeNull()
		expect(pageSyncPayload({ kind: 'valid', phrase: PHRASE, eoa: '' })).toBeNull()
	})
})

describe('the sync itself refuses an empty write and a non-address EOA before any send', () => {
	const make = (send: jest.Mock<Promise<'ok' | 'write_failed'>, [string, number, string, string]>) =>
		createShellMnemonicSync({ send, retryDelaysMs: [0], wait: async () => undefined, log: () => undefined, bridgeAvailable: () => true, nextSeq: () => 7 })

	it('an empty mnemonic is unavailable and nothing is sent', async () => {
		const send = jest.fn(async (_c: string, _t: number, _m: string, _e: string) => 'ok' as const)
		expect(await make(send).sync('  ', EOA)).toEqual({ kind: 'unavailable', tx: 7 })
		expect(send).not.toHaveBeenCalled()
	})

	it('an EOA that is not an address is unavailable and nothing is sent', async () => {
		const send = jest.fn(async (_c: string, _t: number, _m: string, _e: string) => 'ok' as const)
		expect(await make(send).sync(PHRASE, 'not-an-address')).toEqual({ kind: 'unavailable', tx: 7 })
		expect(send).not.toHaveBeenCalled()
	})

	it('the transaction number is a positive integer and is the one sent', async () => {
		const send = jest.fn(async (_c: string, _t: number, _m: string, _e: string) => 'ok' as const)
		const out = await make(send).sync(PHRASE, EOA)
		expect(out).toEqual({ kind: 'synced', tx: 7 })
		expect(send.mock.calls[0][1]).toBe(7)
	})
})

describe('an unconfirmed write keeps the home and never reports synced', () => {
	it('a write that is not confirmed ends as failed (the write is not success); a failed write is not retried by itself', async () => {
		const send = jest.fn(async (_c: string, _t: number, _m: string, _e: string) => 'write_failed' as const)
		const sync = createShellMnemonicSync({ send, retryDelaysMs: [0, 0], wait: async () => undefined, log: () => undefined, bridgeAvailable: () => true, nextSeq: () => 3 })
		expect((await sync.sync(PHRASE, EOA)).kind).toBe('failed')
		expect(send).toHaveBeenCalledTimes(1)
	})
})

describe('static pins: the gate sends only through pageSyncPayload', () => {
	it('AppEntryGate calls pageSyncPayload before shellMnemonicSync.sync', () => {
		const gate = require('fs').readFileSync(require('path').join(__dirname, '..', 'components', 'AppEntryGate.tsx'), 'utf8') as string
		const at = gate.indexOf('const syncPageMnemonicToShell')
		// the window covers the C1 pre-check and the record clear (v10 §五, §六.1) before the send
		const block = gate.slice(at, at + 1500)
		expect(block.indexOf('pageSyncPayload(ev)')).toBeGreaterThan(0)
		// the send goes through the per-session send-once guard (review item A), which calls shellMnemonicSync.sync after the guard
		expect(block.indexOf('sendPhraseOnce(payload)')).toBeGreaterThan(block.indexOf('pageSyncPayload(ev)'))
		const guard = gate.slice(gate.indexOf('const sendPhraseOnce'), gate.indexOf('const sendPhraseOnce') + 500)
		expect(guard.indexOf('sets.inFlight.has(key)')).toBeGreaterThan(0)
		expect(guard.indexOf('shellMnemonicSync.sync(payload.phrase')).toBeGreaterThan(guard.indexOf('sets.inFlight.has(key)'))
		expect(block).not.toMatch(/ev\.kind === 'valid' && ev\.phrase/)
	})
})
