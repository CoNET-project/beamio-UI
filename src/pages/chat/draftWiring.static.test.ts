// chat.tsx wiring of the draft and the send path, and the storageData rule (an immediate write with nothing to write to throws).
import fs from 'fs'
import path from 'path'

const chat = fs.readFileSync(path.join(__dirname, 'chat.tsx'), 'utf8')
const storageDataSrc = (() => {
	const i = chat.indexOf('const storageData = async (immediate = false)')
	return chat.slice(i, chat.indexOf('storageDataRef.current = storageData', i))
})()
const sendSrc = (() => {
	const i = chat.indexOf('await acceptOutgoingText({')
	return chat.slice(i - 400, i + 4000)
})()

describe('storageData (immediate mode)', () => {
	it('throws when there is no account (no CoNET_Data or no profiles) instead of returning quietly', () => {
		expect(storageDataSrc).toMatch(/if \(!temp \|\| ps\.length === 0\) \{\s*if \(immediate\) throw new Error\('storage_no_account'\)\s*return\s*\}/)
	})
	it('throws when the contact address is empty instead of returning quietly', () => {
		expect(storageDataSrc).toMatch(/if \(!addr\) \{\s*if \(immediate\) throw new Error\('storage_no_contact'\)\s*return\s*\}/)
	})
	it('the deferred mode (no caller treats it as a commit) still returns quietly', () => {
		expect(storageDataSrc).toMatch(/return\n\t\t\}/)
	})
	it('the commit failure still throws (durableCommitError)', () => {
		expect(storageDataSrc).toMatch(/const failure = durableCommitError\(await commitForChat\(\)\)\s*if \(failure\) throw failure/)
	})
})

describe('send() with the queue', () => {
	it('the input is cleared by the accept step after the queue item landed, not at the top of send(); without a queue nothing is accepted', () => {
		expect(sendSrc).toMatch(/const begun = await acceptOutgoingText\(\{\s*autosaver: draftAutosaverRef\.current,\s*queueReady: !!sendQueue,\s*currentText: t,\s*clearInput: \(\) => \{/)
		expect(sendSrc).toContain('const rest = inputAfterAccept(inputRef.current?.value ?? t, t)')
		expect(sendSrc).toMatch(/if \(!begun\.ok\) return\s*const sendId: string = begun\.sendId/)
		const sendFn = chat.slice(chat.indexOf('acceptOutgoingText({') - 1500, chat.indexOf('acceptOutgoingText({'))
		expect(sendFn).not.toMatch(/\n\t\tclearChatInput\(\)\n/)
	})
	it('the sendId is the one made at draft creation (no crypto.randomUUID after beginSend)', () => {
		const after = chat.slice(chat.indexOf('const sendId: string = begun.sendId'), chat.indexOf('const sendId: string = begun.sendId') + 3000)
		expect(after).not.toMatch(/crypto\.randomUUID\(\)/)
	})
	it('the first attempt runs as the item\'s inline attempt in the queue; a retry tap runs the same attempt through the same claim', () => {
		expect(chat).toMatch(/if \(sendQueue\) await sendQueue\.run\(sendId, firstAttempt, \{ inline: true \}\)/)
		expect(chat).toMatch(/return tapFailedBubble\(\{\s*sendId: m\.sendId,\s*attempt: retryAttemptFor\(m\),\s*queue: sendQueueRef\.current,/) // the claim: failedRetry.ts tapFailedBubble
	})
	it('the draft autosaver hands the click to the queue as an inline item', () => {
		expect(chat).toMatch(/enqueue: \(rec\) => queue\.enqueue\(queueItemFromDraft\(rec, peer, Date\.now\(\)\), \{ inline: true \}\)/)
	})
	it('the queue is released only through the attempt results and settle(): the deliver path settles with the same result', () => {
		expect(chat).toMatch(/if \(sid\) void sendQueueRef\.current\?\.settle\(sid, result\)/)
		expect(chat).toMatch(/const heldPersisted = await persistOutgoing\(\)\.then\(\(\) => true, \(\) => false\)/)
	})
	it('no path of the page drops a queue item: a failed bubble is never removed by a tap', () => {
		expect(chat).not.toMatch(/\.drop\(m\.sendId\)/)
	})
})

describe('the draft and queue lifecycle in chat.tsx', () => {
	it('the codec is AES-GCM under keccak256(private key) in the browser and base64 JSON otherwise, and the shell one is never called encryption', () => {
		const codecSrc = fs.readFileSync(path.join(__dirname, '../../services/sendQueueCodec.ts'), 'utf8')
		expect(codecSrc).toMatch(/codec = aesGcmCodec\(ethers\.getBytes\(ethers\.keccak256\(ethers\.toUtf8Bytes\(privateKeyArmor\)\)\)\)/)
		expect(codecSrc).toMatch(/let codec = base64JsonCodec\(\)/)
		expect(codecSrc).toMatch(/base64 JSON, which is NOT encryption/)
		const storesSrc = fs.readFileSync(path.join(__dirname, '../../services/chatDocStores.ts'), 'utf8')
		expect(storesSrc).toMatch(/const codec = queueCodecFor\(input\.privateKey\)/)
		expect(chat).toMatch(/createChatDocStores\(\{ eoa, privateKey, nativeShell: isShellContext\(\), doc: chatDraftDocAdapter \}\)/)
		expect(chat).toMatch(/base64 JSON, NOT encryption/)
		expect(chat).not.toMatch(/encrypted storage/i)
	})
	it('the draft and the queue are small documents of their own in the account database (chatDraftDocAdapter), not the init record', () => {
		const storesSrc = fs.readFileSync(path.join(__dirname, '../../services/chatDocStores.ts'), 'utf8')
		expect(storesSrc).toMatch(/draftStore: createDraftStore\(\{ eoa: input\.eoa, doc: input\.doc, codec \}\)/)
		expect(storesSrc).toMatch(/queueStore: createQueueStore\(\{ eoa: input\.eoa, doc: input\.doc, codec \}\)/)
		expect(chat).toMatch(/doc: chatDraftDocAdapter \}\)/)
		expect(chat).toMatch(/const store = stores\.draftStore/)
		expect(chat).toMatch(/const \{ tags, queueStore, receiptStore, deliveredStore \} = stores/)
		expect(chat).toMatch(/store: queueStore,/)
		const beamio = fs.readFileSync(path.join(__dirname, '../../services/beamio.ts'), 'utf8')
		expect(beamio).toMatch(/export const chatDraftDocAdapter/)
		expect(beamio).toMatch(/consultPageWriteGate\('closed_at_draft'\)/)
		expect(beamio).toMatch(/list: \(prefix: string\): Promise<string\[\]> => listDocIds\(prefix\)/)
		// the adapter removes the four classes of chat documents (chatAuxDocs.ts: draft, queue, receipt, delivered) and refuses every other id
		expect(beamio).toMatch(/if \(!isChatAuxDocId\(docId\)\) throw new Error\('not_a_chat_aux_doc'\)/)
		expect(beamio).not.toMatch(/chat-\(draft\|queue\)-v1/)
	})
	it('typing, blur, hidden and pagehide feed the autosaver; IME composition is not saved half way', () => {
		expect(chat).toMatch(/if \(imeComposingRef\.current\) return\s*draftAutosaverRef\.current\?\.onInput\(inputRef\.current\?\.value \?\? text\)/)
		expect(chat).toMatch(/onBlur=\{\(\) => \{ void draftAutosaverRef\.current\?\.flushNow\(\) \}\}/)
		expect(chat).toMatch(/document\.addEventListener\('visibilitychange', onVisibility\)/)
		expect(chat).toMatch(/window\.addEventListener\('pagehide', flush\)/)
	})
	it('the restore on mount loads the queue, puts back the input draft (never sent by itself), adds the queued messages that are not listed, drops a same-message draft and kicks the resume', () => {
		expect(chat).toMatch(/const items: QueueItem\[\] = await readConversationQueue\(queue, queueStore, setQueueProblem, \(\) => !cancelled\)/)
		expect(chat).toMatch(/await restoreOnMount\(\{ store, peer, queueItems: items, stored: messagesRef\.current \|\| \[\] \}\)/)
		expect(chat).toMatch(/messagesForUnlisted\(items, messagesRef\.current \|\| \[\]\)/)
		expect(chat).toMatch(/restored\.dropDraftSendId/)
		expect(chat).toMatch(/queue\.kick\('load'\)/)
	})
	it('the automatic resume triggers: load, online, the page visible again (and the queue\'s own retry timer); each runs through the claim and the write lock', () => {
		expect(chat).toMatch(/const onOnline = \(\) => \{ nodeWaiterRef\.current\?\.nudge\(\); queue\.kick\('online'\) \}/)
		expect(chat).toMatch(/if \(document\.visibilityState === 'visible'\) \{ nodeWaiterRef\.current\?\.nudge\(\); queue\.kick\('visible'\) \}/)
		expect(chat).toMatch(/window\.addEventListener\('online', onOnline\)/)
		expect(chat).toMatch(/claim: webLocksClaim\(eoa\)/)
		expect(chat).toMatch(/onHold: \(h\) => setQueueHold\(depthKey, h\)/)
	})
	it('the resume never sends a message that is held for the user or waiting for the entry nodes', () => {
		expect(chat).toMatch(/resumeClassOf\(m, \{ waitingForNodes: !!nodeWaiterRef\.current\?\.has\(m\.id as string\) \}\)/)
		expect(chat).toMatch(/if \(resumeClass === 'trust_hold' \|\| resumeClass === 'live_node_wait'\) return resumeResultOf\(resumeClass\)/)
	})
	it('an item awaiting confirmation is shown as such in the bubble', () => {
		expect(chat).toMatch(/awaitingSendIds\.has\(m\.sendId\) \? tu\('chat\.status\.awaiting_ack'\)/)
	})
	it('no localStorage / sessionStorage is used for the draft or the queue', () => {
		const i = chat.indexOf('the draft and the send queue of this conversation')
		const block = chat.slice(i, i + 9000).replace(/\/\/.*$/gm, '')
		expect(block).not.toMatch(/localStorage|sessionStorage/)
	})
})

describe('route_unconfirmed is retried, trust holds wait for the user, the status never goes back (chat.tsx wiring)', () => {
	it('a failed delivery maps through mapDeliverFailure (route_unconfirmed is a retryable failure; only fingerprint_changed / first_fetch_pending are held)', () => {
		expect(chat).toMatch(/return mapDeliverFailure\(failCode\)/)
		expect(chat).not.toMatch(/return held \? \{ kind: 'held' \} : \{ kind: 'failed' \}/)
	})
	it('the automatic resume skips only trust holds; route_unconfirmed goes through retryAttemptFor, which reads the route again (sendWithFreshRoute) every time', () => {
		expect(chat).toMatch(/resumeClassOf\(m, \{ waitingForNodes/)
		expect(chat).not.toMatch(/isHeldRouteCode\(m\.sendError\) \|\| m\.status === 'route_unconfirmed'/)
		// the attempt is the retry button's attempt: deliverText -> sendChatToRecipient -> sendWithFreshRoute (no viaCachedRoute, no pinned key)
		const i = chat.indexOf('async function sendChatToRecipient(')
		const body = chat.slice(i, i + 2600)
		expect(body).toMatch(/: await sendWithFreshRoute\(await trustGateCopy\(current\), text, privateKey/)
		const d = chat.slice(chat.indexOf('async function deliverTextInner('), chat.indexOf('async function deliverTextInner(') + 1800)
		expect(d).toMatch(/ok = await sendChatToRecipient\(wire, \{ armor: armorCtx, onReceipt: \(r\) => \{ receipt = r \} \}\)/)
	})
	it('the 30 s / 2 min / 10 min ladder yields to the queue for a queued message (one claimed retry path, no second unclaimed one), and a held record is cleared once the message went out', () => {
		expect(chat).toMatch(/if \(queuedSendId && sendQueueRef\.current\?\.has\(queuedSendId\)\) return/)
		expect(chat).toMatch(/if \(h\?\.timer !== undefined\) window\.clearTimeout\(h\.timer\); heldSendsRef\.current\.delete\(tempId\)/)
	})
	it('the status after the POST answer never goes back from delivered, and what releases the item is the proof, not that status', () => {
		expect(chat).toMatch(/status: statusAfterPostAnswered\(m\.status\)/)
		expect(chat).toMatch(/const decision = await releaseDecisionOf\(\{ sendId: proofSid, peer: String\(chatData\.address \|\| ''\), receipt, evidence: receiptStoreRef\.current \}\)/)
	})
})

describe('the delivery receipt reaches the queue as an event', () => {
	const app = fs.readFileSync(path.join(__dirname, '../../App.tsx'), 'utf8')
	it('App.tsx emits the receipt before it merges it into the stored copy', () => {
		expect(app).toMatch(/emitDeliveryReceipt\(deliveryReceipt\.sendId, signAddr\)/)
		expect(app).toMatch(/import \{ emitDeliveryReceipt \} from '@\/services\/deliveryReceiptBus'/)
	})
	it('the conversation marks the message delivered, writes it, and only then settles the item; the open queue listens, and a receipt from while it was closed is applied at load and at resume', () => {
		expect(chat).toMatch(/const persisted = await senderCopyPersisted\(sendId, await persistOutgoing\(\)\.then\(\(\) => true, \(\) => false\)\)\s*await queue\.settle\(sendId, \{ kind: 'sent', persisted \}\)[\s\S]{0,420}?recordReceiptOutcome\(sendId, peer, persisted \? 'applied' : 'applied_not_durable'\)\s*return persisted/)
		expect(chat).toMatch(/const offReceipt = onDeliveryReceipt\(\(sendId, from\) => \{ if \(from === peer\) void applyDeliveryReceipt\(sendId\); else recordReceiptOutcome\(sendId, from, 'other_peer'\) \}\)/)
		expect(chat).toMatch(/hasDeliveryReceipt\(it\.sendId, peer\) \|\| \(await receiptStore\.has\(peer, it\.sendId\)\.catch\(\(\) => false\)\)\) await applyDeliveryReceipt\(it\.sendId\)/)
		expect(chat).toMatch(/const entry = resumeEntryOf\(\{ evidenceInMemory, evidenceOnDisk, chatReady: !!chatActionsRef\.current, messageInList: !!m \}\)\s*if \(entry === 'apply_evidence'\) return \{ kind: 'sent', persisted: await applyDeliveryReceiptRef\.current\(item\.sendId\) \}/)
	})
})

describe('no writer puts its snapshot over the record (read-modify-write wiring)', () => {
	const app = fs.readFileSync(path.join(__dirname, '../../App.tsx'), 'utf8')
	const beamio = fs.readFileSync(path.join(__dirname, '../../services/beamio.ts'), 'utf8')
	it('the inbound batch merges its changes into the CURRENT record (CoNET_Data), applies its receipts there, marks only the sender\'s chat, and no longer does setProfiles([...profiles]) from its snapshot', () => {
		expect(app).toMatch(/mergeBatchIntoCurrent\(\{ currentChats: /)
		expect(app).toMatch(/const pickedNow = pickCurrentProfiles\(CoNET_Data, profiles\)\s*const sameAccountNow = pickedNow\.isCurrent/)
		expect(app).toMatch(/batchDelivered\.push\(\{ sendId: deliveryReceipt\.sendId, from: signAddr, line: raw \}\)/)
		expect(app).toMatch(/markDeliveredFrom\(chats as unknown as Record<string, unknown>\[\], deliveryReceipt\.sendId, signAddr\)/)
		const body = app.slice(app.indexOf('const addNewMessage = async ('), app.indexOf('// ① 先统计'))
		expect(body).not.toMatch(/setProfiles\(\[\.\.\.profiles\]\)/)
		expect(app).not.toMatch(/markMessageDeliveredBySendId\(chats, deliveryReceipt\.sendId\)/)
	})
	it('the conversation reads the record AGAIN after its awaits and merges its row into the current row (messages kept, higher status kept)', () => {
		expect(chat).toMatch(/const livePs = pickCurrentProfiles\(CoNET_Data, ps\)\.profiles/)
		expect(chat).toMatch(/mergeOwnRowIntoCurrent\(c, persistableChat as unknown as Record<string, unknown>\)/)
		const i = chat.indexOf('const persistableMessages = await Promise.all')
		expect(chat.indexOf('const livePs = ')).toBeGreaterThan(i) // after the await, not before it
	})
	it('the browser write refuses a record it cannot read (nothing written, the memory copy stays), and only a record that is absent is written without the floor', () => {
		expect(beamio).toMatch(/const plan = planBrowserWrite\(await readPlainForFloor\(walletStores\(\)\)\)\s*if \(plan\.action === 'refuse'\) throw new Error\(plan\.code\)/)
		expect(beamio).not.toMatch(/readPlainForVerify\(walletStores\(\)\)\.catch\(\(\) => null\)/)
	})
})

describe('write amplification', () => {
	it('a sent / delivered state this page has written is not written again by a re-POST (the account record is not rewritten on every back-off tick)', () => {
		expect(chat).toMatch(/const alreadyWritten = !!sidForWrite && sentStateWrittenRef\.current\.has\(sidForWrite\) && !statusChangedByAnswer/)
		expect(chat).toMatch(/const persisted = alreadyWritten \? true : await persistOutgoingAfterSend\(\)/)
	})
})

describe('tombstones (rows removed by an earlier release stay removed)', () => {
	it('the row the conversation persists carries the tombstones it was loaded with', () => {
		expect(chat).toMatch(/removedSendIds: tombstonesOf\(\{ removedSendIds: \[\.\.\.\(chatData\.removedSendIds \?\? \[\]\), \.\.\.removedSendIdsRef\.current\] \}\)/)
		expect(chat).toMatch(/const removedSendIdsRef = useRef<Set<string>>\(new Set\(chatData\.removedSendIds \?\? \[\]\)\)/)
	})
})

describe('every write site reads the CURRENT record through pickCurrentProfiles (a site that falls back to its snapshot is caught here)', () => {
	const app = fs.readFileSync(path.join(__dirname, '../../App.tsx'), 'utf8')
	it('chat.tsx storageData: the early read and the read after the awaits, and the row is written from the live chats', () => {
		const body = chat.slice(chat.indexOf('const storageData = async (immediate = false)'), chat.indexOf('storageDataRef.current = storageData'))
		expect(body).toMatch(/const ps = pickCurrentProfiles\(temp, snapshotPs\)\.profiles/)
		expect(body).toMatch(/const livePs = pickCurrentProfiles\(CoNET_Data, ps\)\.profiles\s*const liveP0: profile = livePs\[0\] \?\? p0\s*const liveChats: chatData\[\] = Array\.isArray\(liveP0\?\.chats\) \? liveP0\.chats : chats/)
		expect(body).toMatch(/liveChats\.map\(\(c, i\) => i === liveIdx \?/)
		expect(body).toMatch(/const nextProfile = \{ \.\.\.liveP0, chats: persistableChats \}\s*const nextProfiles = livePs\.slice\(\)/)
		expect(body.indexOf('const livePs')).toBeGreaterThan(body.indexOf('await Promise.all'))
	})
	it('App.tsx addNewMessage: the commit merges into pickCurrentProfiles(CoNET_Data, profiles), not into the batch snapshot', () => {
		const body = app.slice(app.indexOf('const addNewMessage = async ('), app.indexOf('// ① 先统计'))
		expect(body).toMatch(/const currentProfiles: profile\[\] = pickedNow\.profiles\s*const current0 = currentProfiles\[0\] \?\? profile/)
		expect(body).toMatch(/currentChats: \(Array\.isArray\(current0\.chats\) \? current0\.chats : \[\]\)/)
		expect(body).toMatch(/const nextProfiles = currentProfiles\.slice\(\)/)
	})
	it('App.tsx auto reply: the row is merged into the current chats (both the first write and the failure write)', () => {
		expect(app).toMatch(/const pickedForReply = pickCurrentProfiles\(CoNET_Data, profiles\)\s*const baseChats = Array\.isArray\(pickedForReply\.profiles\[0\]\?\.chats\) \? pickedForReply\.profiles\[0\]\.chats : profile\.chats/)
		expect(app).toMatch(/const latest = \[\.\.\.\(\(CoNET_Data\?\.profiles\?\.\[0\]\?\.chats as chatData\[\] \| undefined\) \?\? profile\.chats \?\? \[\]\)\]/)
	})
})

describe('whole-replacement writers of the account record are a closed list (a new one fails here and must be reviewed)', () => {
	// Writers that replace `.chats` / `.profiles` of the record from a local copy. Every one of them is either a merge into the current record (mergeBatchIntoCurrent / mergeOwnRowIntoCurrent), or one of the
	// reviewed residuals (history restore, ChatList patches, aaAccount, voice profiles: functional updates or direct reads of the current rows; the persisted floor merges messages and never lowers a status).
	// To add a writer: read the current record (pickCurrentProfiles), merge only your change, then update this list WITH the reason.
	const ALLOWED: Record<string, number> = {
		'App.tsx': 12, // the batch commit (merged), history restore, nickname fill, voice profiles, auto reply (merged), init
		'pages/chat/chat.tsx': 7, // storageData (merged), the conversation's own copies of its row
		'pages/chat/components/ChatList.tsx': 3, // reviewed residual: patches that read the current rows
		'providers/DaemonProvider.tsx': 1, // reviewed residual: aaAccount
		'services/chat.ts': 5, // chat start: chatManager on the profile
		'services/beamio.ts': 2,
		'services/chatLocalMigration.ts': 2, // the migration's strip and the cleanup of confirmed bodies (recordBodyCleanup.ts: original kept, read-back, rollback)
		'utils/ensureConetAa.ts': 1,
		'utils/sendMerchantGiftRedeemChat.ts': 1,
		'pages/Pay/PaymentLink/index.tsx': 2,
		'pages/Pay/send/index.tsx': 2,
		'pages/Vouchers/TopUpAccount.tsx': 2,
	}
	const walk = (dir: string, out: string[] = []): string[] => {
		for (const f of fs.readdirSync(dir)) {
			const p = path.join(dir, f)
			if (fs.statSync(p).isDirectory()) { if (f !== 'node_modules') walk(p, out) } else if (/\.(ts|tsx)$/.test(f) && !/\.test\.|\.d\.ts$/.test(f)) out.push(p)
		}
		return out
	}
	const srcRoot = path.join(__dirname, '../..')
	const code = (file: string) => fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
	const PATTERN = /(?:\.chats|\.profiles|profiles\[0\]\.chats)\s*=(?!=)\s*(?!>)/g
	it('the set of files that assign .chats / .profiles, and how many assignments each has, is exactly the reviewed list', () => {
		const found: Record<string, number> = {}
		for (const f of walk(srcRoot)) {
			const n = (code(f).match(PATTERN) ?? []).length
			if (n) found[path.relative(srcRoot, f)] = n
		}
		expect(found).toEqual(ALLOWED)
	})
})

describe('chatDraftDocAdapter (beamio.ts)', () => {
	const beamio = fs.readFileSync(path.join(__dirname, '../../services/beamio.ts'), 'utf8')
	const i = beamio.indexOf('export const chatDraftDocAdapter')
	const block = beamio.slice(i, i + 700)
	it('a write goes through the durable helper and a closed page write gate is an error, never a quiet return', () => {
		expect(block).toMatch(/put: async \(docId: string, text: string\): Promise<void> => \{\s*if \(!consultPageWriteGate\('closed_at_draft'\)\) throw new Error\('persist_gate_closed'\)\s*await putDocDurable\(docId, text\)/)
	})
	it('reads and removes use the plain document helpers', () => {
		expect(block).toMatch(/read: \(docId: string\): Promise<string \| null> => readDocTitle\(docId\)/)
		expect(block).toMatch(/remove: \(docId: string\): Promise<void> => removeChatAuxDoc\(docId\)/)
	})
})

describe('library mode: the queue lets an item go only after the sender copy is durable where the next load reads it (senderCopy.ts)', () => {
	it('the confirmed path of the send awaits senderCopyPersisted, the awaiting path starts it in the background', () => {
		expect(chat).toMatch(/if \(sidForWrite && \(await libraryHoldsNow\(\)\)\) \{\s*if \(decision === 'confirmed'\) return \{ kind: 'sent', persisted: await senderCopyPersisted\(sidForWrite, persisted\) \}\s*void senderCopyPersisted\(sidForWrite, persisted\)\s*return \{ kind: 'awaiting', persisted \}/)
	})
	it('resume (delivered message), persistConfirmed and the receipt handler all release through senderCopyPersisted, never through the bare record write', () => {
		expect(chat).not.toMatch(/if \(m\.status === 'delivered'\) return \{ kind: 'sent'/) // the row status is no evidence: only the receipt releases (receiptRelease.test.ts)
		expect(chat).toMatch(/return senderCopyPersisted\(item\.sendId, await persistOutgoing\(\)\.then\(\(\) => true, \(\) => false\)\)/)
		expect(chat).toMatch(/const persisted = await senderCopyPersisted\(sendId, await persistOutgoing\(\)\.then\(\(\) => true, \(\) => false\)\)\s*await queue\.settle\(sendId, \{ kind: 'sent', persisted \}\)/)
	})
	it('senderCopyPersisted decides through senderCopyDurable with the live library state', () => {
		expect(chat).toMatch(/senderCopyDurable\(\{ recordPersisted, libraryHolds: await libraryHoldsNow\(\), alreadyAcked: libraryAckedRef\.current\.has\(sendId\), ackLibrary: \(\) => ackSenderCopyToLibrary\(sendId\) \}\)/)
		expect(chat).toMatch(/const holds = libraryHoldsForClient\(\{ mode: libraryPersistModeFor\(eoa\), capable: capableNow, nativeShell: isShellContext\(\) \}\)/)
		expect(chat).toMatch(/const libState = await readLibraryStateBounded\(localChatMigrationState\)/)
	})
	it('the library ACK is only recorded when the append really ended', () => {
		expect(chat).toMatch(/const ok = await mirrorChatMessageToHistoryAck\([^\n]*\)\s*if \(ok\) libraryAckedRef\.current\.add\(sendId\)/)
	})
})

describe('the held-retry settle and the resume class go through the pure mapping', () => {
	it('retryHeldSend settles the queue item with mapDeliverFailure (route_unconfirmed is retryable); isHeldRouteCode no longer decides the queue result', () => {
		// the held retry never lets the item go on `ok` alone (an empty 200 is not proof): a failure maps through mapDeliverFailure, a bound receipt (and the copy) releases, everything else stays awaiting
		expect(chat).toMatch(/void heldSettleOf\(\{ ok, code, receipt: heldReceipt, persisted: heldPersisted, ackCopy: \(p\) => senderCopyPersisted\(heldSendId, p\) \}\)\.then\(\(result\) => sendQueueRef\.current\?\.settle\(heldSendId, result\)\)/)
		expect(chat).not.toMatch(/ok \? \{ kind: 'sent', persisted: heldPersisted \}/)
		// and it reuses the stored armor and reads the receipt like every other send of this sendId
		expect(chat).toMatch(/sendChatToRecipient\(held\.text, \{ viaCachedRoute: effective === 'cached', pinned, armor: heldArmor, onReceipt: \(r\) => \{ heldReceipt = r \} \}\)/)
		expect(chat).not.toMatch(/\? \{ kind: 'held' \} : \{ kind: 'failed' \}\)/)
	})
	it('resume decides through resumeClassOf with the page\'s own node wait; only trust_hold and live_node_wait hold', () => {
		expect(chat).toMatch(/resumeClassOf\(m, \{ waitingForNodes: !!nodeWaiterRef\.current\?\.has\(m\.id as string\) \}\)/)
		expect(chat).toMatch(/if \(resumeClass === 'trust_hold' \|\| resumeClass === 'live_node_wait'\) return resumeResultOf\(resumeClass\)/)
	})
	it('the end of the node wait settles the item as failed (retried with back-off), the nodes arriving deliver through deliverText', () => {
		expect(chat).toMatch(/if \(sid\) void sendQueueRef\.current\?\.settle\(sid, \{ kind: 'failed' \}\) \} \/\/ the wait is over/)
	})
})

describe('a wait for the entry nodes is `waiting` for the queue, not a hold', () => {
	it('both attempts (the first send and the retry) report waiting after starting the wait; no node wait is reported as held', () => {
		expect((chat.match(/result = \{ kind: 'waiting' \}/g) ?? []).length).toBe(2)
		expect(chat).not.toMatch(/waitSendForNodes\([^)]*\)\s*result = \{ kind: 'held' \}/)
	})
})

