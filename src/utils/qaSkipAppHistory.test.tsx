// the hook-only switch "skip the App-level history restore": default OFF, persisted, wired behind the compile-time switch, and absent from production code. SYNTHETIC only.
import { readFileSync } from 'fs'
import { join } from 'path'
import { fireEvent, render, screen } from '@testing-library/react'
import QaSkipAppHistorySwitch from '../components/QaSkipAppHistorySwitch'
import { QA_SKIP_APP_HISTORY_KEY, qaSkipAppHistoryOn, setQaSkipAppHistory } from './qaSkipAppHistory'

const src = (rel: string) => readFileSync(join(__dirname, rel), 'utf8')
const memory = () => {
	const m = new Map<string, string>()
	return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m }
}

describe('qaSkipAppHistory (hook only, default OFF)', () => {
	afterEach(() => localStorage.clear())
	it('is OFF by default, ON only for the value 1, and a storage that fails leaves it OFF', () => {
		const kv = memory()
		expect(qaSkipAppHistoryOn(kv)).toBe(false)
		kv.setItem(QA_SKIP_APP_HISTORY_KEY, 'true')
		expect(qaSkipAppHistoryOn(kv)).toBe(false)
		kv.setItem(QA_SKIP_APP_HISTORY_KEY, '1')
		expect(qaSkipAppHistoryOn(kv)).toBe(true)
		expect(qaSkipAppHistoryOn({ getItem: () => { throw new Error('x') }, setItem: () => undefined, removeItem: () => undefined })).toBe(false)
		expect(qaSkipAppHistoryOn(null)).toBe(false)
	})
	it('set ON writes 1, set OFF removes the key (nothing else is stored)', () => {
		const kv = memory()
		setQaSkipAppHistory(true, kv)
		expect([...kv.m.entries()]).toEqual([[QA_SKIP_APP_HISTORY_KEY, '1']])
		setQaSkipAppHistory(false, kv)
		expect(kv.m.size).toBe(0)
	})
	it('the on-screen switch starts OFF, toggles and persists in localStorage (kept after a reload)', () => {
		const { unmount } = render(<QaSkipAppHistorySwitch />)
		expect(screen.getByTestId('qa-skip-app-history').getAttribute('data-on')).toBe('0')
		fireEvent.click(screen.getByTestId('qa-skip-app-history-toggle'))
		expect(screen.getByTestId('qa-skip-app-history').getAttribute('data-on')).toBe('1')
		expect(localStorage.getItem(QA_SKIP_APP_HISTORY_KEY)).toBe('1')
		unmount()
		render(<QaSkipAppHistorySwitch />)
		expect(screen.getByTestId('qa-skip-app-history').getAttribute('data-on')).toBe('1')
		fireEvent.click(screen.getByTestId('qa-skip-app-history-toggle'))
		expect(localStorage.getItem(QA_SKIP_APP_HISTORY_KEY)).toBeNull()
	})
})

describe('the skip is wired only behind the compile-time switch', () => {
	it('applyEntries skips (and returns) as its FIRST statement, only when the hook is compiled in and the switch is ON', () => {
		const app = src('../App.tsx')
		expect(app).toMatch(/const applyEntries = \(entries: HistoryEntry\[\]\) => \{\s*\n\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*if \(process\.env\.REACT_APP_QA_ACK_ORDER_HOOK === 'true' && qaSkipAppHistoryOn\(\)\) \{ qaEvent\('app_history_skipped'\); return \}\s*\n\s*if \(isChatWriting\(\)\) \{/)
		expect(app.match(/qaSkipAppHistoryOn\(\)/g)).toHaveLength(1)
	})
	it('the switch is mounted only in the hook variant', () => {
		expect(src('../index.tsx')).toMatch(/\{process\.env\.REACT_APP_QA_ACK_ORDER_HOOK === 'true' && <QaSkipAppHistorySwitch \/>\}/)
	})
	it('nothing else in the production sources names the switch (key, test id, event)', () => {
		const files = ['../App.tsx', '../index.tsx', '../services/chatWorkerBridge.ts', '../pages/chat/chat.tsx', '../services/historyRestoreApply.ts']
		for (const f of files) {
			const code = src(f).replace(/\/\*[\s\S]*?\*\//g, '')
			const hits = code.match(/beamio\.qa\.skipAppHistory|qa-skip-app-history|app_history_skipped/g) ?? []
			// only App.tsx names the event, only once; index.tsx mounts the component (its name is not one of the three strings)
			expect(hits.length).toBe(f === '../App.tsx' ? 1 : 0)
		}
	})
})
