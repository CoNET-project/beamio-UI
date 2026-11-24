import { fireEvent, render, screen } from '@testing-library/react'
import { ChatHeaderIOS } from './ChatHeaderIOS'

jest.mock('@/locale/beamioLocale', () => ({ tu: (key: string) => key }))
jest.mock('@/components/IpfsImg', () => ({ IpfsImg: () => null }))

const base = { avatarSrc: '', onBack: () => undefined }
const byLabel = (label: string) => screen.getByLabelText(label) as HTMLButtonElement

describe('ChatHeaderIOS call button', () => {
  it('an old shell with the peer offline: enabled, labelled with the update line, a tap reaches onCall', () => {
    const onCall = jest.fn()
    render(<ChatHeaderIOS {...base} online={false} nativeWakeable={false} oldShell onCall={onCall} />)
    const b = byLabel('call.upgrade.chat')
    expect(b.disabled).toBe(false)
    expect(screen.queryByLabelText('Voice call unavailable')).toBeNull()
    fireEvent.click(b)
    expect(onCall).toHaveBeenCalledTimes(1)
  })
  it('a new shell (not old) with the peer offline and not wakeable: still disabled and "unavailable"', () => {
    const onCall = jest.fn()
    render(<ChatHeaderIOS {...base} online={false} nativeWakeable={false} onCall={onCall} />)
    const b = byLabel('Voice call unavailable')
    expect(b.disabled).toBe(true)
    fireEvent.click(b)
    expect(onCall).not.toHaveBeenCalled()
  })
  it('a browser (oldShell absent): unchanged, enabled when the peer is online, disabled when not', () => {
    const { unmount } = render(<ChatHeaderIOS {...base} online onCall={() => undefined} />)
    expect(byLabel('Start voice call').disabled).toBe(false)
    unmount()
    render(<ChatHeaderIOS {...base} online={false} onCall={() => undefined} />)
    expect(byLabel('Voice call unavailable').disabled).toBe(true)
  })
  it('a new shell with the peer wakeable (offline listen): enabled as before', () => {
    render(<ChatHeaderIOS {...base} online={false} nativeWakeable onCall={() => undefined} />)
    expect(byLabel('Start voice call').disabled).toBe(false)
  })
})
