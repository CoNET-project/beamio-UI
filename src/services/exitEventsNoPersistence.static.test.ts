/**
 * @jest-environment node
 *
 * nothing that makes an inbound message, the history, the send queue or the library durable hangs on a page-exit event (pagehide, beforeunload, unload, visibilitychange, freeze),
 * and the retry of a failed append does not either. Recovery after a refresh, a kill or a power loss must work without any page-exit write: the un-ACKed mailbox line IS the durable copy until the append is confirmed.
 * Known and accepted difference: chat.tsx `pagehide` / `visibilitychange(hidden)` runs the DRAFT autosaver's flushNow. It writes the text box draft only, never a message, the queue or the history.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const srcRoot = join(__dirname, '..')
const sdkRoot = join(__dirname, '..', '..', 'vendor', 'conet-chat-sdk', 'src')
const read = (p: string): string => readFileSync(p, 'utf8')
const code = (text: string): string => text.split('\n').filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n')
const walk = (dir: string, out: string[] = []): string[] => {
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, e.name)
		if (e.isDirectory()) walk(p, out)
		else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\./.test(e.name)) out.push(p)
	}
	return out
}
const EXIT = /addEventListener\(\s*['"](pagehide|beforeunload|unload|visibilitychange|freeze)['"]|\.on(pagehide|beforeunload|unload)\s*=/

describe('no persistence on page-exit events', () => {
	it('the modules that make chat data durable register NO exit event at all', () => {
		const modules = [
			'services/inboundDurable.ts', 'services/inboundBatchSettle.ts', 'services/inboundRowRecord.ts', 'services/chatHistoryMirror.ts', 'services/historyAppendAck.ts',
			'services/sendQueue.ts', 'services/sendFlow.ts', 'services/senderCopy.ts', 'services/browserInboundAck.ts', 'services/chatWorkerBridge.ts',
		]
		for (const m of modules) expect([m, EXIT.test(code(read(join(srcRoot, m))))]).toEqual([m, false])
		for (const f of walk(sdkRoot).filter((f) => /worker[\\/](history|local|gossip-core)/.test(f) || /[\\/]local[\\/]/.test(f))) expect([f, EXIT.test(code(read(f)))]).toEqual([f, false])
	})

	it('the inventory of every file that registers an exit event is fixed: a new registration must be reviewed (add it here with its reason)', () => {
		const found = walk(srcRoot).concat(walk(sdkRoot)).filter((f) => EXIT.test(code(read(f)))).map((f) => f.slice(srcRoot.length + 1)).sort()
		expect(found).toEqual([
			'App.tsx', // listen teardown / resume only
			'components/AppEntryGate.tsx', // start-judgement re-reads on visible
			'pages/Home/CreateUsernamePinScreen.tsx', // re-read on visible
			'pages/Home/RestoreWalletUnifiedScreen.tsx', // re-read on visible
			'pages/chat/chat.tsx', // visible resume kicks, and the DRAFT flush (known difference)
			'services/nativeRecovery.ts', // wait watcher on visible
			'services/shellSessionSigner.ts', // drops the in-memory session signer on pagehide
			'utils/cashTreesAppLifecycle.ts',
			'utils/cashTreesPushBind.ts',
			'utils/mobileWalletApps.ts',
			'utils/pwaLifecycleRecovery.ts',
		].sort())
	})

	it('App.tsx pagehide only pauses the gossip listen; its visibility handler only resumes it: no store, no append, no ACK in either', () => {
		const app = code(read(join(srcRoot, 'App.tsx')))
		const hide = app.slice(app.indexOf('const onPageHide = () => {'), app.indexOf("window.addEventListener('pagehide', onPageHide)"))
		expect(hide).toContain('pauseGossipListenOnBackground(setGossip)')
		expect(hide).not.toMatch(/storeSystemData|\bpersist[A-Z(]|append|mirror|ackMailbox|commit|localStorage|indexedDB|\.put\(|\.set\(/)
		const visEnd = app.indexOf("document.addEventListener('visibilitychange', onVisibility)")
		const vis = app.slice(app.lastIndexOf('const onVisibility = () => {', visEnd), visEnd)
		expect(vis).toContain('onForegroundResume()')
		expect(vis).not.toMatch(/storeSystemData|\bpersist[A-Z(]|append|mirror|ackMailbox|commit/)
	})

	it('chat.tsx exit handler writes the DRAFT only (known difference)', () => {
		const chat = code(read(join(srcRoot, 'pages/chat/chat.tsx')))
		expect(chat).toContain("const flush = () => { void draftAutosaverRef.current?.flushNow() }")
		expect(chat).toContain("window.addEventListener('pagehide', flush)")
	})

	it('the inbound retry loop (inboundDurable.ts) is driven by promises and a timer: no event listener of any kind', () => {
		const durable = code(read(join(srcRoot, 'services/inboundDurable.ts')))
		expect(durable).not.toMatch(/addEventListener|window\.|document\./)
		expect(durable).toMatch(/setTimeout/)
	})
})
