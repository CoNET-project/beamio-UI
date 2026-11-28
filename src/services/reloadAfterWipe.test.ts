// The reload after the confirmed local reset goes through the single reload entry: the erased wallet's holds cannot keep it back, and it is issued once.
import { beginChatWrite, noteRequestInFlight, reloadHoldReason, requestControlledReload, requestReloadAfterLocalWipe, resetChatWriteLockForTest, setQueueHold } from './chatWriteLock'
import { beginPending, pendingCountOf } from './pendingSends'

beforeEach(() => resetChatWriteLockForTest())

it('queued items of the erased wallet do not hold the reset reload; a second request is merged into it', () => {
	const calls: string[] = []
	setQueueHold('wallet:peer', { firm: 2, awaiting: 1, awaitingSince: 1 })
	expect(requestControlledReload(() => calls.push('other'))).toBe(true) // held while the queue has items
	expect(calls).toEqual([])
	requestReloadAfterLocalWipe(() => calls.push('wipe'))
	expect(calls).toHaveLength(1)
	expect(requestControlledReload(() => calls.push('again'))).toBe(true)
	expect(calls).toHaveLength(1)
})
it('the lock screen has no reload of its own', () => {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const src: string = require('fs').readFileSync(require('path').join(__dirname, '../components/PasscodeLockScreen.tsx'), 'utf8')
	expect(src).not.toContain('location.reload()')
	expect(src).toContain('requestReloadAfterLocalWipe()')
})

it('every source is dropped, and an earlier held reload does not run again after the merge window', () => {
	jest.useFakeTimers()
	try {
		const calls: string[] = []
		setQueueHold('wallet:peer', { firm: 1, awaiting: 0, awaitingSince: null })
		noteRequestInFlight('s1')
		beginPending(`0x${'a1'.repeat(20)}`, 'voice')
		requestControlledReload(() => calls.push('held-earlier'))
		requestReloadAfterLocalWipe(() => calls.push('wipe'))
		expect(reloadHoldReason()).toBeNull()
		expect(pendingCountOf(`0x${'a1'.repeat(20)}`)).toBe(0)
		jest.advanceTimersByTime(60_000)
		const release = beginChatWrite() // a later writer finishing must not run a leftover
		release()
		jest.advanceTimersByTime(60_000)
		expect(calls).toEqual(['wipe'])
	} finally { jest.useRealTimers() }
})
it('a reload held BEFORE the reset does not run a second time after the reset has reloaded', () => {
	jest.useFakeTimers()
	try {
		const calls: string[] = []
		setQueueHold('wallet:peer', { firm: 1, awaiting: 0, awaitingSince: null })
		requestControlledReload(() => calls.push('held-earlier'))
		requestReloadAfterLocalWipe(() => calls.push('wipe'))
		jest.advanceTimersByTime(60_000) // past the 5 s merge window
		setQueueHold('wallet:peer', { firm: 0, awaiting: 0, awaitingSince: null }) // a later release must not run a leftover
		const release = beginChatWrite()
		release()
		jest.advanceTimersByTime(60_000)
		expect(calls).toEqual(['wipe'])
	} finally { jest.useRealTimers() }
})
it('only the lock screen may call it (anyone else could step over every hold with it)', () => {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const fs = require('fs'); const path = require('path')
	const root = path.join(__dirname, '..')
	const found: string[] = []
	const walk = (dir: string) => { for (const name of fs.readdirSync(dir)) { const p = path.join(dir, name); if (fs.statSync(p).isDirectory()) walk(p); else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name) && fs.readFileSync(p, 'utf8').includes('requestReloadAfterLocalWipe')) found.push(path.relative(root, p)) } }
	walk(root)
	expect(found.sort()).toEqual(['components/PasscodeLockScreen.tsx', 'services/chatWriteLock.ts'])
})
