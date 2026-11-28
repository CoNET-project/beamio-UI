/**
 * @jest-environment node
 *
 * the "not saved" state of a displayed inbound message is wired end to end: the append carries the sendId (App.tsx), the wait marks and clears it (inboundDurable.ts, tested in inboundDurable.test.ts and
 * inboundCrashRecovery.test.ts), the chat shows it in the message's own status row (chat.tsx), the wording is in both locale files. Static: reads the sources (no browser render).
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const read = (p: string): string => readFileSync(join(__dirname, '..', p), 'utf8')

describe('inbound "not saved" wiring', () => {
	it('the history append of an inbound row hands its sendId to the wait (inboundMirror.ts builds the mirror; tested in inboundMirror.test.ts)', () => {
		expect(read('services/inboundMirror.ts')).toContain("const sendId = typeof added.sendId === 'string' ? added.sendId : undefined")
		expect(read('services/inboundMirror.ts')).toContain('return { done: attempt(), retry: attempt, sendId, msgKey: input.msgKey, failure: input.failureOf ? () => input.failureOf?.(sendId) : undefined }')
		expect(read('App.tsx')).toContain('return inboundMirrorFor({')
	})
	it('the chat subscribes to the unsaved set and shows the copy on a received message (never a new component: the message status row)', () => {
		const chat = read('pages/chat/chat.tsx')
		expect(chat).toMatch(/useSyncExternalStore\(subscribeUnsavedInbound, unsavedInboundSendIds, unsavedInboundSendIds\)/)
		expect(chat).toMatch(/!isMe && m\.sendId && unsavedInboundIds\.has\(m\.sendId\)[\s\S]{0,200}tu\('chat\.status\.not_saved'\)/)
		const at = chat.indexOf("tu('chat.status.not_saved')")
		const rowStart = chat.lastIndexOf('<div className={["mt-1 flex items-center gap-2"', at)
		expect(rowStart).toBeGreaterThan(0)
		expect(at - rowStart).toBeLessThan(900) // inside the same time/status row as the sent/delivered labels
	})
	it('both locale files carry the wording', () => {
		const en = JSON.parse(read('locale/en.json')) as { ui: Record<string, string> }
		const zh = JSON.parse(read('locale/zh-CN.json')) as { ui: Record<string, string> }
		expect(en.ui['chat.status.not_saved']).toBe('Not saved on this device yet. Retrying.')
		expect(zh.ui['chat.status.not_saved']).toBe('未保存，正在重试')
	})
	it('the wait clears the mark on confirmation (and nowhere that would hide a missing clear on the confirm path)', () => {
		const d = read('services/inboundDurable.ts')
		const confirmBranch = d.slice(d.indexOf('if (ok) {'), d.indexOf('failedHere += 1'))
		expect(confirmBranch).toContain('clearUnsaved(item.hash)')
		expect(d).not.toMatch(/finally\s*\{[^}]*clearUnsaved/) // a finally-clear would make the confirm-path clear untestable
	})
})
