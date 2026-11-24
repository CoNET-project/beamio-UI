/**
 * @jest-environment node
 */
/**
 * The chat list says "loading" until a shell's history read settled; only a settled read with no rows is the empty state. Source pins.
 */
import * as fs from 'fs'
import * as path from 'path'

const list = fs.readFileSync(path.join(__dirname, 'ChatList.tsx'), 'utf8')
const app = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'App.tsx'), 'utf8')

describe('chat list empty state', () => {
	it('"No conversations yet" shows only when the read is not loading; loading shows its own line', () => {
		expect(list).toMatch(/\{!items\.length && historyStatus === 'loading' && \(/)
		expect(list).toMatch(/\{!items\.length && historyStatus !== 'loading' && \(/)
		expect(list).toMatch(/tu\('chat\.list_loading'\)/)
	})
	it('rows that exist are always shown (the loading line is only for an empty list)', () => {
		expect(list).toMatch(/const historyStatus = useSyncExternalStore\(subscribeHistoryListStatus, getHistoryListStatus, getHistoryListStatus\)/)
	})
})

describe('App: the shell reads the history without a page key', () => {
	it('ready means the account exists and the native client is bound to it (shell); the browser keeps the page key rule', () => {
		expect(app).toMatch(/const keyReady = isShellContext\(\) \? !!account && boundAccountOfActiveClient\(\) === account : !!resolveSigningPrivateKeyArmor\(profiles\?\.\[0\]\)/)
	})
	it('the epoch includes the chat-started tick, so a started chat reads once more', () => {
		expect(app).toMatch(/epoch: workerEpoch \+ shellStartedTick/)
		expect(app).toMatch(/onShellChatStarted\(\(\) => setShellStartedTick/)
	})
	it('the shell account is the native EOA (and only while the profile is that account); the batch check is the native EOA', () => {
		expect(app).toMatch(/return native && keyId === native \? native : historyAccountOf\(profile\)/)
		expect(app).toMatch(/shellAccountCheck: isShellContext\(\) \? \(account: string\) => shellPublicEoaOrEmpty\(\)\.toLowerCase\(\) === account : undefined/)
	})
	it('the shell scheduler uses the cold-start backoff and reports the list status; the browser gets neither', () => {
		expect(app).toMatch(/backoff: isShellContext\(\) \? createColdStartBackoff\(\) : undefined/)
		expect(app).toMatch(/onStatus: isShellContext\(\) \? setHistoryListStatus : undefined/)
	})
	it('the account-change and history-load effects still use the page-key account (unchanged for the browser and for key-holding shells)', () => {
		expect(app).toMatch(/const historyEoa = historyAccountOf\(profiles\?\.\[0\]\)/)
	})
})
