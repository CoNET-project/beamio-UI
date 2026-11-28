/**
 * the profile provider's pin listener had no test. The listener is now a hook
 * (useFirstPinSync) that DaemonProvider calls. A behavioural test renders the hook and sends the real event; a static test pins the call in DaemonProvider,
 * the page listener in chat.tsx, and the dispatch in services/chat.ts, so removing any link of the chain fails a test. SYNTHETIC values.
 */
// openpgp is only used by async fingerprint reads that these cases never call (the jsdom environment cannot load its build)
jest.mock('openpgp', () => ({}))
import * as fs from 'fs'
import * as path from 'path'
import React, { useState } from 'react'
import { act, render } from '@testing-library/react'
import { useFirstPinSync } from './useFirstPinSync'
import { FIRST_PIN_APPLIED_EVENT, pinnedChatDataForOpenChat } from '@/services/peerRouteRecord'
import { readStoredKeyFingerprint } from '@/utils/pgpFingerprint'

const CONTACT = '0x' + 'ab12'.repeat(10)
const OTHER = '0x' + '33'.repeat(20)
const FP = '0123456789abcdef0123456789abcdef01234567'
const pinned = { publicArmored: 'ARMOR', routersArmoreds: 'ROUTE', routePgpKeyID: 'r1', fingerprint: FP }

let latest: Array<{ chats: Array<{ address: string; chatData?: Record<string, unknown> }> }> | null = null
function Harness({ initial }: { initial: unknown }) {
	const [profiles, setProfiles] = useState<any>(initial)
	useFirstPinSync(setProfiles)
	latest = profiles
	return null
}
const fire = (detail: unknown) => act(() => { window.dispatchEvent(new CustomEvent(FIRST_PIN_APPLIED_EVENT, { detail })) })

describe('useFirstPinSync (the profile provider state copy)', () => {
	it('the first-pin event writes the pin into the state copy of the contact row (behaviour)', () => {
		render(<Harness initial={[{ keyID: CONTACT, chats: [{ address: CONTACT, chatData: { publicArmored: '' } }, { address: OTHER, chatData: {} }] }]} />)
		expect(readStoredKeyFingerprint(latest![0].chats[0].chatData?.verifiedFingerprint as string)).toBeUndefined()
		fire({ address: CONTACT, pinned })
		expect(readStoredKeyFingerprint(latest![0].chats[0].chatData?.verifiedFingerprint as string)).toBe(FP)
		expect(latest![0].chats[1].chatData).toEqual({})
	})
	it('a malformed event changes nothing, and an unmounted provider no longer listens', () => {
		const view = render(<Harness initial={[{ keyID: CONTACT, chats: [{ address: CONTACT, chatData: {} }] }]} />)
		fire(undefined)
		fire({ address: CONTACT })
		expect(latest![0].chats[0].chatData).toEqual({})
		view.unmount()
		const before = latest
		fire({ address: CONTACT, pinned })
		expect(latest).toBe(before)
	})
})

describe('pinnedChatDataForOpenChat (the open chat page copy)', () => {
	it('pins the open contact once, never replaces a verified value, ignores another contact', () => {
		const open = { address: CONTACT, chatData: { publicArmored: 'OLD' } as Record<string, unknown> }
		const next = pinnedChatDataForOpenChat(open, CONTACT, pinned)!
		expect(next).not.toBe(open.chatData)
		expect(readStoredKeyFingerprint(next.verifiedFingerprint as string)).toBe(FP)
		expect(open.chatData.verifiedFingerprint).toBeUndefined() // a new object, never an in-place change
		const verified = { address: CONTACT, chatData: { verifiedFingerprint: `openpgp:${'e'.repeat(40)}` } }
		expect(pinnedChatDataForOpenChat(verified, CONTACT, pinned)).toBeNull()
		expect(pinnedChatDataForOpenChat(open, OTHER, pinned)).toBeNull()
		expect(pinnedChatDataForOpenChat(null, CONTACT, pinned)).toBeNull()
	})
})

describe('the chain of the pin is wired (static)', () => {
	const read = (rel: string) => fs.readFileSync(path.join(__dirname, rel), 'utf8')
	it('DaemonProvider calls the hook with its profile state setter', () => {
		expect(read('DaemonProvider.tsx')).toMatch(/useFirstPinSync\(setProfilesState\)/)
		expect(read('useFirstPinSync.ts')).toMatch(/window\.addEventListener\(FIRST_PIN_APPLIED_EVENT/)
		expect(read('useFirstPinSync.ts')).toMatch(/window\.removeEventListener\(FIRST_PIN_APPLIED_EVENT/)
	})
	it('the open chat page listens for the same event and updates its own copy', () => {
		const page = read('../pages/chat/chat.tsx')
		expect(page).toMatch(/window\.addEventListener\(FIRST_PIN_APPLIED_EVENT/)
		expect(page).toMatch(/pinnedChatDataForOpenChat\(current, d\.address, d\.pinned\)/)
	})
	it('the stored write announces the pin with the same event', () => {
		expect(read('../services/chat.ts')).toMatch(/new CustomEvent\(FIRST_PIN_APPLIED_EVENT/)
	})
})
