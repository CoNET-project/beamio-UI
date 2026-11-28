/**
 * @jest-environment node
 */
// An outgoing message is stored in the `sending` state before the send, and every outgoing write is written at once (flushStoreSystemData) and in order (persistOutgoing):
// storeSystemData() alone only schedules a write (a 200 ms debounce that every later call restarts).
import fs from 'fs'
import path from 'path'

const chat = fs.readFileSync(path.join(__dirname, 'chat.tsx'), 'utf8')
const fn = (name: string, to: string): string => chat.slice(chat.indexOf(name), chat.indexOf(to, chat.indexOf(name)))

describe('the outgoing message is written at once', () => {
	it('storageData writes at once when asked, through the commit the chat can read (commitForChat), the debounced write otherwise', () => {
		const body = fn('const storageData = async (immediate = false)', 'storageDataRef.current = storageData')
		expect(body).toMatch(/const failure = durableCommitError\(await commitForChat\(\)\)\s*if \(failure\) throw failure\s*\} else await storeSystemData\(\)/)
	})
	it('send() stores the sending message BEFORE the network send and the network send waits for it (local first, then the network)', () => {
		const body = fn('async function send()', 'async function deliverText')
		const store = body.indexOf('storedSendingRef.current = persistOutgoing(tempId)')
		const wait = body.indexOf("await sendWithRecord({")
		const deliver = body.indexOf('await deliverText(')
		expect(store).toBeGreaterThan(0)
		expect(wait).toBeGreaterThan(store)
		expect(deliver).toBeGreaterThan(wait)
		expect(body.indexOf('chatData.messages = next', body.indexOf('const pendingMsg'))).toBeLessThan(store)
		expect(body.indexOf('await deliverText(')).toBeGreaterThan(wait)
	})
	it('deliverText writes the sent and the failed state at once, in order (no debounced write is left in it)', () => {
		const body = fn('async function deliverText', 'deliverTextRef.current = deliverText')
		expect(body.match(/await persistOutgoingAfterSend\(\)/g)).toHaveLength(2)
		expect(body).not.toMatch(/await storageData\(\)/)
	})
	it('the writes are chained so the sent write never lands before the sending write', () => {
		expect(chat).toMatch(/createOutgoingPersister\(\(\) => \(storageDataRef\.current \? storageDataRef\.current\(true\)/)
		const mod = fs.readFileSync(path.join(__dirname, '../../services/outgoingSend.ts'), 'utf8')
		expect(mod).toMatch(/const release = beginChatWrite\(\)\s*const run = tail\s*\.catch\(\(\) => undefined\)\s*\.then\(write\)[\s\S]*?\.finally\(release\)/)
	})
	it('a stored sending message of an earlier page load is shown as failed (tap to retry), on mount and on a refresh of the page state', () => {
		expect(chat).toMatch(/useState<ChatMessage\[\]>\(\(\) => settleStaleSending\(chatData\.messages, CHAT_PAGE_START_MS\)\)/)
		expect(chat).toMatch(/const remote = settleStaleSending\(await Promise\.all/)
	})
})
