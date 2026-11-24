/**
 * Source guards (SYNTHETIC): no command goes to the native SDK with a negative or missing reqId (it answers bad_request with reqId null at its
 * entry); a trust write with no stored row creates the row and reports the real save result; a shell that announced a generation takes the
 * inboundGeneration field; no draft marker in the English copy.
 */
import fs from 'fs'
import path from 'path'

const SRC = path.join(__dirname, '..')
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8')
const walk = (d: string, out: string[] = []): string[] => {
	for (const e of fs.readdirSync(d, { withFileTypes: true })) {
		const f = path.join(d, e.name)
		if (e.isDirectory()) walk(f, out)
		else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\./.test(e.name)) out.push(f)
	}
	return out
}
const transport = read('services/nativeConetChatTransport.ts')

describe('reqId of the commands to the native SDK', () => {
	it('no source file sends a negative reqId', () => {
		const hits = walk(SRC).filter((f) => /reqId:\s*-\s*\d/.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(SRC, f))
		expect(hits).toEqual([])
	})
	it('the transport posts a bare command only through request() or postNoReply(), both of which set a valid reqId', () => {
		const lines = transport.split('\n').filter((l) => l.includes('this.postCommand('))
		for (const l of lines) {
			const ok = /postCommand\(body\)/.test(l) || /postCommand\(\{ \.\.\.cmd, reqId \}\)/.test(l) || /reqId, nodes: this\.nodes/.test(l)
			expect(ok).toBe(true)
		}
		for (const t of ['ackInbound', 'setRoutes', 'setNodes', 'pause', 'resume']) expect(transport).toContain(`this.postNoReply({ type: '${t}'`)
	})
	it('provisionIdentity is a request whose answer is read', () => {
		expect(transport).toMatch(/this\.request<unknown>\(\{ type: 'provisionIdentity', payload: provisionPayload \}, 30_000\)/)
	})
})

describe('the inboundGeneration field (the field is sent only when the hello declares it)', () => {
	it('is sent only when the hello declares inbound.generation.v1; the QA lines show declared, has and value', () => {
		expect(transport).toContain('return declared')
		expect(transport).not.toContain('declared || announced')
		expect(transport).toContain("qaLine('[send]', `gen has=")
	})
})

describe('deferAck is written only when the hello declares it', () => {
	it('init has no unconditional deferAck', () => {
		expect(transport).toContain("...(this.helloOffered.includes('inbound.deferAck') ? { deferAck: true } : {})")
		expect(transport).not.toMatch(/^\t\t\tdeferAck: true,/m)
	})
})

describe('a trust write with no stored row (Verified did nothing)', () => {
	const chat = read('pages/chat/chat.tsx')
	const fn = chat.slice(chat.indexOf('function applyPeerRoute('), chat.indexOf('/** the send to the chat\'s recipient.'))
	it('creates the row in the own first profile and waits for the save', () => {
		expect(fn).toContain('rows = [...curRows, created]')
		expect(fn).toContain('persisted = storeSystemDataAndWait()')
		expect(fn).toContain('nextProfiles[0] = { ...cur, chats: rows }')
	})
	it('never reports saved when there is no stored profile', () => {
		expect(fn).toContain('persisted = Promise.resolve(false)')
	})
	it('a failed save shows the verify-again error', () => {
		expect(fn).toContain('The verified key could not be saved on this device. Verify again.')
	})
})

describe('persistInitRecord drops the peer armor and keeps the stored rows (shell), and keeps the stored rows (browser)', () => {
	const beamio = read('services/beamio.ts')
	const shell = beamio.slice(beamio.indexOf('export const persistInitRecord = async'), beamio.indexOf('/** The native copy of a shell save'))
	it('the armor strip and the chats floor come before the shell write check', () => {
		const strip = shell.indexOf('withoutPeerArmorForShell(')
		const floor = shell.indexOf('keepStoredChats(')
		const check = shell.indexOf('buildShellRecordWriteCommand(')
		expect(strip).toBeGreaterThan(0)
		expect(floor).toBeGreaterThan(0)
		expect(check).toBeGreaterThan(Math.max(strip, floor))
	})
	it('the browser writer keeps the stored rows as well', () => {
		const browser = beamio.slice(beamio.indexOf('const persistInitRecordBrowser'), beamio.indexOf('const walletStores = ('))
		expect(browser).toContain('keepStoredChats(temp, storedPlain, floorOptionsFor(temp))')
	})
	it('the failure line names chats_floor', () => {
		expect(beamio).toContain("reason=${ex instanceof Error && ex.message === CHATS_FLOOR_REFUSED ? 'chats_floor' : 'write_failed'}")
	})
})

describe('shell: the gate reads the page copy, the read feed-back keeps memory rows, no local library is not an error', () => {
	const beamio = read('services/beamio.ts')
	const bridge = read('services/chatWorkerBridge.ts')
	it('readStoredProfilesForVerify reads the page IndexedDB copy in a shell (the native record takes no chat rows)', () => {
		const fn = beamio.slice(beamio.indexOf('export const readStoredProfilesForVerify'), beamio.indexOf('/** The stored record as plain data'))
		expect(fn).toContain('if (isShellContext())')
		expect(fn.indexOf('readPageIdbInit()')).toBeGreaterThan(fn.indexOf('if (isShellContext())'))
		expect(fn.indexOf('readPageIdbInit()')).toBeLessThan(fn.indexOf('readPlainForVerify(walletStores())'))
	})
	it('the start-up read feed-back keeps the memory rows in a shell', () => {
		expect(beamio).toContain('setCoNET_Data(keepMemoryChats(data as unknown as encrypt_keys_object, CoNET_Data, floorOptionsFor(data)))')
	})
	it('the chats floor takes the page copy only (not the native record) and comes after both overwrite-guard branches', () => {
		const shell = beamio.slice(beamio.indexOf('export const persistInitRecord = async'), beamio.indexOf('/** The native copy of a shell save'))
		expect(shell).toContain("keepStoredChats(withoutPeerArmorForShell(merged), pageState.status === 'valid' ? pageState.data : null, floorOptionsFor(merged))")
		expect(shell).not.toMatch(/keepStoredChats\([^)]*nativeExisting/)
		expect(shell.indexOf('const merged = await assertPageRecordNotOverwritten')).toBeLessThan(shell.indexOf('keepStoredChats('))
		expect(shell).toContain('peer_armor_dropped rows=')
		expect(shell).toContain("qaRecordCounts('saved', written)")
	})
	it('a native client without a local library answers not_ready, never read_error (no history notice)', () => {
		const fn = bridge.slice(bridge.indexOf('export const readLocalChatHistory'), bridge.indexOf('export const loadOlderLocalChatPage'))
		expect(fn).toContain('if (activeClientIsNative && !NATIVE_CLIENT_HAS_LOCAL_LIBRARY)')
		expect(fn.indexOf('NATIVE_CLIENT_HAS_LOCAL_LIBRARY')).toBeLessThan(fn.indexOf('h.openConversation(convKey, viewport)'))
		expect(read('services/historyCapability.ts')).toContain('NATIVE_CLIENT_HAS_LOCAL_LIBRARY = false')
	})
})

describe('English copy', () => {
	it('has no draft marker', () => {
		const en = fs.readFileSync(path.join(SRC, 'locale/en.json'), 'utf8')
		expect(en).not.toMatch(/draft|pending owner confirmation/i)
		expect(en).toContain('"chat_history_unavailable": "Chat history is not readable yet. Retrying."')
	})
})
