// The real send button of the group screen: a group message on its way is counted as unsent (group messages have no queue in this release).
import '@testing-library/jest-dom'
import { act, fireEvent, render, screen } from '@testing-library/react'
import GroupChatScreen from './GroupChatScreen'
import { pendingCountOf, resetPendingSendsForTest } from '@/services/pendingSends'

const OWN = `0x${'a1'.repeat(20)}`
const mockSend = jest.fn()
const mockGroup = { roster: { groupId: 'g1', members: [{ eoa: `0x${'a1'.repeat(20)}` }], policy: { name: 'synthetic group', owner: `0x${'a1'.repeat(20)}` } }, messages: [], proposals: [], tombstone: false }
jest.mock('@/services/conetGroupChat', () => ({ createGroupChat: jest.fn(), endGroupChat: jest.fn(), listGroupChats: () => [mockGroup], sendGroupChatMessage: (...a: unknown[]) => mockSend(...a), subscribeGroupChats: () => () => undefined }))
jest.mock('@/services/chat', () => ({ lookupRecipientRecord: jest.fn() }))
jest.mock('@/utils/recipientPublicKey', () => ({ resolveRecipientForSend: async () => ({ ok: true, publicArmored: 'k', routersArmoreds: 'r' }) }))
jest.mock('@/utils/globals', () => ({ CoNET_Data: { profiles: [{ keyID: `0x${'a1'.repeat(20)}` }] } }))
jest.mock('@/providers/BeamioTagDatabaseProvider', () => ({ useBeamioTagDatabase: () => ({ resolveTagPlain: () => '' }) }))
jest.mock('@/hooks/useVisualViewportFrame', () => ({ useVisualViewportFrame: () => undefined }))
jest.mock('@/components/BeamioCircularBackButton', () => ({ BeamioCircularBackButton: () => null, BEAMIO_CIRCULAR_BACK_ROW_CLASS: '' }))

beforeEach(() => { resetPendingSendsForTest(); mockSend.mockReset() })

it.each(['resolves', 'rejects'])('counted from the click until the send %s', async (ending) => {
	let finish!: () => void
	mockSend.mockImplementation(() => new Promise((resolve, reject) => { finish = () => (ending === 'resolves' ? resolve({ acceptedRecipients: 0, failedRecipients: 0 }) : reject(new Error('offline'))) }))
	const view = render(<GroupChatScreen chats={[{ address: OWN, chatData: { routersArmoreds: 'r' } }] as unknown as chatData[]} ownEoa={OWN} onClose={() => undefined} />)
	fireEvent.click(screen.getByText('synthetic group'))
	fireEvent.change(screen.getByPlaceholderText('Message'), { target: { value: 'synthetic group text' } })
	await act(async () => { fireEvent.submit(view.container.querySelector('#group-compose-form')!) })
	expect(screen.queryByRole('alert')?.textContent ?? '').toBe('')
	expect([mockSend.mock.calls.length, pendingCountOf(OWN)]).toEqual([1, 1])
	view.unmount() // leaving the screen changes nothing
	expect(pendingCountOf(OWN)).toBe(1)
	await act(async () => { finish() })
	expect(pendingCountOf(OWN)).toBe(0)
})
