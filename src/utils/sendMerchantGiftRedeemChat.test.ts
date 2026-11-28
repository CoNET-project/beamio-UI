/**
 * @jest-environment node
 */
// The gift delivery as the sheet calls it, with the chat transport, account record and history doubled. Synthetic values; the claim link is a marker string.
import { sendMerchantGiftRedeemChat } from './sendMerchantGiftRedeemChat'

if (!(globalThis as { crypto?: { subtle?: unknown } }).crypto?.subtle) {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	;(globalThis as unknown as { crypto: unknown }).crypto = require('crypto').webcrypto
}
const LINK = 'synthetic-claim-link-marker'
const mockDocs = new Map<string, string>()
const mockState = { answers: [] as boolean[], posted: [] as string[], statusesAtPost: [] as string[][], row: null as null | { address: string; messages: Array<{ status: string; sendId: string }> } }
jest.mock('@/services/chat', () => ({
	lookupRecipientRecord: () => undefined,
	createMerchantGiftRedeemCard: (p: { claimUrl: string }) => ({ sendId: 'card-1', id: 'card-1', from: 'me', text: '', createdAt: 1, status: 'sent', paymentCard: { cardType: 'merchantGift', cashcodeUrl: p.claimUrl, timeStamp: 1 } }),
	initMessage: async () => mockState.row,
	sendMessage: async (_k: string, payload: string) => { mockState.posted.push(payload); mockState.statusesAtPost.push(mockState.row!.messages.map((m) => m.status)); return mockState.answers.shift() ?? false },
}))
jest.mock('@/utils/recipientPublicKey', () => ({ resolveRecipientForSend: async () => ({ ok: true, publicArmored: 'k' }) }))
jest.mock('@/services/beamio', () => ({
	chatDraftDocAdapter: { read: async (id: string) => mockDocs.get(id) ?? null, put: async (id: string, t: string) => void mockDocs.set(id, t), remove: async (id: string) => void mockDocs.delete(id), list: async (p: string) => [...mockDocs.keys()].filter((k) => k.startsWith(p)).sort() },
	commitForChat: async () => 'written',
}))
jest.mock('@/services/durableCommit', () => ({ durableCommitError: () => null }))
jest.mock('@/services/chatHistoryMirror', () => ({ mirrorChatMessageToHistoryAck: async () => true }))
jest.mock('@/services/shellContext', () => ({ isShellContext: () => false }))
jest.mock('@/utils/globals', () => ({ CoNET_Data: null, setCoNET_Data: () => undefined }))

const FRIEND = `0x${'b2'.repeat(20)}`
const run = () => sendMerchantGiftRedeemChat({ profiles: [{ keyID: `0x${'a1'.repeat(20)}` } as unknown as profile], setProfiles: () => undefined, allNodes: [{} as nodeInfo], friend: { address: FRIEND } as searchResult, privateKeyArmor: `0x${'33'.repeat(32)}`, amount: 5, currency: 'USD' as ICurrency, merchantTitle: 'synthetic', claimUrl: LINK, note: 'synthetic note' })

beforeEach(() => { mockDocs.clear(); Object.assign(mockState, { answers: [], posted: [], statusesAtPost: [], row: { address: FRIEND, messages: [] } }) })

it('nothing is shown as sent before its own request was answered; the note succeeds and the card fails: the card is failed and both stay queued', async () => {
	mockState.answers = [true, false]
	const logs: string[] = []
	const spies = (['log', 'warn', 'error', 'info'] as const).map((k) => jest.spyOn(console, k).mockImplementation((...a) => { logs.push(a.join(' ')) }))
	const result = await run()
	spies.forEach((s) => s.mockRestore())
	expect(mockState.statusesAtPost).toEqual([['sending', 'sending'], ['sent', 'sending']])
	expect(mockState.row!.messages.map((m) => m.status)).toEqual(['sent', 'failed'])
	expect(result.ok).toBe(false)
	expect(`${result.error} ${logs.join(' ')}`).not.toContain(LINK)
	expect([...mockDocs.keys()].filter((k) => k.startsWith('chat-queue-v1:'))).toHaveLength(2)
	for (const stored of mockDocs.values()) expect(stored).not.toContain(LINK)
	// the payload of the card is the message as it was built
	expect(JSON.parse(mockState.posted[1]!)).toMatchObject({ sendId: 'card-1', status: 'sent', paymentCard: { cashcodeUrl: LINK } })
})
it('both answered with an empty 200: shown sent (never delivered), and both stay queued', async () => {
	mockState.answers = [true, true]
	expect((await run()).ok).toBe(true)
	expect(mockState.row!.messages.map((m) => m.status)).toEqual(['sent', 'sent'])
	expect(mockDocs.size).toBe(2)
})
