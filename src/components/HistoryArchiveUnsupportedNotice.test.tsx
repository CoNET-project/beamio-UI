// Unit level (jsdom has no Web Locks by default): the notice shows exactly where the history cannot be published.
import React from 'react'
import { render } from '@testing-library/react'
import { HistoryArchiveUnsupportedNotice, historyArchiveSupported } from './HistoryArchiveUnsupportedNotice'

jest.mock('@/services/shellContext', () => ({ isShellContext: jest.fn(() => false) }))
const shell = require('@/services/shellContext').isShellContext as jest.Mock
const set = (locks: unknown) => Object.defineProperty(window.navigator, 'locks', { value: locks, configurable: true })
afterEach(() => { set(undefined); shell.mockImplementation(() => false) })

it('no Web Locks: the notice is shown and names the official entry', () => {
	set(undefined)
	const r = render(<HistoryArchiveUnsupportedNotice />)
	const text = r.getByRole('alert').textContent || ''
	expect(text).toContain('https://beamio.ca/app/')
	expect(text).not.toContain('chat.history_archive_unsupported')
})
it('with Web Locks, or in a native shell, nothing is shown', () => {
	set({ request: () => undefined })
	expect(render(<HistoryArchiveUnsupportedNotice />).queryByRole('alert')).toBeNull()
	set(undefined); shell.mockImplementation(() => true)
	expect(render(<HistoryArchiveUnsupportedNotice />).queryByRole('alert')).toBeNull()
})
it('the test is the presence of navigator.locks', () => {
	expect([historyArchiveSupported(undefined), historyArchiveSupported({}), historyArchiveSupported({ locks: {} })]).toEqual([false, false, true])
})
it('the page renders it at the top level', () => {
	const app: string = require('fs').readFileSync(require('path').join(__dirname, '../App.tsx'), 'utf8')
	expect(app).toContain('<HistoryArchiveUnsupportedNotice />')
})
