/**
 * @jest-environment node
 *
 * QA builds only: the full history read says why it did not start (keyReady, epoch, a reason). Booleans and an integer, once per distinct state;
 * nothing in the default build; no behaviour change. SYNTHETIC values.
 */
import { createCorpusReadScheduler, type CorpusReadState } from './historyCorpusRead'

const ACCOUNT = '0x1111111111111111111111111111111111111111'
const st = (over: Partial<CorpusReadState> = {}): CorpusReadState => ({ account: ACCOUNT, keyReady: true, epoch: 1, ...over })
const ORIGINAL = process.env.REACT_APP_QA_BRIDGE_COUNTER
afterEach(() => {
	process.env.REACT_APP_QA_BRIDGE_COUNTER = ORIGINAL
})

function scheduler() {
	const lines: string[] = []
	const read = jest.fn(async () => [])
	const s = createCorpusReadScheduler({ read, apply: () => undefined, boundAccount: () => ACCOUNT, log: (l) => void lines.push(l) })
	return { s, lines, read }
}

describe('corpus read not started: QA log', () => {
	it('logs no_page_key, client_not_ready and the both-case, with booleans and the epoch only, once per distinct state', () => {
		process.env.REACT_APP_QA_BRIDGE_COUNTER = 'true'
		const { s, lines, read } = scheduler()
		s.sync(st({ keyReady: false, epoch: 0 }))
		s.sync(st({ keyReady: false, epoch: 0 }))
		s.sync(st({ keyReady: false, epoch: 2 }))
		s.sync(st({ keyReady: true, epoch: 0 }))
		expect(lines).toEqual([
			'[history] corpus read not started keyReady=false epoch=0 reason=no_page_key_and_client_not_ready',
			'[history] corpus read not started keyReady=false epoch=2 reason=no_page_key',
			'[history] corpus read not started keyReady=true epoch=0 reason=client_not_ready',
		])
		expect(read).not.toHaveBeenCalled()
		expect(lines.join('\n')).not.toContain(ACCOUNT)
	})
	it('the default build logs nothing and behaves the same', () => {
		delete process.env.REACT_APP_QA_BRIDGE_COUNTER
		const { s, lines, read } = scheduler()
		s.sync(st({ keyReady: false, epoch: 0 }))
		s.sync(st({ keyReady: true, epoch: 0 }))
		expect(lines).toEqual([])
		expect(read).not.toHaveBeenCalled()
	})
	it('with the key and a client the read still starts (no behaviour change), and logs no not-started line', async () => {
		process.env.REACT_APP_QA_BRIDGE_COUNTER = 'true'
		const { s, lines, read } = scheduler()
		s.sync(st())
		await new Promise((r) => setTimeout(r, 0))
		expect(read).toHaveBeenCalledTimes(1)
		expect(lines.some((l) => l.includes('not started'))).toBe(false)
	})
})
