/**
 * Native no-key watcher and the native import route. SYNTHETIC values only: reqIds and
 * shell objects are made up for this file. No key material is sent or read.
 */
import { installNativeNoKeyWatcher, isNoKeyAck, NATIVE_QUERY_REQ_BASE, NATIVE_QUERY_REQ_END, readNativeWalletStatus } from './nativeKeyState'

// Loose view of the shell globals: the declared shell types are not used, so each test can install its own fake shell.
const w = window as unknown as { CashTreesIOS?: unknown; CashTreesAndroid?: unknown }

afterEach(() => {
	delete w.CashTreesIOS
	delete w.CashTreesAndroid
})

function chatEvent(name: string, event: unknown): void {
	window.dispatchEvent(new CustomEvent(name, { detail: { action: 'chatModuleEvent', event } }))
}

describe('isNoKeyAck', () => {
	it('is true only for a refused ack with error no_key', () => {
		expect(isNoKeyAck({ type: 'ack', reqId: 3, ok: false, error: 'no_key' })).toBe(true)
		expect(isNoKeyAck({ type: 'ack', reqId: 3, ok: true, error: 'no_key' })).toBe(false)
		expect(isNoKeyAck({ type: 'ack', reqId: 3, ok: false, error: 'not_supported' })).toBe(false)
		expect(isNoKeyAck({ type: 'ready', reqId: 3, ok: false, error: 'no_key' })).toBe(false)
		expect(isNoKeyAck(null)).toBe(false)
	})
})

describe('installNativeNoKeyWatcher', () => {
	it('reports a no_key ack from either shell event name, and stops after the remover', () => {
		const onNoKey = jest.fn()
		const remove = installNativeNoKeyWatcher(onNoKey)
		expect(remove).not.toBeNull()
		chatEvent('cashtreesios', { type: 'ack', reqId: 5, ok: false, error: 'no_key' })
		chatEvent('cashtreesandroid', { type: 'ack', reqId: 6, ok: false, error: 'no_key' })
		expect(onNoKey).toHaveBeenCalledTimes(2)
		remove?.()
		chatEvent('cashtreesios', { type: 'ack', reqId: 7, ok: false, error: 'no_key' })
		expect(onNoKey).toHaveBeenCalledTimes(2)
	})

	it('ignores other acks, other errors and details that are not chatModuleEvent', () => {
		const onNoKey = jest.fn()
		const remove = installNativeNoKeyWatcher(onNoKey)
		chatEvent('cashtreesios', { type: 'ack', reqId: 8, ok: false, error: 'locked' })
		chatEvent('cashtreesios', { type: 'ack', reqId: 9, ok: true })
		window.dispatchEvent(new CustomEvent('cashtreesios', { detail: { action: 'chatModuleSignRequest', event: { type: 'ack', ok: false, error: 'no_key' } } }))
		expect(onNoKey).not.toHaveBeenCalled()
		remove?.()
	})

	it('does not open the import route for the pre-init answer (the shell has its key but has not run init)', () => {
		// The answer code is not spelled out in the notes yet (to supply the literal). The page does not depend on it:
		// only `no_key` opens the lock page, so any other error code, including that one, leaves the chat screen as it is.
		const PRE_INIT_CODE_PLACEHOLDER = 'pre_init_code_pending_literal'
		const onNoKey = jest.fn()
		const remove = installNativeNoKeyWatcher(onNoKey)
		chatEvent('cashtreesios', { type: 'ack', reqId: 10, ok: false, error: PRE_INIT_CODE_PLACEHOLDER })
		chatEvent('cashtreesandroid', { type: 'ack', reqId: 11, ok: false, error: PRE_INIT_CODE_PLACEHOLDER })
		expect(onNoKey).not.toHaveBeenCalled()
		expect(isNoKeyAck({ type: 'ack', reqId: 10, ok: false, error: PRE_INIT_CODE_PLACEHOLDER })).toBe(false)
		remove?.()
	})
})

// Spec item 41 (2026-11-16): the native import screen is retired. The opener (openNativeKeyImport, nativeImportOpen) is deleted, so
// its six result cases are superseded and replaced by an absence assertion. The walletStatus read below is unchanged.
describe('the native import opener is retired', () => {
	it('nativeKeyState no longer exports an import opener or sends nativeImportOpen', () => {
		const ns = jest.requireActual('./nativeKeyState') as Record<string, unknown>
		expect(ns).not.toHaveProperty('openNativeKeyImport')
		expect(ns).not.toHaveProperty('NATIVE_IMPORT_OPEN')
	})
})

describe('readNativeWalletStatus (walletStatus after the import page closes)', () => {
	// the reply is an ack envelope with the data in result. G0 is ok:true with result.status "no_key".
	const reply = (payload: (reqId: number) => Record<string, unknown>) => {
		w.CashTreesIOS = {
			chatModuleCommand: (p: { command: { reqId: number } }) => chatEvent('cashtreesios', payload(p.command.reqId)),
		}
	}

	it('resolves unavailable outside a shell', async () => {
		expect(await readNativeWalletStatus(50)).toBe('unavailable')
	})

	it('sends only type and reqId, and reads result.status of the ack', async () => {
		const seen: Array<Record<string, unknown>> = []
		w.CashTreesIOS = {
			chatModuleCommand: (p: { command: Record<string, unknown> }) => {
				seen.push(p.command)
				chatEvent('cashtreesios', { type: 'ack', reqId: p.command.reqId, ok: true, result: { status: 'not_ready' } })
			},
		}
		expect(await readNativeWalletStatus(50)).toBe('not_ready')
		expect(Object.keys(seen[0]).sort()).toEqual(['reqId', 'type'])
		expect(seen[0].type).toBe('walletStatus')
	})

	it('reads each of the four states from result.status; G0 is ok:true, not an error', async () => {
		for (const status of ['no_key', 'not_ready', 'locked', 'unlocked']) {
			reply((reqId) => ({ type: 'ack', reqId, ok: true, result: { status } }))
			expect(await readNativeWalletStatus(50)).toBe(status)
		}
	})

	it('G2 may carry accountKey; only the status is read', async () => {
		reply((reqId) => ({ type: 'ack', reqId, ok: true, result: { status: 'unlocked', accountKey: 'synthetic' } }))
		expect(await readNativeWalletStatus(50)).toBe('unlocked')
	})

	it('the top-level status is not read', async () => {
		reply((reqId) => ({ type: 'ack', reqId, ok: true, status: 'unlocked' }))
		expect(await readNativeWalletStatus(50)).toBe('unknown')
	})

	it('ok:false with error no_key is not G0 for walletStatus', async () => {
		reply((reqId) => ({ type: 'ack', reqId, ok: false, error: 'no_key' }))
		expect(await readNativeWalletStatus(50)).toBe('unknown')
	})

	it('a value outside the four known states is unknown, and the page does not act on it', async () => {
		reply((reqId) => ({ type: 'ack', reqId, ok: true, result: { status: 'something_else' } }))
		expect(await readNativeWalletStatus(50)).toBe('unknown')
	})

	it('no reply in time is unavailable', async () => {
		w.CashTreesIOS = { chatModuleCommand: () => undefined }
		expect(await readNativeWalletStatus(20)).toBe('unavailable')
	})
})

describe('gate-query refusals never open the import route', () => {
	it('a no_key ack in the gate-query reqId range is ignored; the same code outside it still opens the route', () => {
		const onNoKey = jest.fn()
		const remove = installNativeNoKeyWatcher(onNoKey)
		chatEvent('cashtreesios', { type: 'ack', reqId: NATIVE_QUERY_REQ_BASE + 1, ok: false, error: 'no_key' })
		chatEvent('cashtreesandroid', { type: 'ack', reqId: NATIVE_QUERY_REQ_BASE + 10_000_001, ok: false, error: 'no_key' })
		expect(onNoKey).not.toHaveBeenCalled()
		chatEvent('cashtreesios', { type: 'ack', reqId: NATIVE_QUERY_REQ_END, ok: false, error: 'no_key' })
		expect(onNoKey).toHaveBeenCalledTimes(1)
		remove?.()
	})
})
