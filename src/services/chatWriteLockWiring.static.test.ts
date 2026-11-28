/**
 * @jest-environment node
 */
// where the write lock is taken and where the refreshes wait. A removed call fails here.
import fs from 'fs'
import path from 'path'

const read = (rel: string) => fs.readFileSync(path.join(__dirname, rel), 'utf8')
const chat = read('../pages/chat/chat.tsx')
const app = read('../App.tsx')

describe('writers take the lock before they change the list and release it at the commit', () => {
	it('outgoing writes: the persister takes the lock in the same turn and releases in finally (outgoingSend.ts)', () => {
		expect(read('outgoingSend.ts')).toMatch(/const release = beginChatWrite\(\)[\s\S]*\.finally\(release\)/)
	})
	it('received batches: the lock is taken before addNewMessage changes the list, and held by the commit until it settles (commit: storeSystemDataNow), also for replays', () => {
		expect(app).toMatch(/const endBatchLock = beginChatWrite\(\)\s*try \{\s*await addNewMessage\(/)
		expect(app).toMatch(/\} finally \{\s*endBatchLock\(\)/)
		expect(app).toMatch(/const endCommitLock = beginChatWrite\(\)[\s\S]*?\.finally\(endCommitLock\)/)
		expect(app).toMatch(/const endReplayLock = beginChatWrite\(\)[\s\S]*?\.finally\(endReplayLock\)/)
	})
})

describe('the refreshes wait for the last commit', () => {
	it('the chat page re-read is deferred while a write is in progress, merged by key, and re-run by a tick', () => {
		expect(chat).toMatch(/if \(isChatWriting\(\)\) \{\s*deferWhileWriting\('chat-reflash', \(\) => setReflashTick\(\(t\) => t \+ 1\)\)\s*return\s*\}/)
		expect(chat).toMatch(/\}, \[profiles, reflashTick\]\)/)
	})
	it('a read that began before a write is dropped and asked again (never applied over the write)', () => {
		expect(chat).toMatch(/const readVersion = chatWriteVersion\(\)/)
		expect(chat).toMatch(/if \(readIsStale\(readVersion\) \|\| isChatWriting\(\)\) \{[\s\S]*?return\s*\}\s*\/\/ Only pin after a real message change/)
	})
	it('the history overlay is held while a write is in progress and merged into one apply', () => {
		expect(app).toMatch(/if \(isChatWriting\(\)\) \{\s*heldHistoryEntries\.push\(\.\.\.entries\)\s*deferWhileWriting\('history-overlay', applyHeldHistory\)\s*return\s*\}/)
	})
	it('the controllable reloads go through requestControlledReload (no direct window.location.reload left in them)', () => {
		const sw = read('../serviceWorkerRegistration.js')
		expect(sw).toMatch(/requestControlledReload\(\)/)
		expect(sw).not.toMatch(/window\.location\.reload\(\)/)
		const loading = read('../pages/Home/LoadingPage.tsx')
		// the two Go-to-Home buttons are the user's own taps: they go through requestUserReload (held the same way, but the tap shows why)
		expect(loading.match(/requestUserReload\(\)/g)).toHaveLength(2)
		expect(loading).not.toMatch(/requestControlledReload\(\)/)
		expect(loading).not.toMatch(/window\.location\.reload\(\)/)
		expect(read('beamio.ts')).toMatch(/return requestControlledReload\(\)/)
	})
	it('every reload a button asks for goes through requestUserReload (the held tap is never silent); the automatic ones stay on requestControlledReload', () => {
		for (const f of ['../components/ShellIdentityClosedNotice.tsx', '../components/PgpRestoreFailedNotice.tsx', '../components/AppEntryGate.tsx', '../components/PgpFirstIdentityNotice.tsx']) {
			const src = read(f)
			expect(src).toMatch(/requestUserReload\(\)/)
			expect(src).not.toMatch(/requestControlledReload\(\)/)
		}
		expect(read('../index.tsx')).toMatch(/installReloadHeldNotice\(\)/)
		expect(read('reloadHeldNotice.ts')).toMatch(/onUserReloadHeld\(\(reason\) => showBeamioToast\(tu\(reloadHeldCopyKey\(reason, reloadHoldAwaitingStatus\(\), reloadHoldSoftKind\(\), reloadHoldFirmStatus\(\)\), \{ count: reloadHoldView\(\)\.count \}\)\)\)/)
	})
})
