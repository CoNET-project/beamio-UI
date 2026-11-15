/**
 * no send reads the recipient's armor from the stored chat copy any more. The shell read-back strips it (spec.2,
 * ruling a), so a send resolves it from AddressPGP first, and a silent return on a missing armor is not allowed.
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const SRC = join(__dirname, '..')
const FILES = [
	'App.tsx',
	'pages/chat/chat.tsx',
	'pages/Pay/send/index.tsx',
	'pages/Vouchers/TopUpAccount.tsx',
	'pages/Pay/PaymentLink/index.tsx',
	'utils/sendMerchantGiftRedeemChat.ts',
	'renderAction/ActionRenderer.tsx',
]
const text = (f: string) => readFileSync(join(SRC, f), 'utf8')

describe('the send paths resolve the recipient armor at the send', () => {
	for (const f of FILES) {
		it(`${f}: no guard on the stored armor and no direct send with it`, () => {
			const s = text(f)
			expect(s).not.toMatch(/!\s*chat(Data)?\??\.chatData\??\.publicArmored\)/)
			expect(s).not.toMatch(/sendMessage\(\s*chat(Data)?\.chatData\.publicArmored/)
		})
	}

	it('chat.tsx sends through the resolution (no silent return on a missing key)', () => {
		const s = text('pages/chat/chat.tsx')
		expect(s).toContain('resolveRecipientForSend(chatData, lookupRecipientRecord)')
		expect(s).toContain('recipientArmorForSend()')
		expect(s).toContain('setChatError(chatHeldBannerText(keyed.code))')
	})

	it('App.tsx auto reply logs the fixed code instead of returning silently', () => {
		const s = text('App.tsx')
		expect(s).toContain('auto reply not sent: ${recipient.code}')
	})
})

/** every send entry point gives a visible error with a fixed code when the key is missing or invalid. */
describe('the send entry points show their error with a fixed code', () => {
	const contains = (file: string, text: string) => expect(text_of(file)).toContain(text)
	const text_of = (f: string) => text(f)

	it('chat.tsx: the send goes through the refresh-aware send and shows the key or refresh error', () => {
		contains('pages/chat/chat.tsx', 'sendWithFreshRoute(current, text, privateKey')
		contains('pages/chat/chat.tsx', 'setChatError(chatHeldBannerText(result.code))')
		contains('pages/chat/chat.tsx', 'chatHeldBannerText(result.code)')
		contains('pages/chat/chat.tsx', 'sendError: lastSendCodeRef.current')
	})

	it('chat.tsx: the recipient key refresh does not need a page private key', () => {
		const s = text('pages/chat/chat.tsx')
		const a = s.indexOf("// the peer's key and mailbox route")
		const b = s.indexOf('/** the send to the chat', a)
		expect(a).toBeGreaterThan(-1)
		expect(b).toBeGreaterThan(a)
		expect(s.slice(a, b)).not.toContain('privateKey')
		expect(s.slice(a, b)).toContain('refreshRecipient(current, lookupRecipientRecord)')
	})

	it('Pay, TopUp: the key is resolved before the card is added; a failure is shown with its code', () => {
		contains('pages/Pay/send/index.tsx', 'receiptNotSentText(recipientKey.code)')
		contains('pages/Vouchers/TopUpAccount.tsx', 'receiptNotSentText(recipientKey.code)')
	})

	it('PaymentLink, gift redeem, ActionRenderer: the visible error carries the code', () => {
		contains('pages/Pay/PaymentLink/index.tsx', "Could not create chat or get node (${recipientKey.ok ? 'no_nodes' : recipientKey.code})")
		contains('utils/sendMerchantGiftRedeemChat.ts', "(${recipientKey.ok ? 'no_chat' : recipientKey.code})")
		contains('renderAction/ActionRenderer.tsx', 'Could not get recipient PGP key (${recipientKey.code})')
	})

	it('group chat: members are resolved at create, send and end; a missing member is an error, not dropped', () => {
		const s = text('pages/chat/GroupChatScreen.tsx')
		expect(s).toContain('resolveRoutes(chats, selected)')
		expect(s).toContain('resolveRoutes(chats, memberEoas)')
		expect(s.match(/if \(missing\.length\) throw new Error\(missingText\(missing\)\)/g)?.length).toBe(3)
		expect(s).not.toContain('routesFor(')
	})

	it('App auto reply: a missing key is stored on the reply with its code', () => {
		contains('App.tsx', "sendError: failedCode")
		contains('App.tsx', 'auto reply not sent: ${recipient.code}')
	})
})

/**  (with  / ): every send fetches first; a failed fetch is held; "send anyway"is the user's choice and is marked. */
describe('the held send and "send anyway" (.5)', () => {
	it('chat.tsx: a failed fetch holds the text send, with Retry and Send anyway; the cached route is marked', () => {
		const s = text('pages/chat/chat.tsx')
		expect(s).toContain("const held = failCode === 'route_unconfirmed' || failCode === 'fingerprint_changed' || failCode === 'first_fetch_pending'")
		expect(s).toContain('scheduleHeldSend(tempId)')
		expect(s).toContain("retryHeldSend(m.id as string, 'cached')")
		expect(s).toContain('chat.held.action.send_anyway')
		expect(s).toContain('sendViaCachedRoute(current, text, privateKey')
		expect(s).toContain('sentViaUnconfirmedRoute')
		expect(s).toContain('RECIPIENT_ROUTE_RETRY_DELAYS_MS')
	})
})

describe('the three results and the changed-key hold are on the chat page', () => {
	it('chat.tsx: no_record and network_error have their own copy; a changed key is held with an accept action', () => {
		const s = text('pages/chat/chat.tsx')
		expect(s).toContain('chatHeldBannerText(result.code)')
		expect(s).toContain('chatHeldLabelText("fingerprint_changed")')
		expect(s).toContain("retryHeldSend(m.id as string, 'accept')")
		expect(s).toContain('retryHeldSend(m.id as string, \'verify\')')
	})
	it('the shared read is the three-valued lookup (chat.ts over recipientRecord.ts), used by the recipient paths', () => {
		const c = text('services/chat.ts')
		const r = text('services/recipientRecord.ts')
		expect(c).toContain('export const lookupRecipientRecord')
		expect(c).toContain('readRecipientRecord(')
		expect(r).toContain("status: 'network_error'")
		expect(r).toContain("status: 'no_record'")
	})

	it('the one-read rule: a failed read throws in getKeysFromCoNETPGPSC and is never null', () => {
		const c = text('services/chat.ts')
		expect(c).toContain("if (lookup.status === 'network_error') throw new RecipientReadError(lookup.reason)")
		expect(c).toContain("if (lookup.status === 'no_record') return null")
	})
})


describe('the auto reply and the temporary state are wired', () => {
	it('App.tsx: a relay that does not accept the reply is shown on the reply', () => {
		const s = text('App.tsx')
		expect(s).toContain('auto reply not delivered: send_failed')
		expect(s).toContain("sendError: 'send_failed'")
	})
	it('the temporary PGP state has its own notice, shown before the restore failure', () => {
		const n = text('components/ShellChatUnavailableNotice.tsx')
		expect(n).toContain('ShellPgpTemporaryNotice')
		expect(n.indexOf('if (pgpTemporary) return <ShellPgpTemporaryNotice />')).toBeLessThan(n.indexOf('if (pgp) return <PgpRestoreFailedNotice'))
	})
})
