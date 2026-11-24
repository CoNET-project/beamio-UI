import { noteBridgeCommand } from './qaBridgeCounter'

const w = window as unknown as { __beamioQaBridgeCounts?: Record<string, number> }
const ORIGINAL = process.env.REACT_APP_QA_BRIDGE_COUNTER
afterEach(() => {
	process.env.REACT_APP_QA_BRIDGE_COUNTER = ORIGINAL
	delete w.__beamioQaBridgeCounts
})

describe('QA bridge counter', () => {
	it('is a no-op without the QA flag: no global, nothing stored', () => {
		delete process.env.REACT_APP_QA_BRIDGE_COUNTER
		noteBridgeCommand('chatModule', 'voiceCallV4Offer')
		expect(w.__beamioQaBridgeCounts).toBeUndefined()
	})
	it('with the QA flag it counts command names only', () => {
		process.env.REACT_APP_QA_BRIDGE_COUNTER = 'true'
		noteBridgeCommand('chatModule', 'voiceCallV4Offer')
		noteBridgeCommand('chatModule', 'voiceCallV4Offer')
		noteBridgeCommand('systemCall', 'prepareSystemCall')
		expect(w.__beamioQaBridgeCounts).toEqual({ 'chatModule:voiceCallV4Offer': 2, 'systemCall:prepareSystemCall': 1 })
	})
	it('a type that is not a plain name (a payload-like string, an object) is stored as "other", never as itself', () => {
		process.env.REACT_APP_QA_BRIDGE_COUNTER = 'true'
		noteBridgeCommand('chatModule', 'abandon abandon abandon secret phrase with spaces and more than sixty chars aaaaaaaaaaaaaaaaaaaaaaaaaaaa')
		noteBridgeCommand('chatModule', { mnemonic: 'x' })
		expect(w.__beamioQaBridgeCounts).toEqual({ 'chatModule:other': 2 })
	})
})
