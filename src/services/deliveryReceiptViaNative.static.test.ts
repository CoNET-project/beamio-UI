/**
 * Source guards for the delivered-receipt path (the native module sends the receipt; the page gives it the contact routes). SYNTHETIC.
 */
import fs from 'fs'
import path from 'path'

const SRC = path.join(__dirname, '..')
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8')
const app = read('App.tsx')
const chatTs = read('services/chat.ts')
const bridge = read('services/chatWorkerBridge.ts')

describe('a shell: the page receipt code does not run (the native module sends the receipt)', () => {
	it('the mailbox ACK for an incoming receipt is skipped in a shell, the browser condition is unchanged', () => {
		expect(app).toContain('if (!nativeReceiptPath() && !inboundAckIsBrowser() && armorHashRaw && ackCtx?.routerArmoredPublicKey && pk) {')
	})
	it('the sender receipt block needs a page key AND not a shell, whatever key the profile holds', () => {
		expect(app).toContain('if (pk && !nativeReceiptPath()) {\n\t\t\t\t\tvoid (async () => {\n\t\t\t\t\t\tlet senderPgp')
		expect(app).toContain('emitDualChatDeliveryReceipts({')
	})
})

describe('the routes reach the native module', () => {
	it('a route is offered only through the trust rule of a send (verified and the fingerprint equal), never straight from a lookup', () => {
		expect(chatTs).toContain('setTrustDecisionObserver((address, decision) => {')
		expect(chatTs).toContain('void receiptRouteTrust.observe(address, decision as never)')
		// the stored verified fingerprint is read from the page's stored copy (the send gate's source), not from the in-memory chat list
		expect(chatTs).toContain('createStoredTrustReader(readStoredProfilesForVerify')
		expect(chatTs).toContain('apply: applyNativeRouteEligibility')
		expect(chatTs).not.toContain('noteNativeContactRoute(walletAddress')
		expect(chatTs).toContain('export const isKnownChatContact')
		const rec = read('utils/recipientPublicKey.ts')
		expect(rec).toContain('export function decideTrustedRoute(')
		expect(rec).toContain("if (!verified) return { ok: false, code: 'first_fetch_pending', held }")
		expect(rec).toContain("if (fresh.fingerprint !== verified) return { ok: false, code: 'fingerprint_changed', held }")
	})
	it('an inbound sender and the cold-start contacts go through the same rule; a periodic refresh and a Verified tap re-offer', () => {
		expect(app).toContain('if (sender) void offerContactRoute(sender)')
		expect(app).toContain('await offerContactRoute(address)')
		expect(app).toContain('nativeRoutes.resend()')
		expect(app).toContain('.slice(0, 64)')
		const chatTsx = read('pages/chat/chat.tsx')
		expect(chatTsx).toContain('decideTrustedRoute(current, r)')
		expect(chatTsx).toContain('else void offerContactRoute(addr, { force: true })')
	})
	it('the table is sent only to a native client with the send capability, and cleared on an identity clear and on an own-account change', () => {
		expect(bridge).toContain('!activeClient || !activeClientIsNative || !nativeSendReady()) return false')
		expect(bridge).toMatch(/export const clearNativeChatIdentity = \(\): void => \{\n\tclearNativeRouteState\(\)/)
		expect(bridge).toContain('if (lastOwnEoaForRoutes && eoa !== lastOwnEoaForRoutes) clearNativeRouteState()')
	})
})

describe('the page calls setRoutes only when the native module declares the capability (run time, never a build switch)', () => {
	it('there is no build switch; the capability name is one constant', () => {
		const craco = fs.readFileSync(path.join(SRC, '..', 'craco.config.js'), 'utf8')
		expect(craco).not.toContain('NATIVE_DELIVERY_RECEIPT')
		expect(read('services/receiptCapability.ts')).toContain("export const RECEIPT_SENDER_CAPABILITY = 'receipt.delivery.v1'")
	})
	it('without the capability a shell behaves as before: no route is noted or sent, the page receipt code is not skipped', () => {
		expect(bridge).toContain('if (!nativeReceiptPath() || !activeClient || !activeClientIsNative || !nativeSendReady()) return false')
		expect(bridge).toContain('nativeReceiptPath() ? nativeRoutes.note(')
		expect(app).toContain('if (!nativeReceiptPath() && !inboundAckIsBrowser() && armorHashRaw')
		expect(app).toContain('if (pk && !nativeReceiptPath()) {')
	})
	it('the answer of setRoutes is logged with codes and integers only', () => {
		const t = read('services/nativeConetChatTransport.ts')
		expect(t).toContain("if (noReplyType === 'setRoutes') {")
		expect(t).toContain('routes ack ok=')
	})
})
