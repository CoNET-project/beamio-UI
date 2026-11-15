import { abortAfter, BOOT_REQUEST_TIMEOUT_MS } from '@/utils/bootTimeout'
import {generateKey, readKey, createMessage, enums, encrypt} from 'openpgp'
import {
	ensureNativePushBoundForWallet,
} from '@/utils/cashTreesPushBind'
import { isCashTreesNativeWebView, postNativePgpCiphertext, setNativeVoiceRelayNodes } from '@/utils/cashTreesNativeNfc'
import { CoNET_Data, setCoNET_Data } from "@/utils/globals"
import { cachedWallet } from '@/utils/dialWalletCache'

import {GuardianNodesMainnet, conetDepinProvider, beamioApi} from '@/utils/constants'
import { loadCoNETNodesOutcome } from './coNETNodeRead'
import contracts from '@/utils/contracts'
import {ethers} from 'ethers'
import {toBase64, fromBase64, storeSystemData, storeSystemDataAndWait } from '@/services/beamio'
import { publishNativePwaLog } from '@/utils/cashTreesNativePwaLog'
import { sendChatViaNativeDaemon, getWorkerGossipListenParams, getWorkerGossipRouteArmor, isWorkerGossipActive, isWorkerGossipBusy, isNativeChatListenOwner, pauseNativeChatListen, resumeNativeChatListen, retargetWorkerGossipRoute, startWorkerGossipListen, stopWorkerGossip, takeListenRefusal, takeIdentityClosedRefusal, noteHistoryResumeReason } from '@/services/chatWorkerBridge'
import { isCashTreesAndroidChatModuleRunning } from '@/utils/cashTreesAndroidConetChat'
import { androidChatModulePresent } from '@/utils/androidChatChannel'
import { hasEntryPgpKey, wrapArmorToEntryRoute, wrapArmorToMailboxWork, type AccountSignFn } from '@conet.project/chat-sdk'
import { readNativeIdentityPublic, shellAccountKeyOrEmpty } from './nativeIdentityPublic'
import { initShellIdentityOnly } from './chatWorkerBridge'
import { boundAccountOfActiveClient } from '@/services/chatWorkerBridge'
import { gossipStartDecision, listenParamsFitAccount } from '@/services/historyClientBinding'
import { readRecipientRecord, isRecipientReadError, RecipientReadError, type RecipientLookup } from './recipientRecord'
import { resolveSigningPrivateKeyArmor } from '@/utils/resolveSigningPrivateKeyArmor'
import { readPersistedShellEoa, setShellFirstIdentity, setShellIdentityPending } from './shellIdentitySource'
import { identityClosedSource, importSwitchFailedThisSession, setIdentityClosed } from './shellIdentityClosed'
import { createShellRetryCap, registerShellRetryNow, setShellRetryExhausted, SHELL_CHAT_RETRY_LIMIT } from './shellChatRetryCap'
import { SHELL_G1_INIT_ENABLED, startShellChatFromNativeIdentity, type ShellChatStartDeps } from './shellChatStart'
import { createOwnRegisterBackoff, pickRecordedMailbox, planOwnChatRoute, readOwnChainState, recheckListenRoute, resolveCurrentMailbox, verifyRegistration } from '@/services/chatOwnRoutePlan'
import { blocksNewPgpKey, type OwnPrivateBlob } from '@/services/chatOwnRoutePlan'
import { accountKeyOf, walletCore } from '@/services/walletCore'
import { indexedDbStateStore, readOwnPgpPrivateArmored, type OwnPgpBlobDeps } from '@/services/ownPgpBlob'
import { PGP_BLOB_V2_WRITES_ENABLED } from '@/services/pgpBlob'
import { classifyOwnPgp, getPgpRestoreFailure, getPgpRestoreSnapshot, setPgpRestoreFailure, snapshotOfRead } from '@/services/pgpRestore'
import { evaluateNativePgpRestore, restoreNativePgp } from '@/services/nativePgpRestore'
import { nativeChatRouteRegister } from '@/services/nativeChatRouteRegister'
import { submitBrowserChatRouteRegister, submitNativeChatRouteRegister } from '@/services/chatRouteRegister'
import { ensureShellChatState, isShellContext, shellChatBlockedNow } from '@/services/shellChatCapability'
import { setShellChatUiState } from '@/services/shellChatUiState'
import { setShellPgpTemporary, setShellPgpTemporaryStopped, nextPgpTemporaryDelay } from '@/services/shellPgpTemporary'
import { accountAddressOf } from '@/services/shellProfile'
import { accountEoaFor } from '@/services/gossipAckSign'
import { nativeMailboxProbeSign, type MailboxProbeCommand } from '@/services/nativeMailboxProbe'
import { probeHasSigner, signMailboxProbe } from '@/services/mailboxProbeSigning'
import { signAccountMessageFor } from '@/services/nativeSigning'

function chatBootLog(message: string, level: 'info' | 'warn' | 'error' = 'info'): void {
	publishNativePwaLog(level, `[Chat] ${message}`)
}


type GenerateKeyArg = Parameters<typeof generateKey>[0]



const generatePgpKey = async (walletAddr: string, passwd: string ) => {
	// Shell: PGP keys are native (identity.native-keys); the page generates none.
	if (isShellContext()) throw new Error('PGP keys are native in a shell')
	const userIDs = [{ name: walletAddr }] // ✅ 单独声明，mutable

	const option = {
		type: 'ecc',
		passphrase: passwd,
		userIDs,
		curve: 'curve25519',
		format: 'armored'
	} as const

	// ✅ 这里 option.userIDs 仍会变 readonly（因为 as const 会冻结引用类型）
	// 所以需要在调用点转回 generateKey 的参数类型：
	const { privateKey, publicKey } = await generateKey(option as unknown as GenerateKeyArg)
	const publicKeyArmored = publicKey as unknown as string
	
	const keyObj = await readKey ({armoredKey: publicKeyArmored})
	const keyID = keyObj.getKeyIDs()[1].toHex().toUpperCase()
	return { privateKey, publicKey, keyID }
}

/** 从公钥 Armored 获取 KeyID，与整个 CONET 一致的格式 */
export const getPublicKeyArmoredKeyID = async (publicKeyArmored: string): Promise<string> => {
	const keyObj = await readKey({ armoredKey: publicKeyArmored })
	return keyObj.getKeyIDs()[1].toHex().toUpperCase()
}
/**
 * userPgpKeyID (string) : 

userPublicKeyArmored (string) : 

routePgpKeyID (string) : 

routePublicKeyArmored (string) : 

routeOnline (bool) : 
 */
type searchKeyPGP = {
	userPgpKeyID: string
	userPublicKeyArmored: string
	routePgpKeyID: string
	routePublicKeyArmored: string
	routeOnline: boolean
}

export const getRandomNode = (allNodes: nodeInfo[]): nodeInfo|null => {
	if (!allNodes.length) return null
	const random = Math.floor(Math.random() * allNodes.length)
	const node = allNodes[random]
	return node
}

/** 随机抽取 n 个不重复的 node（用于 sendMessage 双节点并行 post） */
export const getRandomNodes = (allNodes: nodeInfo[], n: number): nodeInfo[] => {
	if (!allNodes.length || n <= 0) return []
	const shuffled = [...allNodes].sort(() => Math.random() - 0.5)
	return shuffled.slice(0, Math.min(n, shuffled.length))
}

/** 检查是否为有效的 ethers 私钥（64 位 hex，可选 0x 前缀） */
const isValidEthersPrivateKey = (pk: unknown): pk is string => {
	if (!pk || typeof pk !== 'string') return false
	const s = String(pk).trim().replace(/^0x/i, '')
	return /^[0-9a-fA-F]{64}$/.test(s)
}

/** 按钱包地址从 AddressPGP 获取 PGP（searchKey 接受 address） */
export const getKeysFromCoNETPGPSCByAddress = async (walletAddress: string) => {
	return getKeysFromCoNETPGPSC(walletAddress)
}

/**
 * Public PGP key and mailbox route of any wallet, from AddressPGP `searchKey`.
 *
 * The contract runner is the provider, not a Wallet, so the eth_call carries no
 * `from`. With a Wallet runner ethers fills `from` with our own address, and the
 * RPC operator could link our wallet and IP to the peer we look up.
 * `searchKey(to)` reads only `to`, so the answer is the same.
 */
export const getKeysFromCoNETPGPSC = async (walletAddress: string) => {
	if (!ethers.isAddress(walletAddress)) {
		console.warn('[getKeysFromCoNETPGPSC] not a wallet address, skipping')
		return null
	}
	//"no record"is null; a failed read throws RecipientReadError (network_error). The two are never merged.
	const lookup = await lookupRecipientRecord(walletAddress)
	if (lookup.status === 'no_record') return null
	if (lookup.status === 'network_error') throw new RecipientReadError(lookup.reason)
	// Presence is NOT chain routeOnline (SI abandoned setUserOnlineOnMe).
	// UI online comes from mailbox `wallet_online_query` — see refreshChatMailboxPresence.
	return {
		publicArmored: lookup.publicArmored,
		routersArmoreds: lookup.routersArmoreds,
		online: false,
		routePgpKeyID: lookup.routePgpKeyID ?? "",
		userPgpKeyID: lookup.userPgpKeyID ?? "",
	}
}

/**
 * The recipient's record from AddressPGP, in three exclusive results (-5.1, the global RPC rule):
 * `ok` (a valid, non-empty public key and route), `no_record` (a valid empty answer: the wallet has not registered a PGP key), and
 * `network_error` (a failed call, a timeout, an undecodable answer, or an incomplete registration). `network_error` is never `no_record`.
 */
export type { RecipientLookup }

/** AddressPGP record of a wallet: ok / no_record / network_error, exclusive. The rules are in recipientRecord.ts. */
export const lookupRecipientRecord = async (walletAddress: string): Promise<RecipientLookup> => {
	if (!ethers.isAddress(walletAddress)) return { status: 'network_error', reason: 'invalid_address' }
	const contract = contracts.constPgpManager
	const lookup = await readRecipientRecord(
		() => new ethers.Contract(contract.address, contract.abi, conetDepinProvider).searchKey(walletAddress),
		fromBase64,
	)
	if (lookup.status === 'ok') rememberRecipientRoute(lookup.publicArmored, lookup.routersArmoreds)
	return lookup
}

/**
 * Makes sure walletCore holds this account's key. The key is handed over only here, from the unlocked profile; every
 * later use of the blob goes through walletCore. False when the key is missing or invalid (locked, or secrets stripped).
 */
const ensureWalletCoreUnlocked = (privateKeyArmor: string, eoa: string): boolean => {
	const cur = walletCore.status()
	if (cur.state === 'unlocked' && cur.accountKey === accountKeyOf(eoa)) return true
	return walletCore.unlock(privateKeyArmor, eoa)
}

/** Blob deps for one account: chain read and signed write, and the sealed state store. No key material here. */
const ownBlobDeps = (eoa: string): OwnPgpBlobDeps => {
	const contract = contracts.constPgpManager
	const SC = new ethers.Contract(contract.address, contract.abi, conetDepinProvider)
	return {
		core: walletCore,
		accountKey: accountKeyOf(eoa),
		// getEncryptedPrivateKey() reads msg.sender, so the call carries the account address (no signer needed).
		readChain: async () => String((await SC.getEncryptedPrivateKey({ from: eoa })) ?? ''),
		writeChain: async (sealedBlob: string) => {
			// A shell never writes the blob from the page; the native layer owns the backup. Refused, the state stays pending.
			if (isShellContext()) return false
			const info: searchKeyPGP = await SC.searchKey(eoa)
			const publicArmored = info?.userPublicKeyArmored ? fromBase64(info.userPublicKeyArmored) : ''
			if (!publicArmored) return false
			return submitRegiestChatRoute({
				eoa,
				keyID: String(info.userPgpKeyID || ''),
				publicKeyArmored: toBase64(publicArmored).trim(),
				encrypKeyArmored: sealedBlob,
				routeKeyID: String(info.routePgpKeyID || ''),
			})
		},
		...indexedDbStateStore(accountKeyOf(eoa)),
	}
}

/**
 * Our own AddressPGP record plus our PGP private key. Only for loading our own
 * profile; never call it for a peer.
 *
 * The public part comes from `getKeysFromCoNETPGPSC` (no `from`).
 * `getEncryptedPrivateKey()` reads msg.sender, so that one call carries our own
 * address. The blob is opened inside walletCore (ownPgpBlob.ts); a failure keeps
 * the public part.
 */
export const getOwnKeysFromCoNETPGPSC = async (privateKeyArmor: string) => {
	if (process.env.REACT_APP_SHELL_BUILD === 'true') return null // Boundary: own-PGP reads are not built into a shell; the native SDK reads them.
	if (!isValidEthersPrivateKey(privateKeyArmor)) {
		console.warn('[getOwnKeysFromCoNETPGPSC] invalid privateKeyArmor format, skipping')
		return null
	}
	let Wallet: ethers.Wallet
	try {
		Wallet = new ethers.Wallet(privateKeyArmor)
	} catch (ex: any) {
		console.warn('[getOwnKeysFromCoNETPGPSC] Wallet creation failed:', ex?.message || ex)
		return null
	}
	if (!ensureWalletCoreUnlocked(privateKeyArmor, Wallet.address)) return null
	// Own-chain callers receive null for both no record and a failed read (their decision uses readOwnChainState, which reads
	// again and keeps "error"apart from "none"). The failed read is logged here, never shown as "no record".
	let keys: Awaited<ReturnType<typeof getKeysFromCoNETPGPSC>> = null
	try {
		keys = await getKeysFromCoNETPGPSC(Wallet.address)
	} catch (ex) {
		if (!isRecipientReadError(ex)) throw ex
		console.warn('[getOwnKeysFromCoNETPGPSC] own record read failed (network_error)')
		return null
	}
	if (!keys) return null
	let privateArmored = ''
	try {
		const own = await readOwnPgpPrivateArmored(ownBlobDeps(Wallet.address))
		if (own.migrationError) console.warn('[pgpBlob] migration not completed:', own.migrationError)
		if (own.state === 'ok') privateArmored = own.armored
	} catch {
		// Private read failed — keep the public part.
	}
	return { ...keys, privateArmored }
}



/**
 * Last non-empty Guardian list. A chain RPC hiccup (for example while every SI
 * node restarts) used to return [] and stop chat until the app was restarted.
 */
let lastGoodChatNodes: nodeInfo[] = []

/** 获取 CoNET 节点列表（供 sendMessage 等使用），可单独调用无需 initChat */
export const getCoNETNodesForChat = async (): Promise<nodeInfo[]> => {
	const fresh = await loadCoNETNodesFromChain()
	if (fresh.length) {
		lastGoodChatNodes = fresh
		return fresh
	}
	if (lastGoodChatNodes.length) {
		chatBootLog(`CoNET node list read failed; using the last list (${lastGoodChatNodes.length})`, 'warn')
		return lastGoodChatNodes.slice()
	}
	return []
}

/** the node list could not be read and no last list exists. Thrown, never passed on as an empty list. */
export class NodesUnavailableError extends Error {
	constructor() {
		super('nodes_unavailable')
		this.name = 'NodesUnavailableError'
	}
}

/** The node list for a start that must not run on an empty list: throws NodesUnavailableError when there is none. */
export const getCoNETNodesOrThrow = async (): Promise<nodeInfo[]> => {
	const list = await getCoNETNodesForChat()
	if (!list.length) throw new NodesUnavailableError()
	return list
}

const loadCoNETNodesFromChain = async (): Promise<nodeInfo[]> => {
	const outcome = await loadCoNETNodesOutcome()
	return outcome.ok ? outcome.nodes : []
}

const getAllNodes = getCoNETNodesForChat

const isPgpKeyComplete = (pgp: initBeamioPGPKeysRet | undefined): boolean => {
	if (!pgp) return false
	// keyID、privateKey、publicKey 必填；routes 可为空（后续从链上拉取）
	return !!(pgp.keyID?.trim() && pgp.privateKey?.trim() && pgp.publicKey?.trim() && typeof pgp.routes === 'string')
}

/** 互斥：确保同一时刻只有一个 initChat 在执行 */
let initChatInProgress = false

/**
 * initChat that stopped for a network reason (no Guardian nodes, listen did
 * not open) retries by itself: 2/4/8/16/30 s, then every 30 s, until chat is
 * listening. Each retry is a normal initChat (random entry, no wallet sent).
 */
const CHAT_RETRY_DELAYS_MS = [2_000, 4_000, 8_000, 16_000, 30_000]
/** / consecutive failed shell starts. The limit stops the automatic retries; the notice offers a manual retry. */
const shellRetryCap = createShellRetryCap(SHELL_CHAT_RETRY_LIMIT)
/** -6: the temporary PGP source retries so far (the backoff index); reset when the start succeeds. */
let pgpTemporaryAttempt = 0
/** Own-mailbox registrations that failed in a row; spaces out the next one (chatOwnRoutePlan.ts). */
const ownRegisterBackoff = createOwnRegisterBackoff()
let chatRetryTimer: ReturnType<typeof setTimeout> | undefined
let chatRetryAttempt = 0
let chatRetryArgs: Parameters<typeof initChat> | null = null

const clearChatRetry = (resetBackoff: boolean) => {
	if (chatRetryTimer !== undefined) clearTimeout(chatRetryTimer)
	chatRetryTimer = undefined
	if (resetBackoff) chatRetryAttempt = 0
}

const scheduleChatRetry = (reason: string, args: Parameters<typeof initChat>, delayMs?: number) => {
	chatRetryArgs = args
	if (chatRetryTimer !== undefined) return
	const delay = delayMs ?? CHAT_RETRY_DELAYS_MS[Math.min(chatRetryAttempt, CHAT_RETRY_DELAYS_MS.length - 1)]
	chatRetryAttempt += 1
	chatBootLog(`initChat retry #${chatRetryAttempt} in ${delay / 1000}s (${reason})`, 'warn')
	chatRetryTimer = setTimeout(() => {
		chatRetryTimer = undefined
		const retryArgs = chatRetryArgs
		if (!retryArgs) return
		if (currentGossipAbortController && !currentGossipAbortController.signal.aborted) {
			chatRetryAttempt = 0
			return
		}
		if (initChatInProgress) {
			scheduleChatRetry('another start is running', retryArgs)
			return
		}
		const [setProfiles, setAllNodes, setGossip, , newMessage] = retryArgs
		void initChat(setProfiles, setAllNodes, setGossip, false, newMessage)
	}, delay)
}

/**
 * / the notice's manual retry. It starts the count again and runs one normal start with the arguments of the
 * last scheduled or stopped retry.
 */
export function retryShellChatNow(): void {
	shellRetryCap.reset()
	setShellRetryExhausted(false)
	pgpTemporaryAttempt = 0
	setShellPgpTemporaryStopped(false)
	const args = chatRetryArgs
	if (!args) return
	const [setProfiles, setAllNodes, setGossip, , newMessage] = args
	void initChat(setProfiles, setAllNodes, setGossip, false, newMessage)
}
registerShellRetryNow(retryShellChatNow)

// Refuses any signing request from the worker in a shell: the native layer signs (W5), not the page.
const refuseShellSigning = async (): Promise<string> => {
	throw new Error('native_signing_only')
}

/** The shell start's collaborators, bound to this module's state.,. */
const shellChatStartDeps = (ctx: {
	setProfiles: (val: profile[]) => void
	setAllNodes: (val: nodeInfo[]) => void
	setGossip: (val: boolean) => void
	newMessage: (val: string) => void
}): ShellChatStartDeps => ({
	readIdentity: readNativeIdentityPublic,
	readPersistedEoa: readPersistedShellEoa,
	initWithPersistedEoa: SHELL_G1_INIT_ENABLED
		? (eoa, nodes) => initShellIdentityOnly(eoa, nodes as unknown as Parameters<typeof initShellIdentityOnly>[1])
		: undefined,
	setIdentityPending: setShellIdentityPending,
	setFirstIdentity: setShellFirstIdentity,
	evaluatePgp: () => evaluateNativePgpRestore(shellAccountKeyOrEmpty()),
	restorePgp: () => restoreNativePgp(shellAccountKeyOrEmpty()),
	showPgpFailure: (code) => setPgpRestoreFailure(code, null),
	showChatUnavailable: () => setShellChatUiState('chat_unavailable'),
	setPgpTemporary: (value: boolean) => setShellPgpTemporary(value),
	getNodes: async () => (await getCoNETNodesOrThrow()) as unknown as Array<{ domain: string; armoredPublicKey?: string }>,
	setAllNodes: (n) => {
		// The native chat module chooses its own voice relay from this list, as the browser path does.
		setNativeVoiceRelayNodes(n as unknown as nodeInfo[])
		ctx.setAllNodes(n as unknown as nodeInfo[])
	},
	setGossip: ctx.setGossip,
	mailboxDomainsFor: (nodes, route) =>
		new Set(pickRouteNodesByArmoredKey(nodes as unknown as nodeInfo[], route).map((n) => n.domain)),
	pickEntries: async (c) => (await pickHealthyGossipNodes(c as unknown as nodeInfo[])) as unknown as Array<{ domain: string; armoredPublicKey?: string }>,
	onListenPlanned: (plan) => {
		gossipDeliveryAckContext = {
			routerArmoredPublicKey: plan.routeArmored,
			privateKeyArmor: '',
			entryNodes: plan.entryNodes as unknown as nodeInfo[],
			mailboxDomains: [...plan.mailboxDomains],
		}
	},
	onController: (c) => {
		currentGossipAbortController = c
	},
	startListen: (p) =>
		startWorkerGossipListen({
			...p,
			nodes: p.nodes as unknown as nodeInfo[],
			signAccount: refuseShellSigning,
		}),
	onLine: (line) => ctx.newMessage(line),
	onActivity: () => noteGossipActivity(),
	log: (level, message) => chatBootLog(message, level),
	retry: (reason, kind = 'failure') => {
		const args: Parameters<typeof initChat> = [ctx.setProfiles, ctx.setAllNodes, ctx.setGossip, false, ctx.newMessage]
		// -6 (5a): a temporary source state is retried with the 30 s, 2 min, 10 min backoff; it does not count as a failure.
		if (kind === 'temporary') {
			// 30 s, 2 min, 10 min, then the automatic retries stop; the notice offers a manual retry (retryShellChatNow).
			const delay = nextPgpTemporaryDelay(pgpTemporaryAttempt)
			if (delay === null) {
				setShellPgpTemporaryStopped(true)
				chatBootLog('pgp source still unavailable: automatic retries stopped; the manual retry is offered', 'warn')
				return
			}
			pgpTemporaryAttempt += 1
			scheduleChatRetry(reason, args, delay)
			return
		}
		if (kind === 'continue' || shellRetryCap.failed() === 'retry') {
			scheduleChatRetry(reason, args)
			return
		}
		// the limit stops the automatic retries. The arguments are kept for the notice's manual retry.
		chatRetryArgs = args
		setShellRetryExhausted(true)
		chatBootLog(`shell chat: ${SHELL_CHAT_RETRY_LIMIT} consecutive failures (${reason}); automatic retry stopped`, 'warn')
	},
	listenRefusal: () => takeListenRefusal(),
	takeIdentityClosed: () => takeIdentityClosedRefusal(),
	showIdentityClosed: (reason) => setIdentityClosed({ reason, source: identityClosedSource(reason, importSwitchFailedThisSession()) }),
});

export const initChat = async (setProfiles: (val: profile[]) => void, setAllNodes: (val: nodeInfo[]) => void, setGossip: (val: boolean) => void, gossip: boolean, newMessage: (val: string) => void) => {
	if (initChatInProgress) {
		chatBootLog('initChat skipped: already in progress', 'info')
		return
	}
	// a live client bound to ANOTHER account is stopped and the start goes on; a gossip flag does not keep it.
	const pageAccount = (accountEoaFor(resolveSigningPrivateKeyArmor(CoNET_Data?.profiles?.[0])) || '').toLowerCase()
	const decision = gossipStartDecision({ gossip, bound: boundAccountOfActiveClient(), account: pageAccount, shell: isShellContext() })
	if (decision === 'skip') {
		chatBootLog('initChat skipped: gossip already active', 'info')
		return
	}
	if (decision === 'restart') {
		chatBootLog('initChat: the live client belongs to another account; stopping it before the start for the current account', 'warn')
		clearGossipListenSession('account_changed')
		setGossip(false)
	}

	// Option A: a shell without identity.native-keys.v1 starts nothing and reads no key. Refused before any state change.
	if (isShellContext() && (await ensureShellChatState()) !== 'native_chat') {
		chatBootLog('initChat not started: this shell has not declared identity.native-keys.v1 (chat unavailable)', 'warn')
		setGossip(false)
		return
	}

	// Shell: the chat starts from the native public identity (identityPublic, G2). No page key is read, and no
	// page-key step (own-chain reads, registration, the connection signer) runs. The browser path below is unchanged.
	if (isShellContext()) {
		initChatInProgress = true
		try {
			const result = await startShellChatFromNativeIdentity(shellChatStartDeps({ setProfiles, setAllNodes, setGossip, newMessage }))
			chatBootLog(`shell chat start: ${result}`)
			if (result === 'started') {
				// a start that succeeds clears the temporary state (it does not linger on the success path).
				pgpTemporaryAttempt = 0
				setShellPgpTemporary(false)
				shellRetryCap.reset()
				setShellRetryExhausted(false)
				setIdentityClosed(null)
			}
		} finally {
			initChatInProgress = false
		}
		return
	}
	// Browser path (not part of the shell target: compiled out by the build-time constant).
	if (process.env.REACT_APP_SHELL_BUILD !== 'true') {

	// Shell: this page does not read or use the wallet key to start chat. The start path below needs the key on
	// the page (own-chain reads, registration, the connection signer), so a shell stops here. The public identity has to come from the
	// native side (identityPublic, pending). Until then the shell start is not run, and nothing is read.
	if (isShellContext()) {
		chatBootLog('initChat not started in this shell: public identity from the native side is not available yet (pending)', 'warn')
		setGossip(false)
		return
	}

	initChatInProgress = true
	// A start reads the chain itself: a recheck still waiting is not needed.
	ownRouteRecheckGen += 1
	chatBootLog('initChat starting…')
	try {
		setGossip(true)
		const allNodes = await getAllNodes()
		chatBootLog(`CoNET nodes loaded: ${allNodes?.length ?? 0}`)
		// An init while offline loads no nodes. Keep the last list instead of
		// wiping it: an empty list failed the next dial ("chain mailbox is not
		// in the node list") until a later init reloaded it.
		if (allNodes?.length) setAllNodes(allNodes)
		const temp = CoNET_Data
		if (!temp || !temp?.profiles?.length) {
			chatBootLog('initChat abort: no profiles in CoNET_Data', 'warn')
			setGossip(false)
			return
		}
		const profiles: profile[] =  temp.profiles
		let profile = profiles[0]
		if (!profile) {
			chatBootLog('initChat abort: empty profiles[0]', 'warn')
			setGossip(false)
			return
		}
		if (!profile.privateKeyArmor || !isValidEthersPrivateKey(profile.privateKeyArmor)) {
			chatBootLog('initChat abort: privateKeyArmor invalid or missing', 'warn')
			setGossip(false)
			return
		}
		let chatManager: IChat|undefined = profile?.chatManager
		let routes: string = chatManager?.router||''
		//		本地非初始化 或 pgpKey 不完整则重新生成
		if (!chatManager || !isPgpKeyComplete(chatManager.pgpKey)) {
			const pgpData = await initBeamioPGPKeys(profile)
			if (!pgpData) {
				setGossip(false)
				//  plan A: a restore failure is shown to the user and is never retried automatically.
				if (getPgpRestoreFailure()) return
				// Chain key unreadable right now: retry instead of making a new key.
				scheduleChatRetry('own chain key unreadable', [setProfiles, setAllNodes, setGossip, false, newMessage])
				return
			}

			chatManager = {
				pgpKey: pgpData,
				// Keep the chain route just read: it is the current mailbox if a later read fails.
				router: chatManager?.router || pgpData.routes || '',

			}
			profile.chatManager = chatManager
			routes = pgpData.routes || chatManager.router || ''
		}


		// ✅ 如果没有 routes，从链上/SC 找；再不行就随机注册一个
		//	寻找链上信息
		const rr = await getOwnKeysFromCoNETPGPSC(profile.privateKeyArmor)
		routes = rr?.routersArmoreds||''
		// Own mailbox (chatOwnRoutePlan.ts). A failed chain read keeps the current
		// mailbox and never registers. Only a successful read that shows no record,
		// another key or no route registers the local key, on the mailbox the
		// account already has; a random mailbox is only for a new account.
		const localKeyID = await getPublicKeyArmoredKeyID(chatManager.pgpKey.publicKey || '').catch(() => '')
		const ownChain = await readOwnChatChain(rr, profile.privateKeyArmor)
		const pgpState = classifyOwnPgp({ read: ownChain.read, localKeyID, hasLocalKey: !!chatManager?.pgpKey?.privateKey })
		if (pgpState.kind === 'failure') {
			setPgpRestoreFailure(pgpState.code, snapshotOfRead(ownChain.read))
			chatBootLog(`initChat stopped: ${pgpState.code}; no registration, no new key, no retry`, 'warn')
			setGossip(false)
			return
		}
		setPgpRestoreFailure(null)
		const currentMailbox = resolveCurrentMailbox(chatManager.router || '', allNodes || [], null)
		const plan = planOwnChatRoute({
			read: ownChain.read,
			localKeyID,
			current: currentMailbox.mailbox,
			currentArmor: currentMailbox.armor,
		})
		chatBootLog(`own mailbox: ${plan.action} (${plan.reason})`, plan.action === 'use-chain' ? 'info' : 'warn')
		const ownRouteRetryArgs: Parameters<typeof initChat> = [setProfiles, setAllNodes, setGossip, false, newMessage]
		// True once a working chain read confirmed the mailbox we are about to listen on.
		let routeConfirmed = false
		const ownWallet = new ethers.Wallet(profile.privateKeyArmor).address
		if (plan.action === 'use-chain') {
			ownRegisterBackoff.reset()
			noteOwnMailboxVerified(ownWallet, plan.mailbox.routeKeyID, plan.mailbox.routeArmor)
		} else {
			forgetOwnMailboxVerified(ownWallet)
		}
		if (plan.action === 'use-chain') {
			routes = plan.mailbox.routeArmor
			routeConfirmed = true
		} else if (plan.action === 'keep-current') {
			routes = plan.routeArmor
		} else if (plan.action === 'wait-retry') {
			setGossip(false)
			scheduleChatRetry('own chain record unreadable', ownRouteRetryArgs)
			return
		} else {
			let randomNode: nodeInfo | null = null
			if (plan.target === 'random') {
				// Only a node AddressPGP has recorded; a failed check picks nothing.
				const pick = await pickRecordedMailbox({
					candidates: getRandomNodes(allNodes || [], Math.min(8, (allNodes || []).length)),
					routeKeyID: (n) => n.domain,
					isRecorded: isMailboxNodeRecorded,
				})
				if (pick.skipped.length) chatBootLog(`new mailbox: skipped unrecorded nodes ${pick.skipped.join(',')}`, 'warn')
				if (pick.status === 'error') {
					chatBootLog(`new mailbox: node check failed (${pick.reason}); retrying later`, 'warn')
					setGossip(false)
					scheduleChatRetry('mailbox node check failed', ownRouteRetryArgs)
					return
				}
				randomNode = pick.status === 'ok' ? pick.node : null
			}
			const target = plan.target !== 'random'
				? plan.target
				: randomNode ? { routeKeyID: randomNode.domain, routeArmor: randomNode.armoredPublicKey } : null
			const registerWaitMs = target ? ownRegisterBackoff.remainingMs(Date.now()) : 0
			if (target && registerWaitMs > 0) {
				// The last registration failed: wait it out, never register again at once.
				chatBootLog(`own mailbox: registration failed ${ownRegisterBackoff.failures()}x; next try in ${Math.ceil(registerWaitMs / 1000)}s`, 'warn')
				if (plan.target === 'random') {
					setGossip(false)
					scheduleChatRetry('mailbox registration backoff', ownRouteRetryArgs, registerWaitMs)
					return
				}
				// An existing mailbox: keep listening on it; the recheck waits too.
				routes = target.routeArmor
			} else if (target) {
				routes = target.routeArmor
				let registered: boolean
				if (isShellContext()) {
					registered = await regiestChatRouteNative(localKeyID || chatManager.pgpKey.keyID, chatManager.pgpKey.publicKey, target.routeKeyID)
				} else {
					registered = await regiestChatRoute(profile.privateKeyArmor, chatManager.pgpKey.publicKey, localKeyID || chatManager.pgpKey.keyID, chatManager.pgpKey.privateKey, target.routeKeyID)
				}
				if (registered) {
					// The record can take a few seconds to show: read up to 3 times (1.5/3/6 s).
					const wantRoute = mailboxKeyId(target.routeKeyID || '')
					const { record: verified, reads } = await verifyRegistration({
						sleep: (ms) => new Promise<boolean>(resolve => setTimeout(() => resolve(true), ms)),
						read: async () => {
							const v = await getOwnKeysFromCoNETPGPSC(profile.privateKeyArmor)
							if (!v?.privateArmored?.trim() || !v.routersArmoreds || !localKeyID) return null
							if ((v.userPgpKeyID || '').toUpperCase() !== localKeyID) return null
							if (wantRoute && mailboxKeyId(v.routePgpKeyID || '') !== wantRoute) return null
							return v
						},
					})
					if (verified) {
						routes = verified.routersArmoreds || ''
						routeConfirmed = Boolean(routes)
						if (routeConfirmed) noteOwnMailboxVerified(ownWallet, verified.routePgpKeyID || '', routes)
						chatBootLog(`PGP chain/local key verified before gossip listen (read ${reads})`)
					} else {
						chatBootLog(
							`PGP registration not on chain after ${reads} reads; gossip listen will use the current key only if the route is valid`,
							'error',
						)
					}
				}
				if (routeConfirmed) {
					ownRegisterBackoff.reset()
				} else {
					const waitMs = ownRegisterBackoff.fail(Date.now())
					const what = registered ? 'registration not confirmed' : 'registration failed'
					chatBootLog(`own mailbox: ${what} ${ownRegisterBackoff.failures()}x; next try in ${waitMs / 1000}s`, 'warn')
				}
				if (!registered && plan.target === 'random') {
					// A new account whose registration failed has no mailbox yet.
					setGossip(false)
					scheduleChatRetry('mailbox registration failed', ownRouteRetryArgs, ownRegisterBackoff.remainingMs(Date.now()))
					return
				}
			} else {
				setGossip(false)
				scheduleChatRetry('no CoNET nodes for a new mailbox', ownRouteRetryArgs)
				return
			}
		}

		//	链上route信息
		if (routes) {
			chatManager.router = routes
		}



		profile.chatManager = chatManager
		temp.profiles[0] = profile
		setProfiles(profiles)
		setCoNET_Data(temp)
		storeSystemData()

		// Voice v3: route keys of all nodes, so the shell can pick its own relays. No PGP private key crosses the bridge.
		try {
			setNativeVoiceRelayNodes(allNodes)
		} catch {
			/* shell may omit bridge on first paint */
		}

		if (!allNodes?.length) {
			chatBootLog('initChat abort: no CoNET gossip nodes', 'warn')
			setGossip(false)
			scheduleChatRetry('no CoNET nodes', [setProfiles, setAllNodes, setGossip, false, newMessage])
			return
		}
	
		chatBootLog(`connectToGossipNode starting (route=${routeIdForLog(chatManager.router, allNodes)} confirmed=${routeConfirmed})`)
		const started = await connectToGossipNode(
			chatManager.router,
			profile.privateKeyArmor,
			allNodes,
			process.env.REACT_APP_SHELL_BUILD === 'true' ? '' : chatManager.pgpKey.privateKey,
			chatManager.pgpKey.publicKey ?? '',
			newMessage,
		)
		if (!started && getPgpRestoreFailure()) {
			setGossip(false)
			return
		}
		if (!started) {
			chatBootLog('initChat: gossip listen did not start — clearing gossip flag for retry', 'warn')
			setGossip(false)
			scheduleChatRetry('listen did not start', [setProfiles, setAllNodes, setGossip, false, newMessage])
		} else {
			clearChatRetry(true)
			if (!routeConfirmed) {
				startOwnRouteRecheck(chatManager.router, profile.privateKeyArmor, localKeyID, allNodes, ownRouteRetryArgs)
			}
		}
	} catch (error) {
		chatBootLog(`initChat error: ${(error as Error)?.message ?? String(error)}`, 'error')
		setGossip(false)
		if (getPgpRestoreFailure()) return
		scheduleChatRetry('error', [setProfiles, setAllNodes, setGossip, false, newMessage])
	} finally {
		initChatInProgress = false
	}
	}
}

/** Outcome of the browser "生成新 PGP 私钥" click (decision 2026-11-13). */
export type PgpRegenerateReason = 'no_failure' | 'no_profile' | 'read_error' | 'chain_changed' | 'no_mailbox' | 'register_failed' | 'persist_failed'
export type PgpRegenerateOutcome = { ok: true } | { ok: false; reason: PgpRegenerateReason }

/**
 * The user's click on "生成新 PGP 私钥" in a browser, after a restore failure. The chain is read again first, and the action
 * stops unless it is still in the state the user was shown; then a new key is generated, registered with its backup, and
 * stored. Nothing is overwritten by surprise. In a shell the native layer does this instead (nativePgpRestore.ts).
 */
export const regeneratePgpKeyByUser = async (): Promise<PgpRegenerateOutcome> => {
	if (isShellContext()) return { ok: false, reason: 'no_failure' }
	if (process.env.REACT_APP_SHELL_BUILD !== 'true') {
	const shown = getPgpRestoreSnapshot()
	if (!getPgpRestoreFailure() || !shown) return { ok: false, reason: 'no_failure' }
	const temp = CoNET_Data
	const profile = temp?.profiles?.[0]
	if (!temp || !profile?.privateKeyArmor || !isValidEthersPrivateKey(profile.privateKeyArmor)) return { ok: false, reason: 'no_profile' }
	// Compare the chain as it is now, before anything is generated or registered.
	let own: Awaited<ReturnType<typeof readOwnChatChain>>
	try {
		own = await readOwnChatChain(await getOwnKeysFromCoNETPGPSC(profile.privateKeyArmor), profile.privateKeyArmor)
	} catch {
		return { ok: false, reason: 'read_error' }
	}
	if (own.read.status === 'error') return { ok: false, reason: 'read_error' }
	if (snapshotOfRead(own.read) !== shown) return { ok: false, reason: 'chain_changed' }
	// The mailbox the account already has: the chain route if readable, else the current one.
	const allNodes = (await getAllNodes().catch(() => [])) || []
	const current = resolveCurrentMailbox(profile.chatManager?.router || '', allNodes, null)
	const route = own.read.status === 'ok' && own.read.routeKeyID && own.read.routeArmor
		? { routeKeyID: own.read.routeKeyID, routeArmor: own.read.routeArmor }
		: current.mailbox && current.mailbox.routeKeyID && current.mailbox.routeArmor
			? { routeKeyID: current.mailbox.routeKeyID, routeArmor: current.mailbox.routeArmor }
			: null
	if (!route) return { ok: false, reason: 'no_mailbox' }
	const keys = await generatePgpKey(profile.keyID, '')
	const privateKey = keys.privateKey as unknown as string
	const publicKey = keys.publicKey as unknown as string
	const registered = await regiestChatRoute(profile.privateKeyArmor, publicKey, keys.keyID, privateKey, route.routeKeyID)
	if (!registered) return { ok: false, reason: 'register_failed' }
	profile.chatManager = {
		pgpKey: { privateKey, publicKey, keyID: keys.keyID, routes: route.routeArmor },
		router: route.routeArmor,
	}
	temp.profiles[0] = profile
	setCoNET_Data(temp)
	if (!(await storeSystemDataAndWait())) return { ok: false, reason: 'persist_failed' }
	setPgpRestoreFailure(null, null)
	return { ok: true }
	}
	return { ok: false, reason: 'no_failure' }
}

export const initBeamioPGPKeys = async (profile: profile): Promise<initBeamioPGPKeysRet|null> => {
	// Shell: PGP keys are native (identity.native-keys); the page generates none.
	if (isShellContext()) return null
	
	const keyInfo = await getOwnKeysFromCoNETPGPSC(profile.privateKeyArmor)
	if (keyInfo?.privateArmored) {
		return {
			privateKey: keyInfo.privateArmored,
			publicKey: keyInfo.publicArmored,
			keyID: profile.keyID || keyInfo.userPgpKeyID || '',
			routes: keyInfo.routersArmoreds
		}
	}

	// No usable chain private key. Make a new key only when the read worked and
	// the chain holds nothing we could ever load (no record, no blob, or a blob
	// our key cannot open). A failed read returns null so initChat retries;
	// a new key here would overwrite the user's key on chain.
	const own = await readOwnChatChain(keyInfo, profile.privateKeyArmor)
	//  plan A: a restore failure (backup missing or not openable) is shown and stops here. A failed read is not a
	// failure and is retried; it clears a failure shown earlier. Only the user's click may make a new key (regeneratePgpKeyByUser).
	const restore = classifyOwnPgp({ read: own.read, localKeyID: '', hasLocalKey: false })
	if (restore.kind === 'failure') {
		setPgpRestoreFailure(restore.code, snapshotOfRead(own.read))
		chatBootLog(`initBeamioPGPKeys stopped: ${restore.code}; no new key, no retry`, 'warn')
		return null
	}
	if (restore.kind === 'read_error') setPgpRestoreFailure(null)
	// An unreadable record (or a blob that cannot be opened) blocks a new key: a new key would overwrite it on chain.
	if (blocksNewPgpKey(own.read)) {
		const why = own.read.status === 'error' ? own.read.reason : `private blob ${own.read.status === 'ok' ? own.read.privateBlob : ''}`
		chatBootLog(`initBeamioPGPKeys: chain key unreadable (${why}); not making a new key, record kept`, 'warn')
		return null
	}
	if (own.read.status === 'ok' && own.privateArmored && own.publicArmored) {
		return {
			privateKey: own.privateArmored,
			publicKey: own.publicArmored,
			keyID: profile.keyID || own.read.userKeyID || '',
			routes: own.read.routeArmor,
		}
	}

	//  (plan A): a record that exists is never replaced by a new key (it would overwrite the record on chain).
	// Only an absent record (a new account) may make one.
	if (own.read.status === 'ok') {
		setPgpRestoreFailure(own.read.privateBlob === 'missing' ? 'pgp_backup_missing' : 'pgp_backup_undecryptable', snapshotOfRead(own.read))
		chatBootLog('initBeamioPGPKeys: the chain record exists but its backup cannot restore the key; no new key is made', 'warn')
		return null
	}
	const keys = await generatePgpKey(profile.keyID,'')
	const ret: initBeamioPGPKeysRet = {
		privateKey: keys.privateKey as unknown as string,
		publicKey: keys.publicKey as unknown as string,
		keyID: keys.keyID,
		routes: ''
	}
	return ret
}

/** Our own encrypted PGP private key: loaded, absent on chain, or not openable with our key. Throws on RPC error. */
const probeOwnPrivateBlob = async (privateKeyArmor: string): Promise<{ state: OwnPrivateBlob; armored: string }> => {
	if (process.env.REACT_APP_SHELL_BUILD === 'true') throw new Error('pgp_not_in_shell') // Boundary: own-PGP reads are not built into a shell; the native SDK reads them.
	const address = new ethers.Wallet(privateKeyArmor).address
	if (!ensureWalletCoreUnlocked(privateKeyArmor, address)) throw new Error('wallet locked')
	const own = await readOwnPgpPrivateArmored(ownBlobDeps(address))
	switch (own.state) {
		case 'ok':
			return own.armored?.trim() ? { state: 'ok', armored: own.armored } : { state: 'undecryptable', armored: '' }
		case 'missing':
			return { state: 'missing', armored: '' }
		case 'undecryptable':
			return { state: 'undecryptable', armored: '' }
		default:
			// 'locked' and 'error' throw, so the caller records 'error' and does not register a new key.
			throw new Error(own.state)
	}
}

/**
 * Our own AddressPGP record, with a failed read told apart from an empty one
 * (chatOwnRoutePlan.ts `readOwnChainState`). `rr` is the getOwnKeysFromCoNETPGPSC
 * result, which is null in both cases; on null the record is read once more
 * with searchKey (no `from`).
 */
const readOwnChatChain = async (
	rr: Awaited<ReturnType<typeof getOwnKeysFromCoNETPGPSC>>,
	privateKeyArmor: string,
) => {
	if (process.env.REACT_APP_SHELL_BUILD === 'true') throw new Error('pgp_not_in_shell') // Boundary: own-PGP reads are not built into a shell; the native SDK reads them.
	const own = await readOwnChainState({
		first: rr
			? {
				userKeyID: rr.userPgpKeyID || '',
				routeKeyID: rr.routePgpKeyID || '',
				routeArmor: rr.routersArmoreds || '',
				publicArmored: rr.publicArmored || '',
				privateArmored: rr.privateArmored || '',
			}
			: null,
		searchKey: async () => {
			const address = new ethers.Wallet(privateKeyArmor).address
			const contract = contracts.constPgpManager
			const SC = new ethers.Contract(contract.address, contract.abi, conetDepinProvider)
			const info: searchKeyPGP = await SC.searchKey(address)
			const publicArmored = info?.userPublicKeyArmored ? fromBase64(info.userPublicKeyArmored) : ''
			const routeArmor = info?.routePublicKeyArmored ? fromBase64(info.routePublicKeyArmored) : ''
			if (!publicArmored && !routeArmor) return null
			return { userKeyID: info.userPgpKeyID || '', routeKeyID: info.routePgpKeyID || '', routeArmor, publicArmored }
		},
		probeBlob: () => probeOwnPrivateBlob(privateKeyArmor),
	})
	if (own.read.status === 'error') chatBootLog(`own chain read failed: ${own.read.reason}`, 'warn')
	return own
}

/** AddressPGP has recorded this node as a mailbox (`nodeKeyExists`). Throws on RPC error. */
const isMailboxNodeRecorded = async (routeKeyID: string): Promise<boolean> => {
	const contract = contracts.constPgpManager
	const SC = new ethers.Contract(contract.address, contract.abi, conetDepinProvider)
	return Boolean(await SC.nodeKeyExists(ethers.id(routeKeyID)))
}

/** Route key ID of a mailbox armor for logs (node domain = route key ID); '?' if not in the list. */
const routeIdForLog = (armor: string, nodes: nodeInfo[]): string =>
	resolveCurrentMailbox(armor || '', nodes || [], null).mailbox?.routeKeyID || (armor ? '?' : 'none')

/**
 * Own mailbox confirmed by a working chain read during this run. Memory only:
 * a restart starts unverified. Written by initChat, the listen recheck and the
 * dial path (alignLiveGossipRouteToChain); the dial path skips waiting for the
 * chain only when this is set.
 */
type VerifiedOwnMailbox = { wallet: string; routeKeyID: string; routeArmor: string; verifiedAt: number }
let verifiedOwnMailbox: VerifiedOwnMailbox | null = null

/** A working chain read named this mailbox for `wallet`. */
export const noteOwnMailboxVerified = (wallet: string, routeKeyID: string, routeArmor: string): void => {
	const armor = (routeArmor || '').replace(/\r/g, '').trim()
	const w = (wallet || '').toLowerCase()
	if (!w || !armor) return
	verifiedOwnMailbox = { wallet: w, routeKeyID: (routeKeyID || '').trim().toUpperCase(), routeArmor: armor, verifiedAt: Date.now() }
}

/** The local mailbox and the chain disagree, or the registration just changed: unverified again. */
export const forgetOwnMailboxVerified = (wallet: string): void => {
	if (verifiedOwnMailbox && verifiedOwnMailbox.wallet === (wallet || '').toLowerCase()) verifiedOwnMailbox = null
}

/** The mailbox verified in this run for `wallet`, or null. */
export const getVerifiedOwnMailbox = (wallet: string): { routeKeyID: string; routeArmor: string; verifiedAt: number } | null => {
	const v = verifiedOwnMailbox
	if (!v || !wallet || v.wallet !== wallet.toLowerCase()) return null
	return { routeKeyID: v.routeKeyID, routeArmor: v.routeArmor, verifiedAt: v.verifiedAt }
}

let ownRouteRecheckGen = 0

/** Wait `ms`, cut short when the network comes back. False once the check is stale or the listen is gone. */
const waitForOwnRouteRecheck = (ms: number, gen: number): Promise<boolean> => new Promise((resolve) => {
	let timer: ReturnType<typeof setTimeout> | undefined
	const done = () => {
		clearTimeout(timer)
		window.removeEventListener('online', done)
		const live = !!currentGossipAbortController && !currentGossipAbortController.signal.aborted
		resolve(gen === ownRouteRecheckGen && live)
	}
	timer = setTimeout(done, ms)
	window.addEventListener('online', done)
})

/**
 * The listen started on a mailbox no working chain read confirmed (the chain
 * read failed, e.g. airplane mode). Keep it, read the chain with backoff, and
 * once a read works and names another mailbox, start chat again so the listen
 * moves to the chain mailbox (2026-11-02: a stray mailbox outlived the
 * outage and calls to the chain mailbox never arrived).
 */
const startOwnRouteRecheck = (
	listenArmor: string,
	privateKeyArmor: string,
	localKeyID: string,
	nodes: nodeInfo[],
	args: Parameters<typeof initChat>,
) => {
	const gen = ++ownRouteRecheckGen
	const listenId = routeIdForLog(listenArmor, nodes)
	void recheckListenRoute({
		listenArmor: () => getWorkerGossipRouteArmor() || listenArmor,
		read: async () => (await readOwnChatChain(null, privateKeyArmor)).read,
		localKeyID,
		sleep: (ms) => waitForOwnRouteRecheck(ms, gen),
		onRetry: (why, ms) => chatBootLog(`own mailbox recheck: chain read failed (${why}); keeping route=${listenId}; retry in ${ms / 1000}s`, 'warn'),
	}).then(async ({ result, read }) => {
		if (gen !== ownRouteRecheckGen || result === 'gone') return
		const ownWallet = new ethers.Wallet(privateKeyArmor).address
		if (result === 'match') {
			ownRegisterBackoff.reset()
			if (read?.status === 'ok') noteOwnMailboxVerified(ownWallet, read.routeKeyID, read.routeArmor)
			chatBootLog(`own mailbox recheck: route=${listenId} matches chain`)
			return
		}
		forgetOwnMailboxVerified(ownWallet)
		const chainId = read?.status === 'ok' ? (read.routeKeyID || 'none') : 'none'
		const waitMs = ownRegisterBackoff.remainingMs(Date.now())
		chatBootLog(`own mailbox recheck: route=${listenId} chain=${chainId}; reconnecting per the chain record${waitMs > 0 ? ` in ${Math.ceil(waitMs / 1000)}s` : ''}`, 'warn')
		// A registration just failed: wait before chat starts again (and registers).
		if (waitMs > 0 && !(await waitForOwnRouteRecheck(waitMs, gen))) return
		if (gen !== ownRouteRecheckGen || initChatInProgress) return
		clearGossipListenSession('own_route_mismatch')
		const [setProfiles, setAllNodes, setGossip, , newMessage] = args
		setGossip(false)
		void initChat(setProfiles, setAllNodes, setGossip, false, newMessage)
	}).catch((ex) => chatBootLog(`own mailbox recheck error: ${(ex as Error)?.message ?? String(ex)}`, 'warn'))
}

/** The one POST of a registration. Both paths send the body through here; the body is never reordered. */
const postRegiestChatRoute = async (body: Record<string, unknown>): Promise<{ ok: boolean }> => {
	// the chat start awaits this POST. A stalled server is a refused registration after the bound (the caller retries later).
	const timeout = abortAfter(BOOT_REQUEST_TIMEOUT_MS)
	try {
		const res = await fetch(`${beamioApi}/api/regiestChatRoute`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
			signal: timeout.signal,
		})
		const json = await res.json()
		if (!res.ok) {
			console.error('[regiestChatRoute]', res.status, json?.error ?? json)
		}
		return { ok: !!json?.ok }
	} finally {
		timeout.done()
	}
}

/**
 * Browser only. The EIP-191 signature is made by walletCore with the account key (layout fixed in pgpBlob.ts).
 * `encrypKeyArmored` is the blob sealed by walletCore. Returns the server's ok flag. A shell never reaches the signer here.
 */
const submitRegiestChatRoute = async (p: {
	eoa: string
	keyID: string
	publicKeyArmored: string
	encrypKeyArmored: string
	routeKeyID: string
}): Promise<boolean> => {
	if (isShellContext()) return false
	try {
		const fields = {
			wallet: ethers.getAddress(p.eoa),
			keyID: String(p.keyID || '').trim(),
			publicKeyArmored: p.publicKeyArmored,
			encrypKeyArmored: p.encrypKeyArmored,
			routeKeyID: String(p.routeKeyID || '').trim(),
			timestamp: Date.now(),
			nonce: ethers.hexlify(ethers.randomBytes(16)),
		}
		const outcome = await submitBrowserChatRouteRegister(fields, {
			signInPage: (f) => walletCore.signRegiestChatRoute(accountKeyOf(p.eoa), f),
			post: postRegiestChatRoute,
		})
		if (!outcome.ok) chatBootLog(`regiestChatRoute not sent: ${outcome.reason}`, 'warn')
		return outcome.ok
	} catch (ex: any) {
		console.error('[regiestChatRoute]', ex?.message ?? ex)
		return false
	}
}

/** Browser only: the page-key path. A shell is refused here and must use `regiestChatRouteNative`. */
export const regiestChatRoute = async (privateKey: string, pubArmor: string, keyID: string, priArmor: string, routeKeyID: string) => {
	if (isShellContext()) {
		console.error('[regiestChatRoute] page-key registration refused in a shell')
		return false
	}
	try {
		// The account address only; the key itself is handed to walletCore, which signs and seals.
		const address = new ethers.Wallet(privateKey).address
		if (!ensureWalletCoreUnlocked(privateKey, address)) return false
		const sealed = PGP_BLOB_V2_WRITES_ENABLED
			? await walletCore.pgpBlobSeal(accountKeyOf(address), priArmor)
			: await walletCore.pgpBlobLegacySeal(accountKeyOf(address), priArmor)
		return await submitRegiestChatRoute({
			eoa: address,
			keyID,
			publicKeyArmored: toBase64(pubArmor).trim(),
			encrypKeyArmored: sealed,
			routeKeyID,
		})
	} catch (ex: any) {
		console.error('[regiestChatRoute]', ex?.message ?? ex)
		return false
	}
}

/**
 * Shell: the native layer builds, signs and backs up the registration. The page sends the public fields and posts
 * the native result unchanged. A failure returns false and sends nothing: no page-key signature, no HTTP.
 */
export const regiestChatRouteNative = async (keyID: string, pubArmor: string, routeKeyID: string): Promise<boolean> => {
	try {
		const outcome = await nativeChatRouteRegister({
			keyID,
			publicKeyArmored: toBase64(pubArmor).trim(),
			routeKeyID,
		})
		const result = await submitNativeChatRouteRegister(outcome, postRegiestChatRoute)
		if (!result.ok) chatBootLog(`regiestChatRoute not sent: ${result.reason}`, 'warn')
		return result.ok
	} catch (ex: any) {
		console.error('[regiestChatRoute]', ex?.message ?? ex)
		return false
	}
}



/** SI liveness handshake / listing push expose `epoch` (= CoNET block height). */
function extractGossipListingBlockHeight(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null
  const row = payload as Record<string, unknown>
  const epoch = row.epoch
  if (epoch == null) return null
  if (typeof epoch === 'number' && Number.isFinite(epoch)) return String(Math.trunc(epoch))
  if (typeof epoch === 'string' && epoch.trim()) return epoch.trim()
  return null
}

function logGossipListingBlockHeight(
  kind: 'handshake' | 'listing',
  payload: unknown,
  rootSignal?: AbortSignal,
  nodeHint?: string
) {
  const blockHeight = extractGossipListingBlockHeight(payload)
  if (!blockHeight) return
  const nodePart = nodeHint ? ` node=${nodeHint}` : ''
  const line = `[Gossip] Listing ${kind} blockHeight=${blockHeight}${nodePart} streamActive=${!rootSignal?.aborted}`
  console.log(line)
  publishNativePwaLog('info', line)
}

const GOSSIP_STOP_REASONS = new Set([
  'root_stop',
  'replaced_by_new_connection',
  'component_unmount',
  'relaunching',
  'connect_failed',
  'foreground_resume',
  'background_pause',
])

/** Last SSE byte / handshake time — used to detect frozen iOS WKWebView streams. */
let lastGossipActivityAt = 0

const noteGossipActivity = () => {
	lastGossipActivityAt = Date.now()
}

function resolveGossipAbortReason(err: unknown, controller: AbortController, rootSignal?: AbortSignal): string {
  if (typeof err === 'string' && err) return err
  const signalReason = controller.signal.reason ?? rootSignal?.reason
  if (typeof signalReason === 'string' && signalReason) return signalReason
  if (err && typeof err === 'object' && 'message' in err && typeof (err as Error).message === 'string') {
    return (err as Error).message
  }
  return 'unknown'
}

export let currentGossipAbortController: AbortController | null = null;

/** Last live gossip listen context — used for mailbox delivery ACK (encrypt to B). */
let gossipDeliveryAckContext: {
	routerArmoredPublicKey: string
	privateKeyArmor: string
	entryNodes: nodeInfo[]
	mailboxDomains: string[]
} | null = null

const mailboxKeyId = (domain: string): string =>
	domain.split('.')[0].trim().toUpperCase()

/**
 * Voice listen encrypts to the route key frozen when gossip started.
 * A long-lived tab keeps that key after the chain mailbox moves, so the
 * offer lands on a stale node and the callee never sees it. Re-read the
 * chain route and retarget before a call. Returns false when the worker
 * still is not encrypting to that mailbox — the caller must not open a relay.
 */
/** Own mailbox route key from the last chain read in {@link alignLiveGossipRouteToChain}. */
let lastChainMailboxRouteArmor = ''

/** Why the last {@link alignLiveGossipRouteToChain} returned false (for the dial error text). */
export type MailboxAlignFailure = 'chain_unreachable' | 'not_registered' | 'not_in_node_list' | 'listen_down'
let lastMailboxAlignFailure: MailboxAlignFailure | null = null

/** Error text for a failed {@link alignLiveGossipRouteToChain}: the cause and what to do. */
export function mailboxAlignErrorMessage(): string {
	switch (lastMailboxAlignFailure) {
		case 'chain_unreachable':
			return 'Could not reach the CoNET network to check your Chat mailbox. Check your connection, then call again.'
		case 'not_registered':
			return 'Your Chat mailbox is not set up yet. Open Chat and wait until it is connected, then call again.'
		case 'not_in_node_list':
			return 'Your Chat mailbox node is missing from the node list. Close and reopen Chat, then call again.'
		case 'listen_down':
			return 'Chat is reconnecting. Wait a few seconds, then call again.'
		default:
			return 'Voice call could not use your Chat mailbox. Call again.'
	}
}

/**
 * Last own mailbox read from the chain (public route key only), per wallet.
 * A dial right after a foreground return often hits one failed RPC read; the
 * mailbox rarely changes, so the last good read is used then.
 */
const OWN_MAILBOX_CACHE_KEY = 'beamio.ownChatMailbox.v1'
type OwnMailboxRecord = { wallet: string; chainId: string; armor: string; at: number }
let ownMailboxMemo: OwnMailboxRecord | null = null

const rememberOwnMailbox = (rec: OwnMailboxRecord) => {
	ownMailboxMemo = rec
	try {
		localStorage.setItem(OWN_MAILBOX_CACHE_KEY, JSON.stringify(rec))
	} catch {
		/* storage unavailable */
	}
}

const cachedOwnMailbox = (wallet: string): OwnMailboxRecord | null => {
	let rec = ownMailboxMemo
	if (!rec) {
		try {
			rec = JSON.parse(localStorage.getItem(OWN_MAILBOX_CACHE_KEY) || 'null') as OwnMailboxRecord | null
		} catch {
			rec = null
		}
	}
	return rec && rec.wallet === wallet.toLowerCase() && rec.chainId && rec.armor ? rec : null
}


/** Own AddressPGP route, read with retries. 'unreachable' = every read failed (RPC, network). */
const readOwnMailboxFromChain = async (
	wallet: string,
): Promise<{ chainId: string; armor: string } | 'unreachable' | 'unregistered'> => {
	const contract = contracts.constPgpManager
	const SC = new ethers.Contract(contract.address, contract.abi, conetDepinProvider)
	for (let attempt = 0; attempt < 3; attempt++) {
		const started = Date.now()
		try {
			const info: searchKeyPGP = await Promise.race([
				SC.searchKey(wallet) as Promise<searchKeyPGP>,
				new Promise<never>((_, reject) => setTimeout(() => reject(new Error('searchKey timeout')), 6_000)),
			])
			const chainId = mailboxKeyId(String(info?.routePgpKeyID || ''))
			const armor = (info?.routePublicKeyArmored ? fromBase64(info.routePublicKeyArmored) : '').replace(/\r/g, '').trim()
			return chainId ? { chainId, armor } : 'unregistered'
		} catch (ex) {
			// RPC error text only (no wallet, no key): tells a timeout from a refused call.
			const why = String((ex as Error)?.message || ex).replace(/0x[0-9a-fA-F]{16,}/g, '0x…').slice(0, 120)
			chatBootLog(`voice route chain read attempt=${attempt + 1} failed ms=${Date.now() - started}: ${why}`, 'warn')
			if (attempt < 2) await new Promise((r) => setTimeout(r, 400 * (attempt + 1)))
		}
	}
	return 'unreachable'
}

/**
 * Own mailbox route key for excluding it from voice relay / entry choices:
 * the live listen's key, else the chain mailbox read before the dial.
 */
export function getOwnMailboxRouteArmor(): string {
	return (getWorkerGossipRouteArmor() || lastChainMailboxRouteArmor || '').replace(/\r/g, '').trim()
}

export async function alignLiveGossipRouteToChain(
	privateKeyArmor: string,
	nodes: nodeInfo[],
): Promise<boolean> {
	const normalizeRouteArmor = (value?: string) => (value || '').replace(/\r/g, '').trim()
	lastMailboxAlignFailure = null
	const live = mailboxKeyId(gossipDeliveryAckContext?.mailboxDomains?.[0] || '')
	const wallet = cachedWallet(privateKeyArmor).address.toLowerCase()
	const workerArmor = normalizeRouteArmor(getWorkerGossipRouteArmor())
	// Mailbox we already know: the last good chain read, else the one the live listen is on.
	const cached = cachedOwnMailbox(wallet)
	const known = cached
		? { chainId: cached.chainId, armor: cached.armor }
		: live && workerArmor ? { chainId: live, armor: workerArmor } : null
	// Verified against the chain during this run (state owned by initChat's route
	// check: getVerifiedOwnMailbox / noteOwnMailboxVerified). A cache from an
	// earlier run is only a fallback: it may name a mailbox we no longer listen on.
	const verifiedRec = getVerifiedOwnMailbox(wallet)
	const verified = verifiedRec && mailboxKeyId(verifiedRec.routeKeyID) && verifiedRec.routeArmor
		? { chainId: mailboxKeyId(verifiedRec.routeKeyID), armor: verifiedRec.routeArmor }
		: null
	const startReading = () => readOwnMailboxFromChain(wallet).then((r) => {
		// A read that finishes after the dial went on still refreshes the cache.
		if (typeof r === 'object' && r.armor) {
			const before = getVerifiedOwnMailbox(wallet)
			if (before && mailboxKeyId(before.routeKeyID) !== r.chainId) {
				chatBootLog(`own mailbox changed on chain ${mailboxKeyId(before.routeKeyID)} -> ${r.chainId}; using the chain from now on`, 'warn')
			}
			rememberOwnMailbox({ wallet, chainId: r.chainId, armor: r.armor, at: Date.now() })
			noteOwnMailboxVerified(wallet, r.chainId, r.armor)
		}
		return r
	})
	// Verified against the chain this run: no wait (the dial's work then finishes
	// before the native call screen covers the page, which slows its JS); the
	// read refreshes in the background. Otherwise, with a known mailbox the dial
	// waits at most 1.5 s for the chain (a slow RPC after a foreground return took
	// 5 s and failed the call); without one it waits.
	let read: Awaited<ReturnType<typeof startReading>> | 'slow'
	if (verified) {
		read = { chainId: verified.chainId, armor: verified.armor }
		// Started after the offer is out, so its RPC work stays off the dial path.
		setTimeout(() => { void startReading().catch(() => undefined) }, 3_000)
		chatBootLog(`voice route mailbox ${verified.chainId} verified this run; chain read in the background`)
	} else {
		const reading = startReading()
		read = known
			? await Promise.race([reading, new Promise<'slow'>((r) => setTimeout(() => r('slow'), 1_500))])
			: await reading
	}
	let chainId = ''
	let chainArmor = ''
	if (typeof read === 'object') {
		chainId = read.chainId
		chainArmor = read.armor
	} else if (known && read !== 'unregistered') {
		chainId = known.chainId
		chainArmor = known.armor
		chatBootLog(`voice route chain read ${read}; using known mailbox ${chainId} (${cached ? 'last read' : 'live listen'})`, 'warn')
	} else {
		chatBootLog(`voice route chain read ${read}; no known mailbox`, 'warn')
	}
	chatBootLog(`voice route live=${live || 'none'} chain=${chainId || 'none'} worker=${workerArmor ? 'set' : 'none'}`)
	if (!chainId) {
		chatBootLog('voice route chain mailbox unavailable', 'warn')
		lastMailboxAlignFailure = read === 'unregistered' ? 'not_registered' : 'chain_unreachable'
		return false
	}
	const mailbox = nodes.find((node) => mailboxKeyId(node.domain || '') === chainId)
	// The chain record carries the mailbox node's route key too: a stale or empty
	// node list must not block the call.
	const targetArmor = normalizeRouteArmor(mailbox?.armoredPublicKey) || chainArmor
	const mailboxDomain = mailbox?.domain || chainId
	if (!targetArmor) {
		chatBootLog(`voice route chain mailbox ${chainId} is not in the node list`, 'warn')
		lastMailboxAlignFailure = 'not_in_node_list'
		return false
	}
	if (!mailbox) chatBootLog(`voice route chain mailbox ${chainId} not in the node list; using its chain route key`, 'warn')
	if (typeof read === 'object' && !chainArmor) {
		rememberOwnMailbox({ wallet, chainId, armor: targetArmor, at: Date.now() })
		noteOwnMailboxVerified(wallet, chainId, targetArmor)
	}
	lastChainMailboxRouteArmor = targetArmor
	if (isCashTreesNativeWebView()) {
		// Inside the shells the dialer listens natively on a per-call relay
		// reached through an entry; the page's own mailbox listen plays no part
		// in the call. It is down for seconds after every foreground return
		// (background pause + restart), which failed dials with "could not use
		// your current Chat mailbox". The chain mailbox is all the call needs:
		// it is excluded from the relay and entry choices.
		chatBootLog(`voice route native shell: chain mailbox ${chainId}, page listen not required`)
		return true
	}
	const workerLive = isWorkerGossipActive()
		&& !!currentGossipAbortController
		&& !currentGossipAbortController.signal.aborted
	if (!workerLive) {
		chatBootLog('voice route gossip worker is down; restarting listen', 'warn')
		const prev = getWorkerGossipListenParams()
		if (!prev) {
			chatBootLog('voice route listen is not running', 'warn')
			lastMailboxAlignFailure = 'listen_down'
			return false
		}
		// the parameters of the listen belong to the account it was started for. After an account change they are not
		// reused; the chat for the current account is started by initChat (App account effect), and the voice route waits for it.
		const pageAccountNow = (accountEoaFor(resolveSigningPrivateKeyArmor(CoNET_Data?.profiles?.[0])) || '').toLowerCase()
		if (!listenParamsFitAccount(prev.eoaAddress, pageAccountNow)) {
			chatBootLog('voice route: the listen belongs to another account; not restarted with its parameters', 'warn')
			lastMailboxAlignFailure = 'listen_down'
			return false
		}
		const controller = new AbortController()
		currentGossipAbortController = controller
		let started = await startWorkerGossipListen({
			...prev,
			nodes: nodes.length ? nodes : prev.nodes,
			ownRouteArmoredPublicKey: targetArmor,
			rootSignal: controller.signal,
		})
		if (!started) {
			started = await startWorkerGossipListen({
				...prev,
				nodes: nodes.length ? nodes : prev.nodes,
				ownRouteArmoredPublicKey: targetArmor,
				rootSignal: controller.signal,
			})
		}
		if (!started || !isWorkerGossipActive()) {
			chatBootLog('voice route gossip restart failed', 'warn')
			lastMailboxAlignFailure = 'listen_down'
			return false
		}
	}
	const liveWorkerArmor = normalizeRouteArmor(getWorkerGossipRouteArmor())
	const workerMatches = liveWorkerArmor === targetArmor
	if (workerMatches && live === chainId) return true
	if (workerMatches && gossipDeliveryAckContext) {
		gossipDeliveryAckContext = {
			...gossipDeliveryAckContext,
			routerArmoredPublicKey: targetArmor,
			mailboxDomains: [mailboxDomain],
		}
		return true
	}
	if (!getWorkerGossipRouteArmor()) {
		chatBootLog('voice route listen is not running', 'warn')
		lastMailboxAlignFailure = 'listen_down'
		return false
	}
	chatBootLog(`voice route retarget ${live || 'none'} -> ${chainId}`)
	const ok = await retargetWorkerGossipRoute(targetArmor, nodes)
	if (!ok) {
		chatBootLog('voice route retarget failed', 'warn')
		lastMailboxAlignFailure = 'listen_down'
		return false
	}
	if (gossipDeliveryAckContext) {
		gossipDeliveryAckContext = {
			...gossipDeliveryAckContext,
			routerArmoredPublicKey: targetArmor,
			mailboxDomains: [mailboxDomain],
		}
	}
	const aligned = normalizeRouteArmor(getWorkerGossipRouteArmor()) === targetArmor
	if (!aligned) {
		chatBootLog('voice route worker still on the previous mailbox', 'warn')
		lastMailboxAlignFailure = 'listen_down'
	}
	return aligned
}

export function getGossipDeliveryAckContext(): {
	routerArmoredPublicKey: string
	privateKeyArmor: string
	entryNodes: nodeInfo[]
	mailboxDomains: Set<string>
} | null {
	if (!gossipDeliveryAckContext) return null
	return {
		routerArmoredPublicKey: gossipDeliveryAckContext.routerArmoredPublicKey,
		privateKeyArmor: gossipDeliveryAckContext.privateKeyArmor,
		entryNodes: gossipDeliveryAckContext.entryNodes,
		mailboxDomains: new Set(gossipDeliveryAckContext.mailboxDomains),
	}
}

const clearGossipListenSession = (reason: string) => {
	if (currentGossipAbortController) {
		try {
			currentGossipAbortController.abort(reason)
		} catch {
			/* ignore */
		}
		currentGossipAbortController = null
	}
	// Aborting the controller already triggers the worker teardown via its rootSignal
	// listener; call stop explicitly too so the singleton is cleared even on races.
	stopWorkerGossip()
}

/**
 * iOS WKWebView freezes long fetch streams in background; timers may not fire until foreground.
 * Resume only when listen is truly dead/aborted, or idle longer than staleMs AFTER we have
 * received bytes. Never tear down a connecting stream (lastGossipActivityAt===0) — that races
 * SI offline flush and drops messages.
 */
export const shouldResumeGossipListen = (staleMs = 45_000): boolean => {
	// A second visible/pageshow event was aborting the worker while it was
	// still opening, so the voice relay found no listen and failed.
	if (isWorkerGossipBusy()) return false
	if (!currentGossipAbortController || currentGossipAbortController.signal.aborted) return true
	// Native shells: the chat module owns the listen and reconnects it by
	// itself. Rebuilding chat here took ~9 s and held the incoming offer and the
	// caller's cancel in the mailbox meanwhile.
	if (isNativeChatListenOwner()) return false
	// The Android module through either channel (window.BeamioChat, or the legacy chatModuleCommand) owns the listen as well.
	if (androidChatModulePresent() && isCashTreesAndroidChatModuleRunning()) return false
	// Connecting / draining offline — do not abort
	if (!lastGossipActivityAt) return false
	return Date.now() - lastGossipActivityAt > staleMs
}

/**
 * Tear down listen so mailbox B gets socket close → removes from online pool.
 * Required on background: otherwise SI still "forwards" to a frozen WKWebView and never saveLocal.
 */
export const prepareGossipListenResume = (reason = 'foreground_resume'): void => {
	chatBootLog(`prepareGossipListenResume: ${reason}`, 'info')
	noteHistoryResumeReason(reason) // a foreground resume is not held back by the history load interval
	clearGossipListenSession(reason)
	lastGossipActivityAt = 0
}

/**
 * Tear down listen so mailbox treats the user offline (saveLocal + APNs).
 * Prefer calling on true unload / pagehide — not on every Home press.
 * While Home leaves the WebView alive, keep listen for UI ingest; system push is
 * SI mailbox → APNs/FCM only (do not also bridge PWA `notifyBackgroundChat`).
 */
export const pauseGossipListenOnBackground = (
	setGossip: (val: boolean) => void,
): void => {
	// True unload: no background retries; the next foreground resume restarts chat.
	clearChatRetry(false)
	chatRetryArgs = null
	// Native shells: pause the module's listen (it stays up while a call rings
	// or is up) instead of destroying it.
	if (pauseNativeChatListen()) {
		chatBootLog('pauseGossipListenOnBackground: native listen paused', 'info')
		return
	}
	if (!currentGossipAbortController || currentGossipAbortController.signal.aborted) {
		setGossip(false)
		return
	}
	chatBootLog('pauseGossipListenOnBackground: abort listen so mailbox treats user offline', 'info')
	prepareGossipListenResume('background_pause')
	setGossip(false)
}

/**
 * Foreground / pageshow resume: if listen looks dead, abort + re-initChat(gossip=false).
 * Safe to call often; no-ops when the stream recently received bytes or is still connecting.
 */
let gossipResumeInFlight = false

export const resumeGossipListenOnForeground = async (
	setProfiles: (val: profile[]) => void,
	setAllNodes: (val: nodeInfo[]) => void,
	setGossip: (val: boolean) => void,
	newMessage: (val: string) => void,
	staleMs = 45_000,
	force = false,
): Promise<void> => {
	if (gossipResumeInFlight) {
		chatBootLog('foreground resume skipped: restart already running', 'info')
		return
	}
	// Native shells: resume the module's listen; never tear it down and rebuild
	// (a call or other senders' messages may be arriving on it).
	if (resumeNativeChatListen()) {
		chatBootLog(`foreground resume: native listen resumed${force ? ' (wake)' : ''}`, 'info')
		return
	}
	if (!force && !shouldResumeGossipListen(staleMs)) {
		chatBootLog('foreground resume skipped: gossip stream still active or connecting', 'info')
		return
	}
	gossipResumeInFlight = true
	try {
		chatBootLog(
			force
				? 'foreground resume forced by native mailbox wake'
				: 'foreground resume restarting stale gossip stream',
			'info',
		)
		prepareGossipListenResume(force ? 'native_mailbox_wake' : 'foreground_resume')
		setGossip(false)
		await initChat(setProfiles, setAllNodes, setGossip, false, newMessage)
	} finally {
		gossipResumeInFlight = false
	}
}

/**
 * The page's account signer for the chat worker (browser only). The worker asks for each signature and gets the signature
 * back; the key stays in this closure (2026-11-13). A shell never signs here: the shell gate refuses first, and this
 * refuses again unless the gate is in `native_chat`.
 */
const pageAccountSigner = (privateKeyArmor: string): AccountSignFn => async (request) => {
	if (shellChatBlockedNow()) throw new Error('shell_chat_blocked')
	const wallet = new ethers.Wallet(privateKeyArmor)
	if (request.kind === 'eip191') return wallet.signMessage(request.message)
	return wallet.signTypedData(request.domain, request.types, request.value)
}

export const connectToGossipNode = async (
	nodeArmoredPublicKey: string,
	privateKeyArmor: string,
	nodes: nodeInfo[],
	pgpPrivateKey: string,
	pgpPublicArmored: string,
	newMessage: (val: string) => void,
	publicEoa?: string,
): Promise<boolean> => {
  // Already listening: do NOT tear down + reconnect (that flaps SI setUserOnlineOnMe).
  // LoadingPage + AppShell both call initChat; second call must be a no-op — BUT only when
  // the controller is truly live. Failed early-returns must clear the controller (see below).
  if (currentGossipAbortController && !currentGossipAbortController.signal.aborted) {
    chatBootLog('connectToGossipNode skipped: gossip SSE already live', 'info')
    return true
  }

  // Stale aborted controller from a prior session — drop and create a fresh one.
  if (currentGossipAbortController) {
    currentGossipAbortController = null
  }

  // 创建新的控制器，代表本次“会话”的生命周期（进程级，勿因 React remount 杀掉）
  const myController = new AbortController();
  currentGossipAbortController = myController;
  const rootSignal = myController.signal;

  const failConnect = (msg: string): false => {
    chatBootLog(msg, 'error')
    if (currentGossipAbortController === myController) {
      clearGossipListenSession('connect_failed')
    }
    return false
  }

  try {
      // Encrypt listen/mining to mailbox **B** (router armored key), but HTTP/SSE only via
      // random healthy **entry C ≠ B** — Tor-like: never reveal client IP to mailbox B.
      //
      // NOTE: the SSE connect/reconnect loop AND all inbound openpgp decryption now run
      // inside the Beamio Chat SDK Web Worker (see services/chatWorkerBridge) so the main
      // thread never blocks — this is the fix for "app frozen ~10s after launch". We still
      // resolve route + healthy entry nodes here so the main-thread delivery-ACK sender
      // (gossipDeliveryAckContext) keeps working exactly as before.
      const routeNodes = pickRouteNodesByArmoredKey(nodes, nodeArmoredPublicKey)
      if (!routeNodes.length) {
        return failConnect('connectToGossipNode abort: no route node for router key')
      }
      const mailboxDomains = new Set(routeNodes.map(n => n.domain))

      const entryCandidates = nodes.filter(n => !mailboxDomains.has(n.domain))
      const healthyNodes = await pickHealthyGossipNodes(
        entryCandidates.length ? entryCandidates : nodes,
      )
      chatBootLog(
        `Gossip healthy entry C: ${healthyNodes.length} (mailbox B domains excluded: ${[...mailboxDomains].join(',') || 'none'})`,
      )
      let entryNodes = healthyNodes
      if (!entryNodes.length && entryCandidates.length) {
        // A launch-time probe can miss every sampled node on a slow network.
        // Aborting here left chat and voice calls down until the next
        // foreground resume ("could not use your current Chat mailbox").
        // The listen rotates and scores its entries itself, so start it on the
        // unprobed nodes; mailbox B stays excluded (same as gossip send).
        chatBootLog('Gossip healthy entry C: probe found none; using unprobed entries (mailbox B excluded)', 'warn')
        entryNodes = entryCandidates
      }
      if (!entryNodes.length) {
        return failConnect('connectToGossipNode abort: no healthy entry C for gossip listen')
      }

      gossipDeliveryAckContext = {
        routerArmoredPublicKey: nodeArmoredPublicKey,
        privateKeyArmor: privateKeyArmor,
        entryNodes,
        mailboxDomains: [...mailboxDomains],
      }

      console.log("🚀 [Gossip] Starting worker listen…");
      chatBootLog(`Gossip listen route=${[...mailboxDomains].join(',') || 'none'}`)
      chatBootLog('Gossip SSE connect starting (worker)…')

      // Hand the inbound LISTEN loop to the worker. Param naming here is historical:
      //   eoaAddress + signAccount → the host signer (the key stays on the page; the worker asks per signature)
      //   pgpPrivateKey    → armored PGP private key (decrypts inbound in the worker)
      // The worker owns entry rotation + reconnect + decryption; decrypted host-ready
      // lines flow back through `newMessage` (App.tsx addNewMessage serial queue) unchanged,
      // with `_beamioPgpArmorHash` already attached for mailbox delivery ACK.
      const started = await startWorkerGossipListen({
        ownRouteArmoredPublicKey: nodeArmoredPublicKey,
        eoaAddress: publicEoa || new ethers.Wallet(privateKeyArmor).address,
        signAccount: pageAccountSigner(privateKeyArmor),
        ...(process.env.REACT_APP_SHELL_BUILD === 'true' ? {} : { pgpPrivateKeyArmored: pgpPrivateKey }),
        pgpPublicKeyArmored: pgpPublicArmored,
        nodes,
        rootSignal,
		onLine: (line) => {
          // A wake bounce may abort this signal while the offer is already decrypted.
          // Deliver the line first; dropping it leaves CallStyle on the generic title.
          newMessage(line)
        },
        onActivity: () => {
          if (rootSignal.aborted) return
          noteGossipActivity()
        },
        onLog: (level, message) => chatBootLog(message, level),
      })

      if (!started) {
        return failConnect('connectToGossipNode abort: worker gossip listen failed to start')
      }
      return true

  } catch (ex: any) {
      console.error("Init Error:", ex);
      return failConnect(`connectToGossipNode Init Error: ${(ex as Error)?.message ?? String(ex)}`)
  }
}

async function withChatTimeout<T>(work: Promise<T>, timeoutMs: number, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		return await Promise.race([
			work,
			new Promise<T>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
			}),
		])
	} finally {
		if (timer) clearTimeout(timer)
	}
}

async function postWithTimeout(url: string, init: RequestInit, timeoutMs = 12_000) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)

  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal })
    return res
  } finally {
    clearTimeout(t)
  }
}

const gossipHealthyCache = new Map<string, number>()
const GOSSIP_HEALTH_TTL_MS = 120_000

const markGossipNodeHealthy = (domain: string) => {
	gossipHealthyCache.set(domain, Date.now() + GOSSIP_HEALTH_TTL_MS)
}

const markGossipNodeBad = (domain: string) => {
	gossipHealthyCache.delete(domain)
}

const isGossipNodeHealthy = (domain: string) => {
	const exp = gossipHealthyCache.get(domain) || 0
	return exp > Date.now()
}

const normalizeArmoredKey = (v?: string) => (v || '').replace(/\r/g, '').trim()

/**
 * Recipient user PGP → that recipient's mailbox route PGP. `sendMessage` only
 * receives the user key, and must keep the recipient's mailbox out of the entry
 * pool (entry A ≠ mailbox B), otherwise B would see the sender's IP.
 */
const recipientRouteByUserKey = new Map<string, string>()

export const rememberRecipientRoute = (userArmored?: string, routeArmored?: string) => {
	const user = normalizeArmoredKey(userArmored)
	const route = normalizeArmoredKey(routeArmored)
	if (user && route) recipientRouteByUserKey.set(user, route)
}

const pickRouteNodesByArmoredKey = (nodes: nodeInfo[], routerArmoredPublicKey: string) => {
	const target = normalizeArmoredKey(routerArmoredPublicKey)
	if (!target) return []
	return nodes.filter(n => normalizeArmoredKey(n.armoredPublicKey) === target)
}

const probeGossipNode = async (node: nodeInfo, timeoutMs = 4_000) => {
	// GET / only. Do not OPTIONS /post here: cold init samples ~10 random entries in
	// parallel (main + worker), and SI used to 404 incomplete first TLS records.
	// Chrome logs every OPTIONS 404 in red even when ACAO=* and we then fall through.
	// Real listen POST already sends the browser CORS preflight; that is the CORS proof.
	const url = `https://${node.domain}.conet.network/`
	try {
		const res = await postWithTimeout(
			url,
			{
				method: 'GET',
				headers: { Accept: 'text/html' },
			},
			timeoutMs,
		)
		if (res.status >= 200 && res.status < 400) {
			markGossipNodeHealthy(node.domain)
			return true
		}
	} catch {
		// Network/TLS timeout means the browser cannot reach this node.
	}
	markGossipNodeBad(node.domain)
	return false
}

const pickHealthyGossipNodes = async (nodes: nodeInfo[]): Promise<nodeInfo[]> => {
	if (!nodes.length) return []

	const cached = nodes.filter(n => isGossipNodeHealthy(n.domain))
	if (cached.length >= 2) return cached

	const sample = getRandomNodes(nodes, Math.min(10, nodes.length))
	const checks = await Promise.all(sample.map(async node => ({ node, ok: await probeGossipNode(node) })))
	const healthy = checks.filter(n => n.ok).map(n => n.node)

	return healthy
}

/** Pick up to `n` entry nodes for gossip send (healthy preferred). */
export const pickGossipEntryNodesForSend = async (
	pool: nodeInfo[],
	n = 4,
	excludeDomains?: Set<string>,
): Promise<nodeInfo[]> => {
	const filtered = excludeDomains?.size
		? pool.filter(node => !excludeDomains.has(node.domain))
		: pool
	if (!filtered.length) return []
	const healthy = await pickHealthyGossipNodes(filtered)
	const source = healthy.length >= 2 ? healthy : filtered
	return getRandomNodes(source, Math.min(n, source.length))
}


/** Minimal peer profile when tag search has no hit (still show inbound chat). */
export const emptySearchResultForAddress = (address: string): searchResult => ({
	address,
	created_at: 0,
	first_name: '',
	last_name: '',
	image: '',
	username: '',
	follow_count: '0',
	follower_count: '0',
})

export type CreateInboundChatSessionOpts = {
	/**
	 * Skip AddressPGP RPC + AES decrypt. Use for history restore / bulk catch-up so the
	 * main thread is not blocked for seconds after launch; keys fill in when the user
	 * opens the chat (or a later route refresh).
	 */
	skipKeyFetch?: boolean
}

/**
 * Open inbound chat for a verified sender EOA.
 * Do not refuse solely because profile search or on-chain PGP is missing.
 */
export const createInboundChatSession = async (
	signAddr: string,
	privateKeyArmor: string,
	peerProfile: searchResult | null | undefined,
	opts?: CreateInboundChatSessionOpts,
): Promise<chatData> => {
	const addr = ethers.isAddress(signAddr) ? ethers.getAddress(signAddr) : signAddr
	const beamio = peerProfile?.address ? peerProfile : emptySearchResultForAddress(addr)
	if (!peerProfile?.address) {
		console.warn(
			`[chat inbound] no Beamio profile for ${addr} — creating address-only session (message still shown)`,
		)
	}
	if (opts?.skipKeyFetch) {
		return {
			address: addr,
			beamio,
			messages: [],
			pin: false,
			hide: false,
			chatData: {
				publicArmored: '',
				routersArmoreds: '',
				online: false,
				routePgpKeyID: '',
			},
			unreadCount: 0,
			tag: 'grey',
			muted: false,
		}
	}
	let kk: Awaited<ReturnType<typeof getKeysFromCoNETPGPSC>> = null
	try {
		kk = await getKeysFromCoNETPGPSC(addr)
	} catch (ex) {
		// network_error: the chat opens without the key; each send re-reads the route and holds until it can be read.
		if (!isRecipientReadError(ex)) throw ex
		console.warn(`[chat inbound] sender ${addr} record read failed (network_error)`)
	}
	if (!kk?.publicArmored) {
		console.warn(
			`[chat inbound] sender ${addr} has no on-chain PGP publicArmored — can display inbound, reply may fail until they register Chat`,
		)
	}
	return {
		address: addr,
		beamio,
		messages: [],
		pin: false,
		hide: false,
		chatData: {
			publicArmored: kk?.publicArmored ?? '',
			routersArmoreds: kk?.routersArmoreds ?? '',
			online: !!kk?.online,
			routePgpKeyID: kk?.routePgpKeyID ?? '',
		},
		unreadCount: 0,
		tag: 'grey',
		muted: false,
	}
}

export const sendMessage = async (
	pgpPublic: string,
	text: string,
	privateKeyArmor: string,
	entryNodes: nodeInfo[],
	opts?: { beamioNoPush?: boolean; mailboxRoutePublicKey?: string; recipientRouteArmored?: string },
): Promise<boolean> => {
	if (!entryNodes?.length) {
		console.error('[sendMessage] no entry nodes')
		return false
	}
	// Entry A must not be the recipient's mailbox B (B would see the sender IP).
	const recipientRoute = normalizeArmoredKey(opts?.recipientRouteArmored || opts?.mailboxRoutePublicKey)
		|| recipientRouteByUserKey.get(normalizeArmoredKey(pgpPublic)) || ''
	const recipientMailboxes = recipientRoute ? pickRouteNodesByArmoredKey(entryNodes, recipientRoute) : []
	if (!recipientRoute) {
		// Without the recipient's mailbox route the message cannot be wrapped to
		// it, and an unwrapped message shows the recipient key ID to the entry.
		console.error('[sendMessage] recipient mailbox unknown; not sent')
		return false
	}
	const recipientMailboxDomains = new Set(recipientMailboxes.map((n) => n.domain))
	// Rule 19: nor our own mailbox (known once the listen is up; native shells add it themselves).
	const ownMailboxDomains = new Set(gossipDeliveryAckContext?.mailboxDomains ?? [])
	const entryPool = entryNodes.filter((n) => !recipientMailboxDomains.has(n.domain) && !ownMailboxDomains.has(n.domain))
	if (!pgpPublic?.trim()) {
		console.error('[sendMessage] missing recipient publicArmored')
		return false
	}

	// Native shell: only the native daemon sends (signs, encrypts, wraps to the
	// mailbox, posts one entry at a time). It waits up to 10 s for the daemon.
	if (isCashTreesNativeWebView()) {
		return sendChatViaNativeDaemon(
			{ address: '', userPublicKeyArmored: pgpPublic, routerArmoredPublicKey: recipientRoute },
			text,
			opts?.beamioNoPush ? { beamioNoPush: true } : undefined,
		)
	}

	const from = accountEoaFor(privateKeyArmor)
	const signMessage = await signAccountMessageFor({ kind: 'envelope', message: text, privateKeyArmor })
	const message = {
		timestamp: Date.now(),
		text,
		from,
		signMessage
	}

	let encryptObj: any
	try {
		encryptObj = {
			message: await withChatTimeout(createMessage({
				text: Buffer.from(JSON.stringify(message)).toString("base64")
			}), 15_000, 'Chat message preparation'),
			encryptionKeys: await withChatTimeout(readKey({ armoredKey: pgpPublic }), 15_000, 'Chat recipient-key parsing'),
			config: { preferredCompressionAlgorithm: enums.compression.zlib }
		}
	} catch (ex: any) {
		console.error(`[sendMessage] createMessage/readKey Error! ${ex?.message || ex}`)
		return false
	}

	let postData: string
	try {
		postData = await withChatTimeout(encrypt(encryptObj), 20_000, 'Chat message encryption')
	} catch (ex: any) {
		console.error(`[sendMessage] encrypt Error! ${ex?.message || ex}`)
		return false
	}

	// Always wrap to the recipient's mailbox B: the entry sees only B's route
	// key ID, never the recipient's key ID (B unwraps and stores).
	try {
		postData = await wrapArmorToMailboxWork(postData, recipientRoute, opts?.beamioNoPush ? { NoPush: true } : undefined)
	} catch (ex: any) {
		console.error(`[sendMessage] mailbox wrap Error! ${ex?.message || ex}`)
		return false
	}

	if (!entryPool.length) {
		console.error('[sendMessage] no entry outside the mailboxes')
		return false
	}
	const body = JSON.stringify({ data: postData })
	const tried = new Set<string>()
	const started = Date.now()
	// One entry at a time; the next only after a clear failure (network error or
	// reset, non-2xx, `{ ok: false }`, or no answer in 8 s). A timed-out POST may
	// have arrived: the mailbox keeps one copy and the recipient dedupes by sendId.
	for (let attempt = 0; attempt < SEND_MAX_ENTRIES && Date.now() - started < SEND_TOTAL_BUDGET_MS; attempt++) {
		const [node] = await pickGossipEntryNodesForSend(entryPool, 1, tried)
		if (!node) break
		tried.add(node.domain)
		const url = `https://${node.domain}.conet.network/post`
		try {
			const res = await postWithTimeout(url, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body,
				// Avoid Chrome Network panel noise; does not fix node/SI failures.
				referrerPolicy: 'no-referrer',
			}, SEND_ATTEMPT_TIMEOUT_MS)
			if (!res.ok) {
				console.warn(`[sendMessage] ${url} → HTTP ${res.status}`)
				markGossipNodeBad(node.domain)
				continue
			}
			const answer = await res.text().catch(() => '')
			if (/"ok"\s*:\s*false/.test(answer)) {
				console.warn(`[sendMessage] ${url} → ok:false`)
				continue
			}
			markGossipNodeHealthy(node.domain)
			return true
		} catch (ex: any) {
			// Chrome often labels bare network / missing-ACAO failures as CORS
			// ("strict-origin-when-cross-origin"). Prefer explicit fetch error text.
			console.warn(`[sendMessage] ${url} → ${ex?.name || 'error'}: ${ex?.message || ex}`)
			markGossipNodeBad(node.domain)
		}
	}

	console.error('[sendMessage] all entry POSTs failed', [...tried])
	return false
}

const SEND_ATTEMPT_TIMEOUT_MS = 8_000
const SEND_MAX_ENTRIES = 4
const SEND_TOTAL_BUDGET_MS = 25_000


/**
 * EIP-191 signer of a chat envelope, lowercase, or null when the signature is
 * malformed. The recovered signer is the only trusted sender; the envelope's
 * `from` is a claim (see App `addNewMessage`).
 */
export const recoverChatSigner = (message: string, signMess: string): string | null => {
	if (!message || !signMess) return null
	try {
		const recovered = ethers.verifyMessage(message, signMess)
		return recovered ? recovered.toLowerCase() : null
	} catch {
		return null
	}
}

export const checkSign = (message: string, signMess: string, signWallet: string) => {
	if (!message || !signMess) {
		
		return null
	}
	
	let recoverPublicKey
	try {
		recoverPublicKey = ethers.verifyMessage(message, signMess)

	} catch (ex) {
		return null
	}

	if (!recoverPublicKey || recoverPublicKey.toLowerCase() !== signWallet.toLowerCase()) {
		
		return null
	}
	
	return signWallet.toLowerCase()
	
}


/** Prefer sendId so two messages in the same ms (e.g. gift note + merchantGift card) never collapse. */
const stableChatMessageId = (m: ChatMessage | null | undefined, fallbackTs?: number): string => {
	if (m?.id?.startsWith('tmp_')) return String(m.id)
	const sendId = typeof m?.sendId === 'string' ? m.sendId.trim() : ''
	if (sendId) return sendId
	if (typeof m?.id === 'string' && m.id.trim()) return m.id.trim()
	const created = Number(m?.createdAt)
	if (Number.isFinite(created)) return String(created)
	if (Number.isFinite(Number(fallbackTs))) return String(fallbackTs)
	return `msg_${Math.random().toString(16).slice(2)}`
}

export const makeMessage = (
	data: ChatMessage[],
	newChatText: string,
	timestamp: number,
	from: "me" | "them",
	status?: "sending" | "sent" | "delivered" | "failed" | "route_unconfirmed" | "fingerprint_changed" | "first_fetch_pending",
	/** Inbound only: the claimed wallet when it differs from the recovered signer. */
	meta?: { claimedFrom?: string },
) => {
	// 1) Normalize existing rows — never rewrite sendId-backed ids to createdAt alone
	//    (that dropped merchantGift when a note shared the same millisecond).
	const normalized = (data || []).map((m) => {
		if (m?.id?.startsWith('tmp_')) return m
		const id = stableChatMessageId(m)
		return { ...m, id }
	})

	const seen = new Set<string>()
	const result: ChatMessage[] = []

	for (const m of normalized) {
		if (!m) continue
		const key = stableChatMessageId(m)
		if (!key || seen.has(key)) continue
		seen.add(key)
		result.push({ ...m, id: key })
	}

	// 2) Merge the inbound payload (JSON card / sendId text / plain text)
	const resultLenBefore = result.length
	const ts = Number(timestamp)
	const text = (newChatText || '').trim()
	try {
		const card: ChatMessage = JSON.parse(text)
		const dedupKey = stableChatMessageId(card, ts)
		if (seen.has(dedupKey)) {
			// duplicate push — keep existing
		} else if (card.paymentCard) {
			card.from = 'them'
			card.id = dedupKey
			if (card.createdAt == null) card.createdAt = ts
			seen.add(dedupKey)
			result.push(card)
		} else if (card.reply) {
			card.from = 'them'
			card.id = dedupKey
			if (card.createdAt == null) card.createdAt = ts
			seen.add(dedupKey)
			result.push(card)
		} else if (card.sendId != null) {
			card.from = 'them'
			card.id = dedupKey
			if (card.createdAt == null) card.createdAt = ts
			seen.add(dedupKey)
			result.push(card)
		} else throw new Error('')
	} catch {
		if (text && Number.isFinite(ts)) {
			const incomingId = String(ts)
			if (!seen.has(incomingId)) {
				seen.add(incomingId)
				result.push({
					id: incomingId,
					from,
					text,
					createdAt: ts,
					status: status ?? (from === 'me' ? 'sent' : 'sent'),
				})
			}
		}
	}

	// Flag only the row this call added (never an older message).
	if (meta?.claimedFrom && result.length > resultLenBefore) {
		const added = result[result.length - 1]
		if (added && added.from === 'them') added.claimedFrom = meta.claimedFrom
	}
	result.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
	return result
}

export function emitReactionAsNewMessage (amount: number, currency: ICurrency, title: string,usdcAmount: number, cashcodeUrl: string ) {	//(targetMessageId: string, reaction: ReactionKey) {
	// const reactionLabel = REACTIONS.find(r => r.key === reaction)?.label || "👍"
	const now = Date.now()
	const tempId = new Date().getTime()

	// ✅ 你可以换成只发 emoji：text: reactionLabel
	// const text = reactionLabel
	const card: paymentCard = {
		amount: amount,
		currency,
		title,
		usdcAmount,
		timeStamp: new Date().getTime(),
		cashcodeUrl
	}
	const mess: ChatMessage = 
		{
			id: tempId.toString(),
			from: 'me',
			text:'',
			createdAt: now,
			status: "sent",
			paymentCard: card
		}
	return mess
}

/** 创建 Payment Request 卡片消息（共通的 payMe 数据 + 展示用 requestUrl/walletLabel/memo）。fiat 请求不传 usdcAmount，接收方点 Pay 时再按当时汇率换算。 */
export function createPaymentRequestCard(opts: {
	amount: number
	currency: ICurrency
	title: string
	/** 仅 USDC 请求传入；fiat 请求不传，接收方点 Pay 时按当时汇率换算 */
	usdcAmount?: number
	requestUrl: string
	walletLabel?: string
	memo?: string
}): ChatMessage {
	const now = Date.now()
	const sendId = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `pr_${now}_${Math.random().toString(36).slice(2)}`
	const card: paymentCard = {
		amount: opts.amount,
		currency: opts.currency,
		title: opts.title,
		usdcAmount: opts.usdcAmount ?? 0,
		timeStamp: now,
		cashcodeUrl: opts.requestUrl,
		cardType: 'paymentRequest',
		requestUrl: opts.requestUrl,
		walletLabel: opts.walletLabel ?? 'Main Wallet • EOA',
		memo: opts.memo ?? opts.title,
	}
	return {
		sendId,
		from: 'me',
		text: '',
		createdAt: now,
		status: 'sent',
		paymentCard: card,
	}
}

/**
 * Merchant gift redeem card for Chat (Direct transfer to @BeamioTag).
 * Tap opens the same gift claim sheet as `/app/?beamiocard=&redeemcode=`.
 */
export function createMerchantGiftRedeemCard(params: {
	amount: number
	currency: ICurrency
	merchantTitle: string
	claimUrl: string
	/** Optional short note shown under the card chrome */
	memo?: string
	/** Tier background selected by the purchaser */
	imageUrl?: string
	usdcAmount?: number
}): ChatMessage {
	const now = Date.now()
	const sendId =
		typeof crypto !== 'undefined' && crypto.randomUUID
			? crypto.randomUUID()
			: `gift_${now}_${Math.random().toString(36).slice(2)}`
	const title = (params.merchantTitle || 'Merchant gift').trim() || 'Merchant gift'
	const card: paymentCard = {
		amount: params.amount,
		currency: params.currency,
		title,
		timeStamp: now,
		usdcAmount: params.usdcAmount ?? params.amount,
		cashcodeUrl: params.claimUrl,
		cardType: 'merchantGift',
		requestUrl: params.claimUrl,
		statusLabel: 'Gift voucher',
		memo: params.memo?.trim() || undefined,
		imageUrl: params.imageUrl?.trim() || undefined,
	}
	return {
		sendId,
		id: sendId,
		from: 'me',
		text: '',
		createdAt: now,
		status: 'sent',
		paymentCard: card,
	}
}

/**
 * 创建用于 Chat 的 Membership Activated 卡片消息。
 * 对应 MessageSendReceiveCard 的 variant="membershipActivated"。
 */
export function createMembershipActivatedCard(params: {
	amount: number
	currency: ICurrency
	title?: string
	usdcAmount?: number
	statusLabel?: string
	/** 辅助字段：交易 hash（如链上 tx hash），可用于 View Invoice 等 */
	hash?: string
}): ChatMessage {
	const now = Date.now()
	const tempId = now
	const card: paymentCard = {
		amount: params.amount,
		currency: params.currency,
		title: params.title ?? "Membership Activated",
		timeStamp: now,
		usdcAmount: params.usdcAmount ?? params.amount,
		cashcodeUrl: "",
		cardType: "membershipActivated",
		statusLabel: params.statusLabel ?? "Confirmed on-chain",
		hash: params.hash,
	}
	return {
		id: tempId.toString(),
		from: "me",
		text: "",
		createdAt: now,
		status: "sent",
		paymentCard: card,
	}
}

/** 按 address 去重：规范化小写，每个 address 只保留一项（保留首次出现的） */
export function dedupeChatsByAddress(chats: chatData[]): chatData[] {
	const seen = new Set<string>()
	return chats.filter(chat => {
		const key = (chat.address ?? '').trim().toLowerCase()
		if (!key) return false
		if (seen.has(key)) return false
		seen.add(key)
		return true
	})
}

/** 刷新每个 chat 的链上路由信息（routersArmoreds, routePgpKeyID）。不改 online（见 refreshChatMailboxPresence）。 */
export const refreshChatRoutes = async (profile: profile): Promise<profile> => {
	if (!profile?.chats?.length || !profile.privateKeyArmor) return profile
	const chats = [...profile.chats]
	let changed = false
	for (let i = 0; i < chats.length; i++) {
		const c = chats[i]
		const addr = (c.address ?? '').trim()
		if (!addr || !ethers.isAddress(addr)) continue
		try {
			const kk = await getKeysFromCoNETPGPSC(addr)
			if (!kk) continue
			const cd = c.chatData
			const nextRouters = kk.routersArmoreds || cd?.routersArmoreds || ''
			const nextRouteKeyID = kk.routePgpKeyID || cd?.routePgpKeyID || ''
			const nextPublic = kk.publicArmored || cd?.publicArmored || ''
			if (
				nextRouters !== (cd?.routersArmoreds ?? '') ||
				nextRouteKeyID !== (cd?.routePgpKeyID ?? '') ||
				nextPublic !== (cd?.publicArmored ?? '')
			) {
				chats[i] = {
					...c,
					chatData: {
						publicArmored: nextPublic,
						routersArmoreds: nextRouters,
						routePgpKeyID: nextRouteKeyID,
						// Preserve last mailbox-probe result; never import chain routeOnline.
						online: cd?.online ?? false,
						nativeWakeable: cd?.nativeWakeable,
					}
				}
				changed = true
			}
		} catch (_) { /* 单条失败不影响其他 */ }
	}
	if (changed) {
		profile.chats = dedupeChatsByAddress(chats)
	}
	return profile
}

/**
 * Ask each contact's mailbox whether that wallet has an active listen SSE.
 * Encrypt to mailbox B route PGP; HTTP via entry C ≠ B. Trusted ok:true only updates online.
 * Inside the native shell the shell picks `http://{ip}/post`. Domain HTTPS is the browser path,
 * and the fallback when the shell has no IP roster yet.
 */
async function postQueryViaNativeShell(
	armored: string,
	entryNodes: nodeInfo[],
	mailboxDomains: Set<string>,
): Promise<unknown | 'fallback'> {
	if (!isCashTreesNativeWebView()) return 'fallback'
	const excludeIps = entryNodes
		.filter((n) => n?.ip_addr && mailboxDomains.has(n.domain))
		.map((n) => String(n.ip_addr).trim())
		.filter(Boolean)
	const shell = await postNativePgpCiphertext(armored, excludeIps)
	if (shell.error === 'no_si_roster' || shell.error === 'bridge_missing') return 'fallback'
	const trimmed = (shell.body || '').trim()
	if (!shell.ok || !trimmed) return null
	try {
		return JSON.parse(trimmed)
	} catch {
		const m = trimmed.match(/\{[\s\S]*\}/)
		if (!m) return null
		try {
			return JSON.parse(m[0])
		} catch {
			return null
		}
	}
}

/**
 * the message and its signature for one probe. In a shell the native layer builds and signs it (`mailboxProbeSign`,
 * used only when the module declares mailbox.probe.sign.v1); a shell never falls back to a page signature. A browser page signs with its
 * own key, as before. Null when the probe cannot be made.
 */
const probeSignedMessage = (
	command: MailboxProbeCommand,
	targetWallet: string,
	privateKeyArmor: string,
): Promise<{ message: string; signMessage: string } | null> =>
	signMailboxProbe(command, targetWallet, privateKeyArmor, {
		isShell: () => isShellContext(),
		nativeProbeSign: (args) => nativeMailboxProbeSign(args),
		accountEoaFor: (armor) => accountEoaFor(armor),
		pageSign: (message, armor) => signAccountMessageFor({ kind: 'selfAuth', message, privateKeyArmor: armor }),
		checksumAddress: (address) => ethers.getAddress(address),
		nowSeconds: () => Math.floor(Date.now() / 1000),
	})

export const queryMailboxWalletOnline = async (opts: {
	targetWallet: string
	routerArmoredPublicKey: string
	privateKeyArmor: string
	entryNodes: nodeInfo[]
	mailboxDomains: Set<string>
}): Promise<{ online: boolean; ok: boolean } | null> => {
	const { targetWallet, routerArmoredPublicKey, privateKeyArmor, entryNodes, mailboxDomains } = opts
	if (!ethers.isAddress(targetWallet) || !routerArmoredPublicKey?.trim()) return null
	if (!probeHasSigner(isShellContext(), privateKeyArmor)) return null
	if (!entryNodes?.length) return null
	try {
		const signed = await probeSignedMessage('wallet_online_query', targetWallet, privateKeyArmor)
		if (!signed) return null
		const { message, signMessage } = signed
		const encryptionKeys = await readKey({ armoredKey: routerArmoredPublicKey })
		const pgpMsg = await createMessage({
			text: Buffer.from(JSON.stringify({ message, signMessage })).toString('base64'),
		})
		const postData = await encrypt({
			message: pgpMsg,
			encryptionKeys,
			config: { preferredCompressionAlgorithm: enums.compression.zlib },
		})
		const armored = typeof postData === 'string' ? postData : String((postData as any)?.data ?? postData)
		const viaShell = await postQueryViaNativeShell(armored, entryNodes, mailboxDomains)
		if (viaShell !== 'fallback') {
			if (viaShell && typeof viaShell === 'object' && (viaShell as { ok?: boolean }).ok === true) {
				return { ok: true, online: !!(viaShell as { online?: boolean }).online }
			}
			return null
		}
		// Entries without a PGP key are skipped. Each target gets its own outer wrap; a
		// failed wrap skips that target, and nothing is posted unwrapped (2.4).
		const pool = entryNodes.filter(n => n?.domain && hasEntryPgpKey(n) && !mailboxDomains.has(n.domain))
		if (!pool.length) return null
		const entries = await pickGossipEntryNodesForSend(pool, 4, mailboxDomains)
		const targets = entries.length ? entries : getRandomNodes(pool, Math.min(4, pool.length))
		if (!targets.length) return null
		const results = await Promise.all(
			targets.map(async node => {
				const url = `https://${node.domain}.conet.network/post`
				try {
					const wrapped = await wrapArmorToEntryRoute(armored, node.armoredPublicKey)
					const res = await postWithTimeout(
						url,
						{
							method: 'POST',
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify({ data: wrapped }),
							referrerPolicy: 'no-referrer',
						},
						10_000,
					)
					const text = await res.text()
					const trimmed = (text || '').trim()
					if (!trimmed) return null
					try {
						return JSON.parse(trimmed)
					} catch {
						const m = trimmed.match(/\{[\s\S]*\}/)
						if (m) {
							try {
								return JSON.parse(m[0])
							} catch {
								return null
							}
						}
						return null
					}
				} catch {
					return null
				}
			}),
		)
		for (const r of results) {
			if (r && typeof r === 'object' && (r as { ok?: boolean }).ok === true) {
				return { ok: true, online: !!(r as { online?: boolean }).online }
			}
		}
		return null
	} catch (e: any) {
		console.warn('[queryMailboxWalletOnline]', e?.message ?? e)
		return null
	}
}

/**
 * Ask the contact mailbox whether that wallet has a registered native shell
 * (iOS, Android, Windows, Linux, or macOS) that push can wake.
 * Encrypt to mailbox B route PGP; HTTP via entry C ≠ B.
 * Trusted only when ok === true. Failure returns null and must not clear the last value.
 * Call this after wallet_online_query.
 */
export const queryMailboxNativeWakeable = async (opts: {
	targetWallet: string
	routerArmoredPublicKey: string
	privateKeyArmor: string
	entryNodes: nodeInfo[]
	mailboxDomains: Set<string>
}): Promise<{ nativeWakeable: boolean; ok: boolean } | null> => {
	const { targetWallet, routerArmoredPublicKey, privateKeyArmor, entryNodes, mailboxDomains } = opts
	if (!ethers.isAddress(targetWallet) || !routerArmoredPublicKey?.trim()) return null
	if (!probeHasSigner(isShellContext(), privateKeyArmor)) return null
	if (!entryNodes?.length) return null
	try {
		const signed = await probeSignedMessage('wallet_native_wake_query', targetWallet, privateKeyArmor)
		if (!signed) return null
		const { message, signMessage } = signed
		const encryptionKeys = await readKey({ armoredKey: routerArmoredPublicKey })
		const pgpMsg = await createMessage({
			text: Buffer.from(JSON.stringify({ message, signMessage })).toString('base64'),
		})
		const postData = await encrypt({
			message: pgpMsg,
			encryptionKeys,
			config: { preferredCompressionAlgorithm: enums.compression.zlib },
		})
		const armored = typeof postData === 'string' ? postData : String((postData as any)?.data ?? postData)
		const viaShell = await postQueryViaNativeShell(armored, entryNodes, mailboxDomains)
		if (viaShell !== 'fallback') {
			if (viaShell && typeof viaShell === 'object' && (viaShell as { ok?: boolean }).ok === true) {
				return { ok: true, nativeWakeable: !!(viaShell as { nativeWakeable?: boolean }).nativeWakeable }
			}
			return null
		}
		// Entries without a PGP key are skipped. Each target gets its own outer wrap; a
		// failed wrap skips that target, and nothing is posted unwrapped (2.4).
		const pool = entryNodes.filter(n => n?.domain && hasEntryPgpKey(n) && !mailboxDomains.has(n.domain))
		if (!pool.length) return null
		const entries = await pickGossipEntryNodesForSend(pool, 4, mailboxDomains)
		const targets = entries.length ? entries : getRandomNodes(pool, Math.min(4, pool.length))
		if (!targets.length) return null
		const results = await Promise.all(
			targets.map(async node => {
				const url = `https://${node.domain}.conet.network/post`
				try {
					const wrapped = await wrapArmorToEntryRoute(armored, node.armoredPublicKey)
					const res = await postWithTimeout(
						url,
						{
							method: 'POST',
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify({ data: wrapped }),
							referrerPolicy: 'no-referrer',
						},
						10_000,
					)
					const text = await res.text()
					const trimmed = (text || '').trim()
					if (!trimmed) return null
					try {
						return JSON.parse(trimmed)
					} catch {
						const m = trimmed.match(/\{[\s\S]*\}/)
						if (m) {
							try {
								return JSON.parse(m[0])
							} catch {
								return null
							}
						}
						return null
					}
				} catch {
					return null
				}
			}),
		)
		for (const r of results) {
			if (r && typeof r === 'object' && (r as { ok?: boolean }).ok === true) {
				return { ok: true, nativeWakeable: !!(r as { nativeWakeable?: boolean }).nativeWakeable }
			}
		}
		return null
	} catch (e: any) {
		console.warn('[queryMailboxNativeWakeable]', e?.message ?? e)
		return null
	}
}

export const sendVoiceCallOffer = async (opts: {
	recipientPgp: string
	recipientRoute: string
	signal: {
		callId: string
		sessionId: string
		from: string
		to: string
		expiresAt: number
	}
	privateKey: string
	allNodes: nodeInfo[]
	entryNodes?: nodeInfo[]
}): Promise<boolean> => {
	const sent = await sendMessage(
		opts.recipientPgp,
		JSON.stringify(opts.signal),
		opts.privateKey,
		opts.entryNodes?.length ? opts.entryNodes : opts.allNodes,
	)
	if (!sent) return false
	ensureNativePushBoundForWallet()
	return true
}

/**
 * Probe all chats with a mailbox route. Returns address(lower) → online for trusted replies only.
 */
export const refreshChatMailboxPresence = async (
	chats: chatData[],
	privateKeyArmor: string,
): Promise<Map<string, boolean>> => {
	const out = new Map<string, boolean>()
	if (!chats?.length || !probeHasSigner(isShellContext(), privateKeyArmor)) return out
	const nodes = await getCoNETNodesForChat()
	if (!nodes.length) return out
	await Promise.all(
		chats.map(async chat => {
			const addr = (chat.address || '').trim().toLowerCase()
			const route = chat.chatData?.routersArmoreds?.trim()
			if (!addr || !ethers.isAddress(addr) || !route) return
			const routeNodes = pickRouteNodesByArmoredKey(nodes, route)
			const mailboxDomains = new Set(routeNodes.map(n => n.domain).filter(Boolean))
			const r = await queryMailboxWalletOnline({
				targetWallet: addr,
				routerArmoredPublicKey: route,
				privateKeyArmor,
				entryNodes: nodes,
				mailboxDomains,
			})
			if (r?.ok) out.set(addr, r.online)
		}),
	)
	return out
}

/** Probe one contact after presence. Trusted ok:true only. */
export const refreshPeerNativeWakeable = async (
	targetWallet: string,
	routerArmoredPublicKey: string,
	privateKeyArmor: string,
): Promise<{ ok: true; nativeWakeable: boolean } | null> => {
	const addr = (targetWallet || '').trim()
	const route = (routerArmoredPublicKey || '').trim()
	if (!addr || !ethers.isAddress(addr) || !route || !probeHasSigner(isShellContext(), privateKeyArmor)) return null
	const nodes = await getCoNETNodesForChat()
	if (!nodes.length) return null
	const routeNodes = pickRouteNodesByArmoredKey(nodes, route)
	const mailboxDomains = new Set(routeNodes.map(n => n.domain).filter(Boolean))
	const r = await queryMailboxNativeWakeable({
		targetWallet: addr,
		routerArmoredPublicKey: route,
		privateKeyArmor,
		entryNodes: nodes,
		mailboxDomains,
	})
	if (!r?.ok) return null
	return { ok: true, nativeWakeable: r.nativeWakeable }
}

export const initMessage = async (profile: profile, beamioer: searchResult): Promise<chatData|null> => {
	const address = (beamioer.address ?? '').trim().toLowerCase()
	if (!address) return null

	if (!profile.chats) {
		profile.chats = []
	}
	// 按 address 去重，保留首次出现的项
	profile.chats = dedupeChatsByAddress(profile.chats)

	// 先检查 beamioer（按 address）是否已存在于 profile.chats 中
	const existingIndex = profile.chats.findIndex(n => (n.address ?? '').toLowerCase() === address)
	if (existingIndex >= 0) {
		return profile.chats[existingIndex]
	}

	// 不存在则创建新 chat，放入 profile.chats 并返回
	//a failed read opens the chat without a key (every send re-reads and holds on network_error); no record does not.
	let kk: Awaited<ReturnType<typeof getKeysFromCoNETPGPSC>> = null
	let readFailed = false
	try {
		kk = await getKeysFromCoNETPGPSC(beamioer.address)
	} catch (ex) {
		if (!isRecipientReadError(ex)) throw ex
		readFailed = true
	}
	if (!readFailed && !kk?.publicArmored) {
		return null
	}

	const newChat: chatData = {
		address,
		messages: [],
		chatData: kk ?? { publicArmored: '', routersArmoreds: '', online: false, routePgpKeyID: '' },
		beamio: beamioer,
		pin: false,
		hide: false,
		muted: false,
		tag: 'grey',
		unreadCount: 1,
	}
	profile.chats.push(newChat)
	// 再次去重，避免并发或其它路径导致同 address 出现多次
	profile.chats = dedupeChatsByAddress(profile.chats)
	return newChat
}
