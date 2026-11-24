/**
 * @jest-environment node
 */
import { getHistoryListStatus, resetHistoryListStatusForTest, setHistoryListStatus, subscribeHistoryListStatus } from './historyListStatus'

let mockShell = true
jest.mock('./shellContext', () => ({ isShellContext: () => mockShell }))

beforeEach(() => {
	mockShell = true
	resetHistoryListStatusForTest()
})

describe('the chat list status', () => {
	it('a shell starts "loading" and becomes "settled" when the read settles; listeners hear it once', () => {
		const seen: string[] = []
		subscribeHistoryListStatus((s) => seen.push(s))
		expect(getHistoryListStatus()).toBe('loading')
		setHistoryListStatus('settled')
		setHistoryListStatus('settled')
		expect(getHistoryListStatus()).toBe('settled')
		expect(seen).toEqual(['settled'])
	})
	it('a browser is always settled: its list and its empty state are unchanged', () => {
		mockShell = false
		expect(getHistoryListStatus()).toBe('settled')
		setHistoryListStatus('loading')
		expect(getHistoryListStatus()).toBe('settled')
	})
})
