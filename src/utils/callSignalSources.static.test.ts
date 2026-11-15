/**
 * Review 1303e5e7 blocking items 1, 2 and 4, checked on the source (SYNTHETIC; no values): the call controller never sends to the offer's own
 * key or route; the answer uses the caller's verified record; the receipt to a sender is gated; no reader returns null for a failure.
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const SRC = join(__dirname, '..')
const text = (f: string) => readFileSync(join(SRC, f), 'utf8')

describe('call signalling sends only to the verified material', () => {
	it('the controller never uses the offer\'s own key or route as a send target', () => {
		const s = text('services/voiceCallController.ts')
		expect(s).not.toMatch(/voiceOfferB64Armor\(offer\.callerPgp\)/)
		expect(s).not.toMatch(/voiceOfferB64Armor\(offer\.callerRoute\)/)
	})

	it('the peer material is resolved through the trust rule (resolveTrustedRoute), not the local copy', () => {
		const s = text('services/voiceCallController.ts')
		expect(s).toContain("const trust = await resolveTrustedRoute({ address: addr, chatData: row?.chatData }, lookupRecipientRecord)")
		expect(s).toContain('if (!trust.ok) return empty')
	})

	it('the App\'s native busy reply and ringing receipt resolve the caller\'s verified material before they send', () => {
		const s = text('App.tsx')
		expect(s).toContain('resolvePeerVoiceMaterialAsync(profile.chats, callerEoa, busyKey).then((peer) => declineIncomingVoiceOffer(')
		expect(s).toContain('resolvePeerVoiceMaterialAsync(profile.chats, provenAddress, ringKey).then((peer) => notifyIncomingVoiceRinging(')
		expect(s).not.toMatch(/peerPgp: '',\s*\n\s*peerRoute: '',/)
	})
})

describe('the answer is judged on the caller\'s own record', () => {
	it('the answer resolves the caller from the profile chats, not from the open chat', () => {
		const s = text('pages/chat/chat.tsx')
		expect(s).toContain('const callerPeer = await resolvePeerVoiceMaterialAsync(profiles?.[0]?.chats, callerEoa, privateKey)')
		expect(s).not.toContain('resolveTrustedRoute({ address: callerEoa, chatData: chatData.chatData }')
	})
})

describe('the sender receipt goes only to the verified sender key', () => {
	it('the sender key for the receipt comes from resolveRecipientForSend, and a held key sends no receipt', () => {
		const s = text('App.tsx')
		expect(s).toContain('const receiptSender = await resolveRecipientForSend({ address: nextChat.address, chatData: nextChat.chatData }, lookupRecipientRecord)')
		expect(s).toContain('senderPublicArmored: receiptSender.ok ? receiptSender.publicArmored : null')
	})
})

describe('no account reader returns null for a failure, and a failed read writes nothing', () => {
	it('getUserInfo is gone in every form: no export, no re-export, no import, no call in any source file (abis excluded: contract names)', () => {
		const b = text('services/beamio.ts')
		expect(b).not.toMatch(/\bgetUserInfo\b/)
		const { readdirSync, statSync } = require('fs') as typeof import('fs')
		const walk = (dir: string): string[] =>
			readdirSync(dir).flatMap((name) => {
				const full = join(dir, name)
				return statSync(full).isDirectory() ? walk(full) : [full]
			})
		const offenders = walk(SRC)
			.filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.(ts|tsx)$/.test(f) && !/abis\.ts$/.test(f))
			.filter((f) => /\bgetUserInfo\b/.test(readFileSync(f, 'utf8')))
		expect(offenders.map((f) => f.replace(SRC, ''))).toEqual([])
	})

	it('the legacy registry read writes nothing from a failed read: no regenerate, no create, no assignment', () => {
		const b = text('services/beamio.ts')
		expect(b).toContain("if (legacyRead.status === 'network_error') return { ok: false, beamio: fallbackBeamio }")
		expect(b).toContain('if (ok) temp.beamio = migratedBeamio')
	})

	it('the restore writes the local name only for a valid "no account", never for a failed read', () => {
		const b = text('services/beamio.ts')
		expect(b).toContain("} else if (onchainRead.status === 'no_account' && !temp.beamio) {")
		expect(b).not.toContain("} else if (!temp.beamio) {\n\t\t\ttemp.beamio = buildMinimalBeamioFromAccountName(accountName)")
	})

	it('the loading page writes its record only for a chain record, a valid "no account", or the deferred path', () => {
		const l = text('pages/Home/LoadingPage.tsx')
		expect(l).toContain('if (mayWriteRecord) working.beamio = bo')
		expect(l).toContain("setAccountInfoUnavailable('network_error')")
		expect(l).not.toMatch(/\n\t\tworking\.beamio = bo\n/)
	})
})
