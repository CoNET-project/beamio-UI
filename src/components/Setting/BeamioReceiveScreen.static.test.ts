/**
 * the receive card's BeamioTag is read from the account context on every render. It was copied once at mount, so after
 * a reload, when the account arrived later, the card stayed blank until the screen was mounted again. Reads the source; SYNTHETIC values only.
 */
import fs from 'fs'
import path from 'path'

const src = fs.readFileSync(path.join(__dirname, 'BeamioReceiveScreen.tsx'), 'utf8')

describe('the receive card reads the BeamioTag from the context, not from a copy taken at mount', () => {
	it('no state is initialised from beamio.accountName', () => {
		expect(src).not.toMatch(/useState\(beamio\?\.accountName\)/)
	})

	it('the card reads the account name from the current context value', () => {
		expect(src).toContain('const account = beamio?.accountName')
		expect(src).toContain('@{account}')
	})
})
