/**
 * @jest-environment node
 */
// pinFirstFingerprintOfKnownContact (chat.ts) writes the first pinned value for a KNOWN contact only. SYNTHETIC values.
jest.mock('@/workers/appDaemon/client', () => ({}))
jest.mock('@/workers/beamioTag/client', () => ({}))
jest.mock('@/services/chatWorkerBridge', () => ({}))
jest.mock('@/services/chatMediaWorkerBridge', () => ({}))
jest.mock('@/services/argon2WorkerBridge', () => ({}))

const CONTACT = '0x' + 'ab12'.repeat(10)
const OTHER = '0x' + '33'.repeat(20)
const FP = '0123456789abcdef0123456789abcdef01234567'
const pinned = { publicArmored: 'ARMOR', routersArmoreds: 'ROUTE', routePgpKeyID: 'r1', fingerprint: FP }

function load(saved: boolean) {
	const store = jest.fn(async () => saved)
	let chat: typeof import('./chat') | undefined
	let globals: typeof import('@/utils/globals') | undefined
	jest.isolateModules(() => {
		jest.doMock('@/services/beamio', () => ({ ...jest.requireActual('@/services/beamio'), storeSystemDataAndWait: store, storeSystemData: jest.fn() }))
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		globals = require('@/utils/globals')
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		chat = require('./chat')
	})
	return { chat: chat!, globals: globals!, store }
}
const withRows = (g: typeof import('@/utils/globals'), chats: unknown[]) => g.setCoNET_Data({ profiles: [{ keyID: CONTACT, chats }] } as never)
const rowsOf = (g: typeof import('@/utils/globals')) => (g.CoNET_Data as unknown as { profiles: Array<{ chats: Array<{ address: string; chatData?: { verifiedFingerprint?: string; keyFingerprint?: string } }> }> }).profiles[0].chats

describe('pinFirstFingerprintOfKnownContact', () => {
	it('a saved pin announces itself for the page state copy (and a failed save does not)', async () => {
		const sent: Array<{ type: string; detail: { address: string; pinned: { fingerprint: string } } }> = []
		const ok = load(true)
		const bad = load(false)
		withRows(ok.globals, [{ address: CONTACT, chatData: {} }])
		withRows(bad.globals, [{ address: CONTACT, chatData: {} }])
		// the window only exists while the pin is recorded (module loading needs none)
		const g = globalThis as unknown as { CustomEvent?: unknown; window?: unknown }
		const hadCustomEvent = typeof g.CustomEvent === 'function'
		if (!hadCustomEvent) g.CustomEvent = class { type: string; detail: unknown; constructor(type: string, init?: { detail?: unknown }) { this.type = type; this.detail = init?.detail } }
		;(globalThis as unknown as { window?: unknown }).window = { dispatchEvent: (e: { type: string; detail: never }) => (sent.push(e as never), true) }
		try {
			expect(await ok.chat.pinFirstFingerprintOfKnownContact(CONTACT, pinned)).toBe('saved')
			expect(sent).toHaveLength(1)
			expect(sent[0].type).toBe('beamio:first-pin-applied')
			expect(sent[0].detail.address).toBe(CONTACT)
			expect(sent[0].detail.pinned.fingerprint).toBe(FP)
			expect(await bad.chat.pinFirstFingerprintOfKnownContact(CONTACT, pinned)).toBe('not_saved')
			expect(sent).toHaveLength(1)
		} finally {
			delete (globalThis as unknown as { window?: unknown }).window
			if (!hadCustomEvent) delete g.CustomEvent
		}
	})
	it('a known contact without a verified value gets the first pinned value and the save is waited for', async () => {
		const { chat, globals, store } = load(true)
		withRows(globals, [{ address: CONTACT, chatData: { publicArmored: '', routersArmoreds: '' } }])
		expect(await chat.pinFirstFingerprintOfKnownContact(CONTACT, pinned)).toBe('saved')
		expect(store).toHaveBeenCalledTimes(1)
		expect(rowsOf(globals)[0].chatData?.verifiedFingerprint).toBe(`openpgp:${FP}`)
	})
	it('a contact with no stored row is never given one (a payment to a stranger creates no chat)', async () => {
		const { chat, globals, store } = load(true)
		withRows(globals, [{ address: OTHER, chatData: {} }])
		expect(await chat.pinFirstFingerprintOfKnownContact(CONTACT, pinned)).toBe('no_row')
		expect(store).not.toHaveBeenCalled()
		expect(rowsOf(globals)).toHaveLength(1)
	})
	it('a row that already holds a verified value is left alone', async () => {
		const { chat, globals, store } = load(true)
		withRows(globals, [{ address: CONTACT, chatData: { verifiedFingerprint: `openpgp:${'e'.repeat(40)}` } }])
		expect(await chat.pinFirstFingerprintOfKnownContact(CONTACT, pinned)).toBe('already_verified')
		expect(store).not.toHaveBeenCalled()
		expect(rowsOf(globals)[0].chatData?.verifiedFingerprint).toBe(`openpgp:${'e'.repeat(40)}`)
	})
	it('a save that fails is reported as not_saved (and logged), never thrown', async () => {
		const { chat, globals } = load(false)
		withRows(globals, [{ address: CONTACT, chatData: {} }])
		expect(await chat.pinFirstFingerprintOfKnownContact(CONTACT, pinned)).toBe('not_saved')
	})
	it('no stored profile at all is no_row', async () => {
		const { chat, globals } = load(true)
		globals.setCoNET_Data(null as never)
		expect(await chat.pinFirstFingerprintOfKnownContact(CONTACT, pinned)).toBe('no_row')
	})
})
