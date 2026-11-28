/**
 * every send entry point applies the trust rule of. A send from a screen other than the chat page resolves its key through
 * resolveRecipientForSend (a held key is not sent). A non-text send in the chat page keeps its message with the held status and a retry
 * (settleSendStatus), and a call is gated at its start and its answer (resolveTrustedRoute). SYNTHETIC source checks only.
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const SRC = join(__dirname, '..')
const text = (f: string) => readFileSync(join(SRC, f), 'utf8')

describe('the screens other than the chat page refuse a held key (resolveRecipientForSend)', () => {
	const SCREENS = [
		'App.tsx',
		'renderAction/ActionRenderer.tsx',
		'utils/sendMerchantGiftRedeemChat.ts',
		'pages/chat/GroupChatScreen.tsx',
		'pages/Pay/send/index.tsx',
		'pages/Pay/PaymentLink/index.tsx',
		'pages/Vouchers/TopUpAccount.tsx',
	]
	for (const f of SCREENS) {
		it(`${f}: the key for a send comes from resolveRecipientForSend, not the old local-copy shortcut`, () => {
			const s = text(f)
			expect(s).toContain('resolveRecipientForSend(')
			expect(s).not.toContain('resolveRecipientPublicArmored(')
		})
	}

	it('aaMultisigGossip: the inner is sent only through resolveRecipientForSend', () => {
		const s = text('services/aaMultisigGossip.ts')
		expect(s).toContain('resolveRecipientForSend({ address: params.recipientEoa }, lookupRecipientRecord)')
		expect(s).toContain('if (!recipientKey.ok)')
	})

	it('the shared resolver refuses a held key: resolveRecipientForSend uses the trust rule', () => {
		const s = text('utils/recipientPublicKey.ts')
		const body = s.slice(s.indexOf('export async function resolveRecipientForSend'))
		expect(body).toContain('resolveTrustedRoute(chat, fetchRoute)')
		expect(body).toContain('if (!route.ok) return')
	})
})

describe('non-text sends in the chat page keep their message with the held status', () => {
	it('reaction, cancel and paid receipt use settleSendStatus (file and voice are queue items: chatMediaSend.ts)', () => {
		const s = text('pages/chat/chat.tsx')
		expect(s.match(/settleSendStatus\(/g)?.length ?? 0).toBeGreaterThanOrEqual(4)
		expect(s).toContain('const cancelStatus = settleSendStatus(')
		expect(s).toContain('const paidStatus = settleSendStatus(')
	})

	it('settleSendStatus keeps the wire text for the retry and schedules a route_unconfirmed hold', () => {
		const s = text('pages/chat/chat.tsx')
		const body = s.slice(s.indexOf('function settleSendStatus'), s.indexOf('function settleSendStatus') + 700)
		expect(body).toContain('heldSendsRef.current.set(tempId, { text: wire, attempt: 0, pinned: lastSendHeldRef.current })')
		expect(body).toContain("if (code === 'route_unconfirmed') scheduleHeldSend(tempId)")
	})

	it('the held statuses are the three trust codes, and the bubble offers the verify and retry actions', () => {
		const s = text('pages/chat/chat.tsx')
		expect(s).toContain('retryHeldSend(m.id as string, \'verify\')')
		expect(s).toContain('m.status === "first_fetch_pending"')
	})
})

describe('a call is gated at its start and at its answer', () => {
	it('the call start and the answer read the peer through resolveTrustedRoute, and a held call is not dialled or connected', () => {
		const s = text('pages/chat/chat.tsx')
		expect(s).toContain('const trust = await resolveTrustedRoute(chatData, lookupRecipientRecord)')
		expect(s).toContain('if (callHeldCode) {')
		expect(s).toContain('const callerPeer = await resolvePeerVoiceMaterialAsync(profiles?.[0]?.chats, callerEoa, privateKey)')
		expect(s).toContain('if (answerHeldCode) {')
	})
})
