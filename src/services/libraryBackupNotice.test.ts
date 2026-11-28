/**
 * @jest-environment node
 */
// the "backup pending" notice (libraryBackupNotice.ts). Wait and wording are product decisions (pending), so both are constants and the tests pin the rule, not the numbers' wisdom.
import { readFileSync } from 'fs'
import { join } from 'path'
import { LIBRARY_BACKUP_NOTICE_AFTER_MS, LIBRARY_BACKUP_NOTICE_COPY_KEY, backupPendingSendIds } from './libraryBackupNotice'

const MIN = 60_000
describe('backupPendingSendIds', () => {
	const snap = (state: string, confirmedSince: number | null, sendId = 's') => ({ sendId, state, confirmedSince })
	it('10 minutes of being confirmed (receipt seen, copy not durable) shows the notice; before that it does not', () => {
		expect(LIBRARY_BACKUP_NOTICE_AFTER_MS).toBe(10 * MIN)
		expect(backupPendingSendIds([snap('confirmed', 0)], 10 * MIN - 1)).toEqual([])
		expect(backupPendingSendIds([snap('confirmed', 0)], 10 * MIN)).toEqual(['s'])
	})
	it('only confirmed items: awaiting (no proof yet), failed, queued, held and inflight never show it, whatever their age', () => {
		for (const state of ['awaiting', 'failed', 'queued', 'held', 'inflight', 'unknown']) expect(backupPendingSendIds([snap(state, 0)], 60 * MIN)).toEqual([])
	})
	it('an item that is not confirmed has no clock; two items are judged one by one; the wait is a parameter', () => {
		expect(backupPendingSendIds([snap('confirmed', null)], 60 * MIN)).toEqual([])
		expect(backupPendingSendIds([snap('confirmed', 0, 'old'), snap('confirmed', 9 * MIN, 'new')], 10 * MIN)).toEqual(['old'])
		expect(backupPendingSendIds([snap('confirmed', 0)], 2 * MIN, MIN)).toEqual(['s'])
	})
})

describe('the wording is replaceable and the screen shows it only for sent / delivered bubbles', () => {
	it('the copy key exists in both locale files with the expected Chinese and English lines; the module marks the English line as draft wording; the old "Backup pending" copy is gone', () => {
		const en = JSON.parse(readFileSync(join(__dirname, '../locale/en.json'), 'utf8')) as { ui: Record<string, string> }
		const zh = JSON.parse(readFileSync(join(__dirname, '../locale/zh-CN.json'), 'utf8')) as { ui: Record<string, string> }
		expect(LIBRARY_BACKUP_NOTICE_COPY_KEY).toBe('chat.status.backup_retrying')
		expect(zh.ui[LIBRARY_BACKUP_NOTICE_COPY_KEY]).toBe('本地备份仍在重试')
		expect(en.ui[LIBRARY_BACKUP_NOTICE_COPY_KEY]).toBe('Local backup is still retrying')
		expect(en.ui['chat.status.backup_pending']).toBeUndefined()
		expect(zh.ui['chat.status.backup_pending']).toBeUndefined()
		const mod = readFileSync(join(__dirname, 'libraryBackupNotice.ts'), 'utf8')
		expect(mod).toMatch(/\(locale\/en\.json\) is draft wording/)
		expect(mod).not.toMatch(/Backup pending|备份待完成|chat\.status\.backup_pending/)
		expect(JSON.stringify(en)).not.toMatch(/Backup pending/)
		expect(JSON.stringify(zh)).not.toContain('备份待完成')
	})
	it('chat.tsx evaluates the notice from the queue snapshot on a slow clock and renders it next to the status', () => {
		const chat = readFileSync(join(__dirname, '../pages/chat/chat.tsx'), 'utf8')
		expect(chat).toMatch(/const ids = backupPendingSendIds\(queue\.snapshot\(\), Date\.now\(\)\)/)
		expect(chat).toMatch(/\}, LIBRARY_BACKUP_NOTICE_CHECK_MS\)/)
		expect(chat).toMatch(/\(m\.status === "sent" \|\| m\.status === "delivered"\) && m\.sendId && backupPendingIds\.has\(m\.sendId\)/)
		expect(chat).toMatch(/window\.clearInterval\(backupTimer\)/)
	})
	it('the notice is really rendered (key chat.status.backup_retrying, 10 minutes, the retry goes on): a span with the copy key, inside the status area of a sent / delivered bubble', () => {
		const chat = readFileSync(join(__dirname, '../pages/chat/chat.tsx'), 'utf8')
		expect(chat).toMatch(/\{\(m\.status === "sent" \|\| m\.status === "delivered"\) && m\.sendId && backupPendingIds\.has\(m\.sendId\) && <span className="[^"]*">\{tu\(LIBRARY_BACKUP_NOTICE_COPY_KEY\)\}<\/span>\}/)
		// and it sits in the status block, after the Delivered label (not somewhere unreachable)
		const delivered = chat.indexOf('m.status === "delivered" && <span className="text-[#1652f0]">Delivered</span>')
		const notice = chat.indexOf('tu(LIBRARY_BACKUP_NOTICE_COPY_KEY)')
		expect(delivered).toBeGreaterThan(0)
		expect(notice).toBeGreaterThan(delivered)
		expect(notice - delivered).toBeLessThan(400)
		expect(LIBRARY_BACKUP_NOTICE_AFTER_MS).toBe(10 * MIN)
		expect(chat).toMatch(/const \[backupPendingIds, setBackupPendingIds\] = useState/)
		expect(chat).toMatch(/setBackupPendingIds\(\(prev\) =>/)
	})
})

