/**
 * @jest-environment node
 */
/**
 * item 2: the standalone signing pages (receive-wallet-send*.html) run the same refusal and probe at page start, and their own
 * scripts open no WebSocket. The head script is run in a fresh VM context (no network, no browser).
 */
import fs from 'fs'
import path from 'path'
import vm from 'vm'

const PAGES = ['receive-wallet-send.html', 'receive-wallet-send-sw.html']
const REFUSAL = 'websocket_disabled_by_project_rule'

const readPage = (name: string): string => fs.readFileSync(path.join(__dirname, '..', '..', 'public', name), 'utf8')
const headScript = (html: string): string => {
	const m = /<head><script>([\s\S]*?)<\/script>/.exec(html)
	return m ? m[1] : ''
}
const bodyOf = (html: string): string => html.replace(/<head>[\s\S]*?<\/head>/, '')

function runHead(name: string, sandbox: Record<string, unknown>): void {
	sandbox.window = sandbox
	vm.createContext(sandbox)
	vm.runInContext(headScript(readPage(name)), sandbox)
}

describe('standalone signing pages: WebSocket refusal and probe', () => {
	it.each(PAGES)('%s: the head installs the refusal and the probe reports refused', (name) => {
		const sandbox: Record<string, unknown> = { console: { error: jest.fn() } }
		runHead(name, sandbox)
		expect(sandbox.__beamioWsProbe).toBe('refused')
		expect((sandbox.console as { error: jest.Mock }).error).not.toHaveBeenCalled()
		expect(() => vm.runInContext("new window.WebSocket('ws://127.0.0.1:9')", sandbox)).toThrow(REFUSAL)
	})

	it.each(PAGES)('%s: a shell-owned WebSocket is left as it is and reported as not_guarded', (name) => {
		const shellCtor = function Shell() {}
		const sandbox: Record<string, unknown> = { console: { error: jest.fn() } }
		Object.defineProperty(sandbox, 'WebSocket', { value: shellCtor, writable: false, configurable: false, enumerable: false })
		runHead(name, sandbox)
		expect(sandbox.WebSocket).toBe(shellCtor)
		expect(sandbox.__beamioWsProbe).toBe('not_guarded')
		expect((sandbox.console as { error: jest.Mock }).error).toHaveBeenCalledWith(expect.stringContaining('[ws-guard]'))
	})

	it('both pages carry the same head guard', () => {
		expect(headScript(readPage(PAGES[0]))).toBe(headScript(readPage(PAGES[1])))
		expect(headScript(readPage(PAGES[0]))).not.toBe('')
	})

	it.each(PAGES)('%s: the page body opens no WebSocket (no constructor call, no ws/wss URL)', (name) => {
		const body = bodyOf(readPage(name))
		expect(body).not.toMatch(/new\s+(window\.)?WebSocket\s*\(/)
		expect(body).not.toMatch(/wss?:\/\//)
	})
})
