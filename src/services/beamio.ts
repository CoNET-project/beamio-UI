//			beamio.ts

import { pageMnemonicField } from './pageMnemonicField'
import { idbBlobCompatReady } from './idbBlobCompat'
import { CoNET_Data, setCoNET_Data } from '@/utils/globals'
import { publishNativePwaLog } from '@/utils/cashTreesNativePwaLog'
import { abortAfter, BOOT_REQUEST_TIMEOUT_MS } from '@/utils/bootTimeout'
import { profilesForPersist } from './chatLocalPurge'
import { isShellContext } from './shellContext'
import { loadOwnPgpPublicMaterial, shellPgpForServerRequest } from './ownPgpPublic'
import { completePendingServerSync, enqueuePendingServerSync, ensurePendingServerSync, pendingServerSyncGeneration, type FlushOutcome } from './pendingServerSync'
import { diagnosticCode } from './diagnosticCodes'
import { qaLine, qaErrorCode, qaErrorName, qaPersistStage, qaPersistStageNow } from '@/utils/qaLog'
import { isChatBodiesPurgedFor } from './chatLocalPurge'
import { keepStoredChats, keepMemoryChats, withoutPeerArmorForShell, countPeerArmorRows, CHATS_FLOOR_REFUSED } from './chatsFloor'
import { fallbackStartOutcome, nativeRecordFallbackOf, noteShellRecordFallback, OLD_SHELL_UPGRADE_REASON, type ShellRecordFallbackReason } from './shellRecordFallback'
import { buildShellRecordWriteCommand, shellRecordAsWalletRecord, shellRecordRead, shellRecordWrite, prepareShellFreshWrite, validatedCopyAccount } from './shellRecordStore'
import { isUntrustedSourceAnswer, shellStorageErrorReason } from './shellStoreWait'
import { setShellReadHold } from './shellTerminalState'
import { commitStoredRead, type StoredReadEffects } from './walletCopyCommit'
import { assertNoPgpPrivate } from './shellRecordSanitizer'
import { notifyPasscodeStateChanged } from './walletVaultEvents'
import { shellMnemonicSync } from './shellMnemonicSync'
import { sendPwaWalletSyncCipher } from './pwaWalletSyncTransport'
import { nextShellTxSeq } from './shellTxSeq'
import { classifyPageKeyState } from './pageRecordKeyState'
import { handOffSyncPending } from './passcode/syncPendingHandoff'
import { idbKeyValueDb, passcodeAttemptRecordStore } from './passcode/passcodeWrapStore'
import {
  changeWalletPasscode,
  disableWalletPasscode,
  hasPlainSecrets,
  lockWalletSession,
  openWalletForStartup,
  passcodeEnabled,
  readPlainForVerify,
  resetWalletSession,
  setWalletPasscode,
  unlockWalletPasscode,
  wrapForDisk,
  assertStoredSecretsKept,
  type Loose,
  type PlainMigration,
  type SetResult,
  type WalletMeta,
  type WalletStores,
} from './passcode/walletVault'
import { clearChatAccessState } from './passcode/chatAccessGuard'
import { applyBeamioUiLanguageFromProfile } from '@/locale/i18n'
import {
	buildBrowserLocaleCurrencyDefaults,
	buildLocaleCurrencySetupPayload,
	encodeRegistryLastNameWithLocaleSetup,
	normalizeBeamioDisplayCurrency,
	normalizeBeamioUiLocale,
	parseBeamioAddedSetupFromRegistryLastName,
	readBeamioUiLanguageBootstrap,
	writeBeamioUiLanguageBootstrap,
	type BeamioUiLocale,
} from '@/utils/beamioProfileLocaleCurrency'
import {ethers, FetchRequest, keccak256, Network, toUtf8Bytes} from 'ethers' 
import { isAccountNotFoundError } from './accountLookupErrors'
import usdc_abi from './ABI/usdc_abi.json'
import { encodeInitRaw, parseInitRaw } from './initRecordCodec'
import { decideLegacyInit, stripLegacyChatContainers } from './shellLegacyIdbInit'
import { runAuthorizationSign } from './authorizationSign'
import { readWalletEoaAddress } from './walletEoaAddress'
import { NO_KEY_ERROR } from './nativeKeyState'
import { shellRecordReadState } from './pageRecordDecision'
import { injectShellSessionKey } from './shellSessionSigner'
import { clearPersistFailed, setPersistFailed, setPersistRetry } from './persistNoticeStatus'
import { shellChatBlockedNow } from './shellChatCapability'
import { markPendingSync } from './pendingSync'
import {
	customJsonStringify,
	initProfileTokens,
	isValidSolanaBase58PrivateKey,
	postToEndpoint,

} from "../utils/utils"

import {
	apiv4_endpoint,
	conetDepinProvider,
	localDatabaseName,

} from "../utils/constants"

import beamioAccountABI from '@/services/ABI/beamio-AccountRegistry.json'
import { randomBytes } from '@noble/hashes/utils.js'
import contracts from "../utils/contracts"
import { encode as cborEncode, decode as cborDecode } from 'cbor-x'
import { argon2idAsync } from '@/services/argon2WorkerBridge'
import { baseEndpoint, USDCContract_BASE } from '../utils/constants'
import { BASE_MAINNET_FACTORIES, CONET_ACCOUNT_REGISTRY, CONET_BUNIT_AIRDROP_ADDRESS, CONET_MAINNET_CHAIN_ID, CONET_RPC_URL } from '@/config/chainAddresses'
import { eip712ChainIdForBeamioUserCard, getCardFactoryGatewayForEip712 } from '@/utils/beamioUserCardChain'
import { isRpcDegraded, reportRpcFailure, isRpcQuotaOrNetworkError } from '@/utils/rpcStatus'
import { withBaseRpc } from '../utils/baseRpc'
import { tu } from '@/locale/beamioLocale'
import {
	peekBeamioTagBasicMetadataForQuery,
	rememberBeamioTagBasicMetadata,
	type BeamioTagBasicMetadata,
} from '@/utils/beamioTagBasicMetadataGlobalCache'
import { searchBeamioTagRemote } from '@/services/beamioTagWorkerBridge'
import {
	hasCompletedBeamioAccount,
	hasLocalPlaintextMnemonic,
	hasLocalSigningMaterial,
	isKeyOnlyCopyWithoutMnemonic,
	isTrustedEmptyWalletBlob,
	hasUnrecognizedSecret,
} from '@/utils/consumerWalletGate'
import { validMnemonicEoa } from '@/utils/consumerWalletGate'
import { recoverAllowed, recoverSourceOf } from '@/services/accountJudgement'
import { reuseKeepsKey } from '@/services/reuseKeepsKey'
import { isLocallyCreatedAccount, markLocallyCreatedAccount } from '@/services/localAccountCreation'
import { stripPeerChatPrivateArmored } from '@/utils/peerChatPrivateArmored'

export type x402Response = {
	timestamp: string
	network: string
	payer: string
	success: boolean
	USDC_tx?: string
	SETTLE_tx?: string
}

const uuid62 = require('uuid62')
const PouchDB = require("pouchdb").default



const SC= new ethers.Contract(USDCContract_BASE, usdc_abi, baseEndpoint)
export type IBalance= {
	usdc: string
	eth: string
	oracle: {
		bnb: string
		eth: string
		usdc: string
	}
}

/** RPC 失败时从 API 获取余额（30s 缓存由服务端负责） */
const fetchBalanceFromApi = async (address: string): Promise<IBalance | null> => {
	// a stalled balance read is a failed read after the bound (the caller already treats null as "no balance answer").
	const timeout = abortAfter(BOOT_REQUEST_TIMEOUT_MS)
	try {
		const res = await fetch(`${beamioApi}/api/getBalance?address=${encodeURIComponent(address)}`, { signal: timeout.signal })
		if (!res.ok) return null
		const data = await res.json().catch(() => ({}))
		if (data?.eth != null && data?.usdc != null) {
			return {
				eth: String(data.eth),
				usdc: String(data.usdc),
				oracle: data?.oracle ?? { bnb: '', eth: '', usdc: '1' },
			}
		}
		return null
	} catch {
		return null
	} finally {
		timeout.done()
	}
}

/** 从 API 获取指定地址 USDC 余额（RPC 熔断或失败时使用），失败返回 null 表示不可信 */
export const getUsdcBalanceFromApi = async (address: string): Promise<string | null> => {
	const b = await fetchBalanceFromApi(address)
	return b?.usdc != null ? String(b.usdc) : null
}

const getBalance = async (address: string) => {
	if (!address) return null
	// 熔断期跳过 RPC（不向 API 服务器请求）
	try {
		const [usdc, eth, oracle] = await Promise.all([
			withBaseRpc((p) => new ethers.Contract(USDCContract_BASE, usdc_abi as ethers.InterfaceAbi, p).balanceOf(address)),
			withBaseRpc((p) => p.getBalance(address)),
			getOracle(),
		])
		if (oracle) {
			// getBalanceProcess 期望 oracle.eth.usdc（USDC→USD 汇率）
			const oracleForBalance = { ...oracle, eth: { usdc: oracle.usdc ?? '1' } }
			return {
				eth: ethers.formatUnits(eth as bigint, 18).toString(),
				usdc: ethers.formatUnits(usdc as bigint, 6).toString(),
				oracle: oracleForBalance,
			}
		}
	} catch (err) {
		if (isRpcQuotaOrNetworkError(err)) reportRpcFailure()
		// 熔断期不请求 API；非熔断期用 API 兜底
		if (!isRpcDegraded()) return fetchBalanceFromApi(address)
		return null
	}
	return null
}

const duplicate = contracts.Duplicate
const duplicate_readOnly = new ethers.Contract(duplicate.address, duplicate.abi, conetDepinProvider)

const isLocal = false
const remote = 'https://api.settleonbase.xyz'
const local = 'http://localhost:4088'
const beamioApi = 'https://beamio.ca'
const ipfsEndpoint = `https://ipfs.conet.network/api/`

const getFaucetEndpoint = isLocal ? `${local}/api/BeamioFaucet` : `${remote}/api/BeamioFaucet`

/** Base 主网 BeamioOracle 合约，直接读取链上汇率，不再使用 API 服务器 */
const BEAMIO_ORACLE_BASE = '0x77CB8358c5a37aB7190b0A2C7EaA7fEeDCF11008'
const BeamioOracleAbi = ['function getRate(uint8 c) view returns (uint256)'] as const

const storageNewUser = `${beamioApi}/api/addUser`
const followStatusUrl = `${beamioApi}/api/getFollowStatus`
const removeFollowingUrl = `${beamioApi}/api/removeFollow`
const addFollowingUrl = `${beamioApi}/api/addFollow`
const myFollowStatusUrl = `${beamioApi}/api/getMyFollowStatus`
const getFollowersUrl = `${beamioApi}/api/getMyFollowStatus`

/** CoNET 主网 chainId（BUnitAirdrop 部署链） */
const CONET_CHAIN_ID = CONET_MAINNET_CHAIN_ID

/** CoNET BUnitAirdrop 合约地址（与 deployments/conet-addresses.json 一致） */
const CONET_BUNIT_AIRDROP = CONET_BUNIT_AIRDROP_ADDRESS

/** 检查是否可领取 BeamioBUnits（Cluster 读链） */
export const checkBUnitClaimEligibility = async (
	address: string,
): Promise<{ canClaim: boolean; nonce?: string; deadline?: number; reason?: string | null; error?: string }> => {
	// a stalled eligibility read is a failed read after the bound (never an endless wait on the boot claim check).
	const timeout = abortAfter(BOOT_REQUEST_TIMEOUT_MS)
	try {
		const res = await fetch(`${beamioApi}/api/checkBUnitClaimEligibility?address=${encodeURIComponent(address)}`, { signal: timeout.signal })
		const data = await res.json().catch(() => ({}))
		if (!res.ok) return { canClaim: false, error: data?.error ?? res.statusText }
		return {
			canClaim: !!data.canClaim,
			nonce: data.nonce,
			deadline: data.deadline != null ? Number(data.deadline) : undefined,
			reason: data.reason ?? null,
		}
	} catch (e) {
		return { canClaim: false, error: (e as Error)?.message ?? tu('request_failed') }
	} finally {
		timeout.done()
	}
}

/** 使用 EOA 私钥签写 ClaimAirdrop 并提交 claimBUnits 请求（调用方须先 gateBUnitFreeClaimBeforeSubmit） */
export const signAndClaimBUnits = async (
	privateKey: string,
	claimant: string,
	nonce: string | number,
	deadline: number
): Promise<{ success: boolean; txHash?: string; error?: string; code?: string }> => {
	try {
		const wallet = new ethers.Wallet(privateKey)
		if (wallet.address.toLowerCase() !== ethers.getAddress(claimant).toLowerCase()) {
			return { success: false, error: 'Signer address does not match claimant' }
		}
		const domain = {
			name: 'BUnitAirdrop',
			version: '1',
			chainId: CONET_CHAIN_ID,
			verifyingContract: CONET_BUNIT_AIRDROP as `0x${string}`,
		}
		const types = {
			ClaimAirdrop: [
				{ name: 'claimant', type: 'address' },
				{ name: 'nonce', type: 'uint256' },
				{ name: 'deadline', type: 'uint256' },
			],
		}
		const value = {
			claimant: ethers.getAddress(claimant),
			nonce: BigInt(nonce),
			deadline: BigInt(deadline),
		}
		const signature = await wallet.signTypedData(domain, types, value)
		const res = await fetch(`${beamioApi}/api/claimBUnits`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				claimant: ethers.getAddress(claimant),
				nonce: String(nonce),
				deadline: String(deadline),
				signature,
			}),
		})
		const data = await res.json().catch(() => ({}))
		if (!res.ok) {
			return {
				success: false,
				error: data?.error ?? res.statusText,
				code: typeof data?.code === 'string' ? data.code : undefined,
			}
		}
		return { success: true, txHash: data.txHash }
	} catch (e) {
		return { success: false, error: (e as Error)?.message ?? 'Claim failed' }
	}
}

export type BUnitAutoClaimOutcome = 'skipped_silent' | 'claimed_success' | 'noop'

/** 自动领：IDB + 链上 gate → API eligibility → claim；已领静默，不换钱包可链上复检 */
export async function runAutoBUnitFreeClaimIfEligible(
	privateKey: string,
	claimantRaw: string,
): Promise<BUnitAutoClaimOutcome> {
	const {
		gateBUnitFreeClaimBeforeSubmit,
		markBUnitFreeClaimSkippedInIdb,
		isBUnitClaimAlreadyClaimedError,
		readBUnitFreeClaimHasClaimedOnChain,
	} = await import('@/utils/bunitFreeClaimGate')
	const claimant = ethers.getAddress(claimantRaw)

	if ((await gateBUnitFreeClaimBeforeSubmit(claimant)) === 'skip_silent') {
		return 'skipped_silent'
	}

	const r = await checkBUnitClaimEligibility(claimant)
	if (!r.canClaim || r.reason === 'already_claimed') {
		await markBUnitFreeClaimSkippedInIdb(claimant, 'api')
		return 'skipped_silent'
	}
	if (r.nonce == null || r.deadline == null) return 'noop'

	const onChainBeforePost = await readBUnitFreeClaimHasClaimedOnChain(claimant)
	if (onChainBeforePost === true) {
		await markBUnitFreeClaimSkippedInIdb(claimant, 'chain')
		return 'skipped_silent'
	}

	const result = await signAndClaimBUnits(privateKey, claimant, r.nonce, r.deadline)
	if (result.success) {
		await markBUnitFreeClaimSkippedInIdb(claimant, 'api')
		return 'claimed_success'
	}
	if (isBUnitClaimAlreadyClaimedError(result.error, result.code)) {
		await markBUnitFreeClaimSkippedInIdb(claimant, 'api')
		return 'skipped_silent'
	}
	return 'noop'
}

/** 提交 Refuel B-Unit 请求到 API。Cluster 预检后转发 Master，Master 提交 BaseTreasury.purchaseBUnitWith3009Authorization。 */
export const purchaseBUnitFromBase = async (payload: import('./BeamioCard').IBUnitRefuelPayload): Promise<{ success: boolean; txHash?: string; error?: string }> => {
	try {
		const res = await fetch(`${beamioApi}/api/purchaseBUnitFromBase`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload),
		})
		const data = await res.json().catch(() => ({}))
		if (!res.ok) return { success: false, error: data?.error ?? res.statusText }
		return { success: true, txHash: data.txHash }
	} catch (e) {
		return { success: false, error: (e as Error)?.message ?? 'Refuel failed' }
	}
}

/** 校验 Voucher 支付请求是否过期或已支付。用于 Smart Routing 前置校验。 */
export const checkRequestStatus = async (
	requestHash: string,
	validDays: number,
	payee: string
): Promise<{ expired: boolean; fulfilled: boolean; error?: string }> => {
	try {
		const params = new URLSearchParams({
			requestHash,
			validDays: String(Math.max(1, Math.floor(validDays))),
			payee: ethers.getAddress(payee),
		})
		const res = await fetch(`${beamioApi}/api/checkRequestStatus?${params}`)
		if (!res.ok) {
			const err = (await res.json().catch(() => ({}))).error ?? res.statusText
			return { expired: false, fulfilled: false, error: err }
		}
		const { expired, fulfilled } = await res.json()
		return { expired: !!expired, fulfilled: !!fulfilled }
	} catch (e) {
		return { expired: false, fulfilled: false, error: (e as Error)?.message ?? tu('request_failed') }
	}
}

/** 查询 NTAG 424 DNA 卡状态（根据 UID）；若已登记则返回 address（AA/EOA） */
export const fetchNfcCardStatus = async (uid: string): Promise<{ registered: boolean; address?: string }> => {
	const res = await fetch(`${beamioApi}/api/nfcCardStatus`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ uid }),
	})
	if (!res.ok) {
		const err = (await res.json().catch(() => ({}))).error ?? res.statusText
		throw new Error(err)
	}
	return res.json()
}

/** 根据 UID 查询 NFC 卡资产（CCSA 点数 + USDC 余额），需卡已登记 */
export type UIDAssetsResponse = {
	ok: boolean
	address?: string
	cardAddress?: string
	points?: string
	points6?: string
	usdcBalance?: string
	cardCurrency?: string
	nfts?: { tokenId: string; attribute: string; tier: string; expiry: string; isExpired: boolean }[]
	error?: string
}
export const fetchUIDAssets = async (uid: string): Promise<UIDAssetsResponse> => {
	const res = await fetch(`${beamioApi}/api/getUIDAssets`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ uid: uid.trim() }),
	})
	const data = (await res.json().catch(() => ({}))) as UIDAssetsResponse
	if (!res.ok) return { ok: false, error: data.error ?? res.statusText ?? 'Query failed' }
	return data
}

/** Base 主网 BeamioUserCard 工厂地址（与 x402sdk chainAddresses 一致） */
const BASE_CARD_FACTORY = BASE_MAINNET_FACTORIES.CARD_FACTORY
const BASE_CHAIN_ID = 8453

/** NFC Topup Prepare：获取 executeForAdmin 所需的 cardAddr、data、deadline、nonce、factoryGateway（EIP-712 verifyingContract） */
export const nfcTopupPrepare = async (params: { uid: string; amount: string; currency?: string }): Promise<{
	cardAddr: string
	data: string
	deadline: number
	nonce: string
	factoryGateway: string
} | { error: string }> => {
	const res = await fetch(`${beamioApi}/api/nfcTopupPrepare`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(params),
	})
	const data = (await res.json().catch(() => ({}))) as {
		cardAddr?: string
		data?: string
		deadline?: number
		nonce?: string
		factoryGateway?: string
		error?: string
	}
	if (!res.ok || data.error) return { error: data.error ?? res.statusText ?? 'Prepare failed' }
	if (!data.cardAddr || !data.data || data.deadline == null || !data.nonce) return { error: 'Invalid prepare response' }
	let factoryGateway: string = BASE_CARD_FACTORY
	if (data.factoryGateway && ethers.isAddress(data.factoryGateway)) {
		factoryGateway = ethers.getAddress(data.factoryGateway)
	} else {
		try {
			factoryGateway = await getCardFactoryGatewayForEip712(data.cardAddr)
		} catch {
			/* keep BASE_CARD_FACTORY */
		}
	}
	return {
		cardAddr: data.cardAddr,
		data: data.data,
		deadline: Number(data.deadline),
		nonce: data.nonce,
		factoryGateway,
	}
}

/** NFC Topup：读取方 UI 用户用 profile 私钥签 ExecuteForAdmin，提交后 Master 调用 factory.executeForAdmin */
export const nfcTopup = async (params: { uid: string; amount: string; currency?: string }): Promise<{ success: boolean; txHash?: string; error?: string }> => {
	// Shell: this page-side signing path is not available (POS-owned, suspended; no page-held keys in a shell).
	if (isShellContext()) return { success: false, error: 'NFC top-up is not available in this app.' }
	if (!CoNET_Data?.profiles?.length || !CoNET_Data.profiles[0]?.privateKeyArmor) {
		return { success: false, error: '请先登录 Beamio 账户' }
	}
	const prepare = await nfcTopupPrepare(params)
	if ('error' in prepare) return { success: false, error: prepare.error }
	const { cardAddr, data, deadline, nonce, factoryGateway } = prepare
	const privateKey = CoNET_Data.profiles[0].privateKeyArmor
	const wallet = new ethers.Wallet(privateKey)
	const dataHash = ethers.keccak256(data)
	const chainId = await eip712ChainIdForBeamioUserCard(cardAddr)
	const domain = {
		name: 'BeamioUserCardFactory',
		version: '1',
		chainId,
		verifyingContract: factoryGateway,
	}
	const types = {
		ExecuteForAdmin: [
			{ name: 'cardAddress', type: 'address' },
			{ name: 'dataHash', type: 'bytes32' },
			{ name: 'deadline', type: 'uint256' },
			{ name: 'nonce', type: 'bytes32' },
		],
	}
	const message = {
		cardAddress: cardAddr,
		dataHash,
		deadline: BigInt(deadline),
		nonce: nonce.startsWith('0x') ? nonce : '0x' + nonce,
	}
	const adminSignature = await wallet.signTypedData(domain, types, message)
	const res = await fetch(`${beamioApi}/api/nfcTopup`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ cardAddr, data, deadline, nonce, adminSignature, uid: params.uid }),
	})
	const dataRes = (await res.json().catch(() => ({}))) as { success?: boolean; txHash?: string; error?: string }
	return {
		success: res.ok && dataRes.success !== false,
		txHash: dataRes.txHash,
		error: dataRes.error,
	}
}

/** 以 UID 支付：服务端使用 NFC 卡私钥向 payee 转 USDC */
export const payByNfcUid = async (params: { uid: string; amountUsdc6: string; payee: string }): Promise<{ success: boolean; USDC_tx?: string; error?: string }> => {
	// Shell: NFC payment is not available in this app (POS-owned, suspended). The request is refused before anything is sent.
	if (isShellContext()) return { success: false, error: 'NFC payment is not available in this app.' }
	const res = await fetch(`${beamioApi}/api/payByNfcUid`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(params),
	})
	const data = (await res.json().catch(() => ({}))) as { success?: boolean; USDC_tx?: string; error?: string }
	return {
		success: res.ok && data.success !== false,
		USDC_tx: data.USDC_tx,
		error: data.error,
	}
}

export const toBase64 = (s: string) => {
	const bytes = new TextEncoder().encode(s)
	let binary = ''
	for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
	return btoa(binary)
}

export async function AuthorizationSign(
	amount: bigint,
	to: string,
	/** Prefer explicit key (e.g. resolved from mnemonic) over CoNET_Data alone. */
	privateKeyArmorOverride?: string,
): Promise<string> {
	return runAuthorizationSign({
		amount,
		to,
		identityBlocked: shellChatBlockedNow(),
		explicitKey: typeof privateKeyArmorOverride === 'string' ? privateKeyArmorOverride : '',
		isShell: isShellContext(),
		profileKey: CoNET_Data?.profiles?.[0]?.privateKeyArmor ?? '',
		readBlob: async () => (await checkStorage())?.walletCredentialBlob ?? null,
		signWithKey: (privateKey, value, payee) => signAuthorizationPayload(new ethers.Wallet(privateKey), value, payee),
	})
}

async function signAuthorizationPayload(wallet: ethers.Wallet, amount: bigint, to: string): Promise<string> {
	const from = await wallet.getAddress()

	// 2) 金额 & 时间窗（现在 - 5min 到 1h 后，与注释一致，避免 facilitator 因过期拒绝）
	const value = amount
	const now = BigInt(Math.floor(Date.now() / 1000))
	const validAfter = now - BigInt(300)   // 5 分钟容错（时钟偏差）
	const validBefore = now + BigInt(3600) // 1 小时内有效    

	console.log(`AuthorizationSign validAfter = ${validAfter} validBefore ${validBefore}`)

	// 3) 随机 nonce（bytes32）
	const nonce = ethers.hexlify(ethers.randomBytes(32)) as `0x${string}`

	// 4) EIP-712 域 & 类型 & 数据（与你合约里的 TYPEHASH 字段严格一致）
	const domain = {
		name: "USD Coin",          // ERC20Permit(name) -> 你的合约构造里是 "USDC"
		version: "2",          // OpenZeppelin ERC20Permit 的默认版本是 "1"
		chainId: 8453,     // 必须与链实际 ID 一致
		verifyingContract: USDCContract_BASE,
	} as const;

	const AuthorizationTypes = {
		TransferWithAuthorization: [
		{ name: "from",        type: "address" },
		{ name: "to",          type: "address" },
		{ name: "value",       type: "uint256" },
		{ name: "validAfter",  type: "uint256" },
		{ name: "validBefore", type: "uint256" },
		{ name: "nonce",       type: "bytes32"  },
		],
	}

	const authorization = {
		from,
		to,
		value: value.toString(),
		validAfter: validAfter.toString(),
		validBefore: validBefore.toString(),
		nonce,
  	}

	// 5) 签名（返回 0x + 65 字节，合约的 bytes 接口可直接用
	try {
		const signature = await wallet.signTypedData(domain, AuthorizationTypes, authorization) as `0x${string}`
		const ret: AuthorizationPayload = {
			x402Version: 1,
			scheme: 'exact',
			network: 'base',
			payload: {
				signature,
				authorization
			}
		}
		console.log(ret)
		const testSig = await wallet.signMessage("test")
		console.log('Test signature:', testSig)

		// ✅ 安全方式：支持 UTF-8 字符
		const json = JSON.stringify(ret)
		const base64 = toBase64(json)
		return base64
	} catch (ex: any) {
		console.log(`wallet.signTypedData Error: ${diagnosticCode(ex?.message)}`) // a code only: the message of a signing error may carry the typed data
		return ''
	}
	
}

function b64ToBytes(s: string): Uint8Array {
	if (typeof Buffer !== 'undefined') {
		return new Uint8Array(Buffer.from(s, 'base64'))
	}
	const bin = atob(s)
	const out = new Uint8Array(bin.length)
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
	return out
}

function bytesToB64(bytes: Uint8Array): string {
	if (typeof Buffer !== 'undefined') {
		return Buffer.from(bytes).toString('base64')
	}
	let bin = ''
	for (let i = 0; i < bytes.length; i++) {
		bin += String.fromCharCode(bytes[i])
	}
	return btoa(bin)
}

// 把 string 转为 Uint8Array
const enc = new TextEncoder()


const b64encode = (bytes: Uint8Array): string => {
	if (typeof Buffer !== 'undefined') {
		return Buffer.from(bytes).toString('base64')
	}
	let binary = ''
	for (let i = 0; i < bytes.length; i++) {
		binary += String.fromCharCode(bytes[i])
	}
	return btoa(binary)
}

const b64decode = (s: string): Uint8Array => {
	if (typeof Buffer !== 'undefined') {
		return new Uint8Array(Buffer.from(s, 'base64'))
	}
	const binary = atob(s)
	const bytes = new Uint8Array(binary.length)
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i)
	}
	return bytes
}

const timingSafeEqualUint8 = (a: Uint8Array, b: Uint8Array): boolean => {
	if (a.length !== b.length) return false
	let diff = 0
	for (let i = 0; i < a.length; i++) {
		diff |= a[i] ^ b[i]
	}
	return diff === 0
}



export function encodeStoredCBOR(obj: any): string {
	const bytes = cborEncode(obj)  // 这里是 Uint8Array（真正的 CBOR 二进制）
  	return bytesToB64(bytes)       // 再转为 Base64 字符串
}

export function decodeStoredCBOR(b64: string): any {
	const bytes = b64ToBytes(b64)  // Base64 → Uint8Array
  	return cborDecode(bytes)       // CBOR → 原始对象
}

/** BeamioCurrency 枚举：与 BeamioCurrency.sol 一致 */
const BEAMIO_CURRENCY = { CAD: 0, USD: 1, JPY: 2, CNY: 3, USDC: 4, HKD: 5, EUR: 6, SGD: 7, TWD: 8 } as const

/** 从 Base 链上 BeamioOracle 直接读取汇率，不再使用 API 服务器。getRate(c) 返回「1 单位该货币 = X USD」E18 */
export const getOracle = async (): Promise<{
	usdcad?: string; usdjpy?: string; usdcny?: string; usdc?: string;
	usdhkd?: string; usdtwd?: string; usdeur?: string; usdsgd?: string;
} | null> => {
	try {
		const res = await withBaseRpc(async (provider) => {
			const oracle = new ethers.Contract(BEAMIO_ORACLE_BASE, BeamioOracleAbi, provider)
			const ids = [BEAMIO_CURRENCY.CAD, BEAMIO_CURRENCY.JPY, BEAMIO_CURRENCY.CNY, BEAMIO_CURRENCY.USDC,
				BEAMIO_CURRENCY.HKD, BEAMIO_CURRENCY.EUR, BEAMIO_CURRENCY.SGD, BEAMIO_CURRENCY.TWD] as const
			const rates = await Promise.all(ids.map((c) => oracle.getRate(c)))
			const ratesNum = rates.map((r) => Number(ethers.formatUnits(r, 18)))
			// 链上：1 外币 = X USD；前端需 1 USD = Y 外币，故非 USD/USDC 用倒数
			return {
				usdcad: ratesNum[0] > 0 ? String(1 / ratesNum[0]) : undefined,
				usdjpy: ratesNum[1] > 0 ? String(1 / ratesNum[1]) : undefined,
				usdcny: ratesNum[2] > 0 ? String(1 / ratesNum[2]) : undefined,
				usdc: String(ratesNum[3] || 1),
				usdhkd: ratesNum[4] > 0 ? String(1 / ratesNum[4]) : undefined,
				usdeur: ratesNum[5] > 0 ? String(1 / ratesNum[5]) : undefined,
				usdsgd: ratesNum[6] > 0 ? String(1 / ratesNum[6]) : undefined,
				usdtwd: ratesNum[7] > 0 ? String(1 / ratesNum[7]) : undefined,
			}
		})
		return res
	} catch {
		return null
	}
}

/** 将 getOracle 返回的原始数据解析为 currencyData 格式，供全局 feeder 和各页面使用 */
export const parseOracleToCurrencyData = (data: { usdcad?: string | number; usdjpy?: string | number; usdcny?: string | number; usdc?: string | number; usdhkd?: string | number; usdtwd?: string | number; usdeur?: string | number; usdsgd?: string | number } | null): currencyData => {
	if (!data) {
		return { CAD: 1.35, USD: 1, JPY: 150, CNY: 7.2, USDC: 1, HKD: 7.8, SGD: 1.35, EUR: 0.92, TWD: 31 }
	}
	return {
		CAD: Number(data.usdcad) || 1.35,
		USD: 1,
		JPY: Number(data.usdjpy) || 150,
		CNY: Number(data.usdcny) || 7.2,
		USDC: Number(data.usdc) || 1,
		HKD: Number(data.usdhkd) || 7.8,
		TWD: Number(data.usdtwd) || 31,
		EUR: Number(data.usdeur) || 0.92,
		SGD: Number(data.usdsgd) || 1.35
	}
}

/** 全局 Oracle 刷新间隔：5 分钟 */
export const ORACLE_REFRESH_MS = 5 * 60 * 1000


export const estimateGasUSDC = async (amount: number, to: string) => {
	if (!CoNET_Data?.profiles?.length) {
		return null
	}
	const privateKey = CoNET_Data.profiles[0].privateKeyArmor
	const wallet = new ethers.Wallet(privateKey, baseEndpoint)
	const sc = new ethers.Contract(USDCContract_BASE, usdc_abi, wallet)
	const _amount = ethers.parseUnits(amount.toFixed(2), 6)
	try {
		const [gas, price, oracle] = await Promise.all([
			sc.transfer.estimateGas(to || ethers.ZeroAddress, _amount),
			baseEndpoint.getFeeData(),
			getOracle(),
		])

		if (oracle) {
			return {gas: gas * BigInt(3), price: price.gasPrice, oracle}
		}

		return null
	} catch (ex) {
		return null
	}
}

const CURRENCY_CN: Record<string, string> = {
  USD: "美元", USDC: "美元", USDT: "美元",
  EUR: "欧元",
  JPY: "日元",
  CNY: "人民币", CNH: "离岸人民币",
  HKD: "港元",
  GBP: "英镑",
  AUD: "澳元",
  CAD: "加元",
  SGD: "新元",
  TWD: "新台币",
}
/** 中文数字（整数部分），支持到兆 */
function toChineseNumber(input: number | string): string {
	// 输入清理
	let n: number
	if (typeof input === "number") n = input
	else {
		const cleaned = input.trim().replace(/[^\d.-]/g, "")
		const parsed = parseFloat(cleaned)
		n = Number.isFinite(parsed) ? parsed : 0
	}

	const negative = n < 0
	n = Math.abs(n)

	// 四舍五入到分
	const cents = Math.round(n * 100)
	const intPart = Math.floor(cents / 100)
	const jiao = Math.floor((cents % 100) / 10)
	const fen = cents % 10

	// 金融大写数字与单位
	const digits = ["零", "壹", "贰", "叁", "肆", "伍", "陆", "柒", "捌", "玖"]
	const unitsSmall = ["", "拾", "佰", "仟"]
	const unitsSection = ["", "万", "亿", "兆"]

	/** 0~9999 内的转换（节内简化规则：非最高位的“壹拾/佰/仟”可省略壹） */
	const sectionToCN = (num: number): string => {
		if (num === 0) return ""
		let s = ""
		const str = String(num)
		const len = str.length
		for (let i = 0; i < len; i++) {
		const d = parseInt(str[len - 1 - i])
		if (d === 0) {
			if (!s.startsWith("零") && s !== "") s = "零" + s
		} else {
			const isHighPos = i === len - 1 // 节最高位不省略
			const digitStr = (d === 1 && i > 0 && !isHighPos) ? "" : digits[d]
			s = digitStr + unitsSmall[i] + s
		}
		}
		return s.replace(/零+/g, "零").replace(/^零|零$/g, "")
	}

	// 整数部分
	let intCN = ""
	if (intPart === 0) {
		intCN = "零"
	} else {
		let nLeft = intPart
		let unitIndex = 0
		while (nLeft > 0 && unitIndex < unitsSection.length) {
		const section = nLeft % 10000
		if (section !== 0) {
			const head = sectionToCN(section)
			intCN = head + unitsSection[unitIndex] + intCN
		} else if (!intCN.startsWith("零") && intCN !== "") {
			intCN = "零" + intCN
		}
		nLeft = Math.floor(nLeft / 10000)
		unitIndex++
		}
		intCN = intCN.replace(/零+/g, "零").replace(/^零|零$/g, "")
	}

	// 小数部分（角/分）
	let fracCN = ""
	if (jiao === 0 && fen === 0) {
		fracCN = "整"
	} else if (jiao === 0 && fen !== 0) {
		fracCN = "零" + digits[fen] + "分"
	} else if (jiao !== 0 && fen === 0) {
		fracCN = digits[jiao] + "角"
	} else {
		fracCN = digits[jiao] + "角" + digits[fen] + "分"
	}

	const sign = negative ? "负" : ""
	return sign + intCN + "元" + fracCN
}


/** 日语金融漢数字（壱 弐 参 肆 伍 陸 漆 捌 玖 零），支持小数（角/分） */
function toJapaneseNumber(input: number | string): string {
	let n: number
	if (typeof input === "number") n = input
	else {
		const cleaned = input.trim().replace(/[^\d.-]/g, "")
		const parsed = parseFloat(cleaned)
		n = Number.isFinite(parsed) ? parsed : 0
	}

	const negative = n < 0
	n = Math.abs(n)

	const cents = Math.round(n * 100)
	const intPart = Math.floor(cents / 100)
	const jiao = Math.floor((cents % 100) / 10)
	const fen = cents % 10

	// ✅ 金融漢数字（日语）
	const digits = ["零", "壱", "弐", "参", "肆", "伍", "陸", "漆", "捌", "玖"]
	const unitsSmall = ["", "拾", "百", "千"]
	const unitsSection = ["", "万", "億", "兆"]

	const sectionToJP = (num: number): string => {
		if (num === 0) return ""
		let s = ""
		for (let i = 0; i < 4; i++) {
		const d = num % 10
		if (d !== 0) {
			const digitStr = (d === 1 && i > 0) ? "" : digits[d]
			s = digitStr + unitsSmall[i] + s
		} else if (!s.startsWith("零") && s !== "") {
			s = "零" + s
		}
		num = Math.floor(num / 10)
		if (num === 0) break
		}
		return s.replace(/零+/g, "零").replace(/^零|零$/g, "")
	}

	let intCN = ""
	if (intPart === 0) {
		intCN = "零"
	} else {
		let nLeft = intPart
		let unitIndex = 0
		while (nLeft > 0 && unitIndex < unitsSection.length) {
		const section = nLeft % 10000
		if (section !== 0) {
			const head = sectionToJP(section)
			intCN = head + unitsSection[unitIndex] + intCN
		} else if (!intCN.startsWith("零") && intCN !== "") {
			intCN = "零" + intCN
		}
		nLeft = Math.floor(nLeft / 10000)
		unitIndex++
		}
		intCN = intCN.replace(/零+/g, "零").replace(/^零|零$/g, "")
	}

	let fracCN = ""
	if (jiao === 0 && fen === 0) {
		fracCN = "整"
	} else if (jiao === 0 && fen !== 0) {
		fracCN = "零" + digits[fen] + "分"
	} else if (jiao !== 0 && fen === 0) {
		fracCN = digits[jiao] + "角"
	} else {
		fracCN = digits[jiao] + "角" + digits[fen] + "分"
	}

	const sign = negative ? "マイナス " : ""
	return sign + intCN + "ドル" + (fracCN ? fracCN : "")
}

export const redeemCodeHash = (redeemCode: string, passcode: string) => {
	const hash = ethers.solidityPackedKeccak256(['string', 'string'], [redeemCode, passcode])
	return hash
}

export const generateCODE = (passcode: string) => {
	const code: string = uuid62.v4()
	const hash = ethers.solidityPackedKeccak256(['string', 'string'], [code, passcode])
	return ({
		code, hash
	})
}



/** 生成 request 唯一 hash（bytes32），供 URL 与链上 originalPaymentHash 使用 */
export const generateRequestHash = (): string => {
	const seed = uuid62.v4() + '-' + Date.now() + '-' + Math.random().toString(36).slice(2)
	return ethers.keccak256(ethers.toUtf8Bytes(seed))
}

//		https://beamio.ca/app/?nftRedeemcode=null&tagid=${tagid}&uid=${uid}&counter=${counter}

/**
 * 将金额格式化为人类可读的文字形式
 * @param amount number | string
 * @param lang "cn" | "en" | "ja"
 * @param currency 货币代码，如 USDC、JPY
 */
export function formatAmountReadable(amount: number | string, lang='en', currency='USD'): string {
	const code = (currency || "").toUpperCase()

	// 统一解析数值（兼容 string）
	let n: number
	if (typeof amount === "number") n = amount
	else {
		const cleaned = amount.replace(/[^\d.-]/g, "")
		const parsed = parseFloat(cleaned)
		n = Number.isFinite(parsed) ? parsed : 0
	}

	if (lang === "cn") {
		// 中文：直接用 toChineseNumber（内含“元/角/分”），不要再额外拼 “元”
		const name = CURRENCY_CN[code] || code
		return `${name} ${toChineseNumber(n)}`
	}

	// 其它语言维持整数可读（如需带小数，可改为 n.toLocaleString）
	const intPart = Math.floor(Math.max(0, n))

	if (lang === "ja") {
		const CURRENCY_JA: Record<string, string> = {
			USD: "米", USDC: "米", USDT: "米",
			EUR: "ユーロ", JPY: "円", CNY: "人民元", HKD: "香港ドル",
			GBP: "英ポンド", AUD: "豪ドル", CAD: "カナダドル",
			SGD: "シンガポールドル", TWD: "ニュー台湾ドル",
		}
		const name = CURRENCY_JA[code] || code
		return `${name} ${toJapaneseNumber(n)}`
	}

	if (lang === "en") return toEnglishCheckWords(amount)

	return `${code} ${intPart.toLocaleString("en-US")}`
}

 // 千分位格式化（固定两位小数）
export const formatWithThousands = (n: string | number, fixed = 2): string => {
	const num = Number(n)
	if (isNaN(num)) return "0.00"

	const [intPart, decPart = "00"] = num.toFixed(fixed).split(".")
	const intWithCommas = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",")
	return `${intWithCommas}${fixed ? '.' + decPart : ''}`
}

export const getUSDCFaucet = async (address: string) => {
	const params = new URLSearchParams({address}).toString()
	const url = `${getFaucetEndpoint}?${params}`
	try {
		const req = await fetch(url, {
			method: 'GET'
		})
		if (req.status !== 200) {
			console.log(`getFaucet status !== 200 Error!`)
			return false
		}

		return true

	} catch (ex) {
		console.log(`getFaucet Error`, ex)
	}
	return false
}

export function toEnglishCheckWords(input: number | string): string {
	// 1) 统一为字符串，清理除 0-9. - 之外的字符
	let s = typeof input === "number" ? input.toFixed(10) : String(input || "");
	console.log("原始输入:", s);
	
	s = s.replace(/[^\d.-]/g, "").trim();
	if (!s || s === "-" || s === "." || s === "-.") s = "0";

	// 2) 处理负号
	const negative = s.startsWith("-");
	if (negative) s = s.slice(1);

	// 3) 只认**第一个**小数点为分隔，小数取两位（不足补零，超出截断）
	const dot = s.indexOf(".");
	const intRaw = dot >= 0 ? s.slice(0, dot) : s;
	const fracRaw = dot >= 0 ? s.slice(dot + 1) : "";
	
	console.log("intRaw:", intRaw, "fracRaw:", fracRaw);
	
	const intStr = (intRaw.replace(/^0+(?=\d)/, "") || "0"); // 去前导零但至少留一位
	const fracTwo = (fracRaw + "00").slice(0, 2);

	console.log("intStr:", intStr, "fracTwo:", fracTwo);

	// 4) 防御性：整数部分如果为空/非数字，按 0；用 BigInt 防止被截断
	const dollars = intStr === "" ? BigInt(0) : BigInt(intStr);
	const cents = Number(fracTwo); // 0..99

	console.log("dollars:", dollars, "cents:", cents);

	// 5) 转英文
	const words = intToEnglishBig(dollars);
	console.log("words:", words);
	
	const fraction = String(cents).padStart(2, "0");
	const sign = negative ? "Negative " : "";

	// 6) 首字母大写 + 支票尾巴
	const start = words ? words.charAt(0).toUpperCase() + words.slice(1) : "Zero";
	const result = `${sign}${start} and ${fraction}/100 dollars`;
	console.log("最终结果:", result);
	
	return result;
}


function intToEnglishBig(n: bigint): string {
	if (n === BigInt(0)) return "zero";

	const below20 = ["","one","two","three","four","five","six","seven","eight","nine","ten",
		"eleven","twelve","thirteen","fourteen","fifteen","sixteen","seventeen","eighteen","nineteen"];
	const tens = ["","","twenty","thirty","forty","fifty","sixty","seventy","eighty","ninety"];
	const scales = ["","thousand","million","billion","trillion","quadrillion","quintillion"];

	const chunkToWords = (x: number): string => {
		const h = Math.floor(x / 100);
		const t = x % 100;
		const u = x % 10;
		const out: string[] = [];
		if (h) out.push(below20[h], "hundred");
		if (t) {
			if (t < 20) out.push(below20[t]);
			else {
				const tw = tens[Math.floor(t / 10)];
				out.push(u ? `${tw}-${below20[u]}` : tw);
			}
		}
		return out.join(" ").trim();
	};

	const parts: string[] = [];
	let i = 0;
	while (n > BigInt(0)) {
		const chunk = Number(n % BigInt(1000));
		if (chunk) {
			const w = chunkToWords(chunk);
			const s = scales[i];
			parts.unshift(s ? `${w} ${s}` : w);
		}
		n = n / BigInt(1000);
		i++;
	}
	return parts.join(" ").replace(/\s+/g, " ").trim();
}



const listeners = new Map<string, Handler[]>()

export function onWalletEvent(event: string, handler: Handler) {
  const arr = listeners.get(event) || []
  arr.push(handler)
  listeners.set(event, arr)

  // 返回 off 函数
  return () => {
    const arr = listeners.get(event)
    if (!arr) return
    const idx = arr.indexOf(handler)
    if (idx >= 0) arr.splice(idx, 1)
  }
}

export function emitWalletEvent(event: string, payload?: any) {
  const arr = listeners.get(event)
  if (!arr) return
  arr.forEach(h => h(payload))
}

const createKeyHDWallets = (secretPhrase: string | null) => {
  // Shell: the page never creates or derives an account key; the native layer does.
  if (isShellContext()) return null;
  try {
    if (!secretPhrase) return ethers.Wallet.createRandom();

    return ethers.Wallet.fromPhrase(secretPhrase);
  } catch (ex) {
    return null;
  }
}

/**
 * Ensure `profiles[0].privateKeyArmor` exists in session `CoNET_Data`.
 * When IndexedDB has `mnemonicPhrase` but profile lost `privateKeyArmor`, re-derive from the 12-word phrase.
 * If both are missing, user must `restoreWithUserPin` (BeamioTag + password, CoNET recover) — see
 * `beamio-consumer-wallet-signing-storage.mdc` (bizSite must not persist keys; consumer/POS may).
 */
export const ensureProfilePrivateKeyArmorFromMnemonic = (
  data: encrypt_keys_object | null,
): encrypt_keys_object | null => {
  if (!data?.profiles?.length) return data
  const profiles = ensureFlatProfiles(data.profiles)
  const p0 = profiles[0]
  if (!p0) return data
  const existing = p0.privateKeyArmor?.trim() ?? ''
  if (existing) {
    if (profiles === data.profiles) return data
    return { ...data, profiles }
  }
  const phrase = typeof data.mnemonicPhrase === 'string' ? data.mnemonicPhrase.trim() : ''
  if (!phrase) return data
  // Shell: the page never derives an account key from a mnemonic; the native layer holds the keys.
  if (isShellContext()) return data
  const acc = createKeyHDWallets(phrase)
  if (!acc) return data
  const keyID = p0.keyID?.trim() ?? ''
  if (keyID && ethers.isAddress(keyID) && acc.address.toLowerCase() !== keyID.toLowerCase()) {
    console.warn('[ensureProfilePrivateKeyArmor] mnemonic does not match stored keyID')
    return data
  }
  const nextProfile: profile = {
    ...p0,
    privateKeyArmor: acc.signingKey.privateKey,
    publicKeyArmor: acc.publicKey,
    keyID: keyID || acc.address,
  }
  return { ...data, profiles: [nextProfile, ...profiles.slice(1)] }
}

const getDuplicateOwnership = async(duplicateAccount: string, keyID: string): Promise<boolean|null> => {
	try {
		const owner = await duplicate_readOnly.duplicateList(keyID)
		if (owner === ethers.ZeroAddress || duplicateAccount.toLowerCase() !== owner.toLowerCase()) {
			return false
		}
		return true
	} catch (ex) {
		return null
	}

}

const duplicateAPI = `${apiv4_endpoint}duplicate`
// const initDuplicate = async (temp: encrypt_keys_object): Promise<encrypt_keys_object|null> => {
	
// 	temp._duplicateCode = temp?._duplicateCode || uuid62.v4()
// 	temp.duplicateCodeHash = ethers.solidityPackedKeccak256(['string'], [temp._duplicateCode])
// 	temp.duplicateMnemonicPhrase = temp.mnemonicPhrase


// 	if (!temp?.duplicateAccount) {
// 		const profiles = temp.profiles
// 		const message = JSON.stringify({ walletAddress: profiles[0].keyID, hash: temp.duplicateCodeHash, data: '', channelPartners: temp.ChannelPartners})
// 		const wallet = new ethers.Wallet(profiles[0].privateKeyArmor)
// 		const signMessage = await wallet.signMessage(message)
// 		const sendData = {
// 		  	message, signMessage
// 		}
	
// 		const result = await postToEndpoint(duplicateAPI, true, sendData)
// 		if (!result|| !result?.status) {
// 			console.log(`initDuplicate Error!`, result?.error)
// 			return temp
// 		}
// 		console.log(`initDuplicate success!`, result?.status)

// 		temp.duplicateAccount = {
// 			privateKeyArmor: profiles[0].privateKeyArmor,
// 			tokens: initProfileTokens(),
// 			publicKeyArmor: '',
// 			referrer: '',
// 			keyID: result.status,
// 			isNode: false,
// 			index: 0,
// 			hdPath: null,
// 		}
		
// 	} else {
// 		const keyID = temp.profiles[0].keyID
// 		const duplicateStatus = await getDuplicateOwnership(temp.duplicateAccount.keyID, keyID)
// 		if (duplicateStatus === false) {
			
// 			return null
// 		}
// 	}

// 	if (!temp?.duplicatePassword) {
// 		temp.duplicateCode = ''
// 	}

// 	return temp

// }

export const createOrGetWallet = async (secretPhrase: string | null, initAccount = false, referrals = '', ChannelPartners = '' ) => {
	// Shell: the page never creates or derives an account key here; its callers (create, backup restore) are native in a shell.
	if (isShellContext()) return null
	const hasIncomingMnemonic = typeof secretPhrase === 'string' && secretPhrase.length > 0
	// Restore / 临时券钱包：不依赖本地库；私密模式 IndexedDB 读可能永久挂起。
	if (!hasIncomingMnemonic && !initAccount) {
		await checkStorageWithTimeout()
	}

  if (secretPhrase|| initAccount ) setCoNET_Data(null)

  if (CoNET_Data?.profiles?.length) {
    const hydrated = ensureProfilePrivateKeyArmorFromMnemonic(CoNET_Data)
    if (hydrated) setCoNET_Data(hydrated)
  }

  if (!CoNET_Data || !CoNET_Data?.profiles) {
		const acc = createKeyHDWallets(secretPhrase);

		

		if (!acc) return null

		const profile: profile = {
			tokens: initProfileTokens(),
			publicKeyArmor: acc.publicKey,
			keyID: acc.address,
			isPrimary: true,
			referrer: null,
			isNode: false,
			privateKeyArmor: acc.signingKey.privateKey,
			hdPath: acc.path,
			index: acc.index,
			type: "ethereum",
			webFilter: true
		};

		const data: any = {
			mnemonicPhrase: acc?.mnemonic?.phrase,
			profiles: [profile],
			isReady: true,
			ver: 0,
			nonce: 0,
		};

		if (acc?.mnemonic?.phrase) {

		}

		
		
		setCoNET_Data(data)
	}



	let tmpData = CoNET_Data
	if (!tmpData) {
		return null
	}

  	tmpData.ChannelPartners = ChannelPartners
	tmpData.referrals = referrals
  


	// tmpData = await initDuplicate(tmpData)
	// if (!tmpData) {
	// 		return
	// }
  
	await setCoNET_Data(tmpData)

	// Must await a real IndexedDB write. Debounced storeSystemData returns before
	// PouchDB persists — refresh during onboarding would lose mnemonic/privateKey.
	await flushStoreSystemData()

	if (tmpData === null) {
			setTimeout(() => {
				return window.location.reload()
			}, 5000)
		return null
	}

	return tmpData
}

export type CheckStorageResult =
  | { status: 'loaded'; data: encrypt_keys_object; copyValidated?: true }
  | { status: 'empty' }
  | { status: 'unavailable'; reason: 'timeout' | 'indexeddb' | 'invalid_document' | 'vault_unreadable' | 'native_record' | 'native_recovery_needed' | 'native_retry' | 'native_reading' | 'native_unreadable' | 'native_locked' | 'eoa_mismatch' | 'app_update_required' | 'old_shell_upgrade_required' | 'native_not_ready_bounded' | 'native_not_ready_final' | 'native_passcode_not_provided' }
  /** Encrypted with a passcode and not unlocked yet. Never treated as empty: the gate asks for the passcode. */
  | { status: 'locked' }

// ---------------------------------------------------------------------------
// Wallet storage (logic in passcode/walletVault.ts). The init document keeps the blob with each
// secret replaced in place by a wrap record. `meta` holds the failure counter and the marker. `vault` is the
// document, read only to convert data written by that build.
// ---------------------------------------------------------------------------

/** Title (base64 blob or JSON text) of a PouchDB document, or null when it is missing. */
const readDocTitle = async (docId: string): Promise<string | null> => {
  await idbBlobCompatReady()
  const database = PouchDB(localDatabaseName, { auto_compaction: true })
  try {
    const doc: { title?: unknown } = await database.get(docId, { latest: true })
    return typeof doc.title === 'string' ? doc.title : null
  } catch (ex: any) {
    if (isPouchMissingDocError(ex)) return null
    throw ex
  }
}

const removeDocIfExists = async (docId: string): Promise<void> => {
  await idbBlobCompatReady()
  const database = PouchDB(localDatabaseName, { auto_compaction: true })
  try {
    const doc = await database.get(docId, { latest: true })
    await database.remove(doc)
  } catch (ex: any) {
    if (!isPouchMissingDocError(ex)) throw ex
  }
}

/** Durable put with verify, without the Cache API copy (that copy holds only the init blob). */
const putDocDurable = async (docId: string, title: string): Promise<void> => {
  await idbBlobCompatReady()
  const database = PouchDB(localDatabaseName, { auto_compaction: true })
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      let existingRev: string | undefined
      try {
        const doc = await database.get(docId, { latest: true })
        existingRev = typeof doc?._rev === 'string' ? doc._rev : undefined
      } catch (getEx: any) {
        if (!isPouchMissingDocError(getEx)) throw getEx
      }
      await database.put(existingRev ? { _id: docId, title, _rev: existingRev } : { _id: docId, title })
      const written = await database.get(docId, { latest: true })
      if (typeof written?.title !== 'string' || written.title !== title) {
        throw new Error(`[putDocDurable] verify mismatch for ${docId}`)
      }
      return
    } catch (ex: any) {
      const conflict = ex?.status === 409 || ex?.status === '409' || String(ex?.name ?? '').toLowerCase() === 'conflict'
      if (conflict && attempt < 4) {
        await new Promise((r) => setTimeout(r, 30 + attempt * 40))
        continue
      }
      throw ex instanceof Error ? ex : new Error(`[putDocDurable] failed for ${docId}`)
    }
  }
  throw new Error(`[putDocDurable] conflict retries exhausted for ${docId}`)
}


/**
 * Plan N: the wallet record. The browser reads and writes the PouchDB `init`document. The shell reads and writes
 * the native store over the bridge: the page sees the sanitized copy (no PGP private field) and writes its own fields only.
 */
const readInitObject = async (options: { probe?: boolean } = {}): Promise<Loose | null> => {
  if (isShellContext()) {
    // absent is null; a read without the W-class fields, a redacted read, or any error throws (never an absent wallet).
    // a probe read (the pre-save read) does not move the write basis.
    return shellRecordAsWalletRecord(await shellRecordRead({ ...options, source: options.probe ? 'probe' : 'init' }))
  }
  const raw = await readDocTitle('init')
  return raw ? parseInitRaw(raw) : null
}

const writeInitObject = async (data: Loose): Promise<void> => {
  // 0.53.39 (independent review item 2): the one persistence writer refuses a record that would lose a stored secret, on both
  // the shell and the browser path. The records built by wrapForDisk already keep the stored secrets; this is the last check before the write.
  // a read that fails throws here: nothing is written and the stored record stays as it is. Only a confirmed absence (null) is an empty record.
  const stored = ((await readInitObject({ probe: true })) ?? {}) as Loose
  assertStoredSecretsKept(stored, data)
  if (isShellContext()) {
    assertNoPgpPrivate(data)
    await shellRecordWrite(data)
    return
  }
  await storageHashData('init', encodeInitRaw(data))
}

/** The write of the wallet record: browser encodes it into PouchDB (with the Cache API copy); the shell writes the native store. */
/** The refusal code of the overwrite floor (0.53.44): the write is refused before anything is written. */
export const PAGE_RECORD_OVERWRITE_REFUSED = 'page_record_overwrite_refused'

/** A refused overwrite: counted, recorded with its printable diagnostic code (no UI), and thrown before anything is written. */
const refuseOverwrite = (): never => {
  pageRecordOverwriteRefused += 1
  publishNativePwaLog('warn', `[persistInitRecord] page record overwrite refused: code=${diagnosticCode(PAGE_RECORD_OVERWRITE_REFUSED)} count=${pageRecordOverwriteRefused}`)
  throw new Error(PAGE_RECORD_OVERWRITE_REFUSED)
}

/**
 * The complete existing record with the new copy merged in, for the same account whose copy carries no mnemonic (the publicWalletSeed copy
 * of a valid page entry). The existing mnemonic is kept as it is; profiles are matched by keyID and the new fields win, the existing
 * private key armor and other fields the new copy does not carry are kept.
 */
const mergeKeepingAccount = (existing: Loose, temp: encrypt_keys_object): encrypt_keys_object => {
  const keyOf = (p: Loose | undefined): string => String(p?.keyID ?? '').trim().toLowerCase()
  const eProfiles = Array.isArray(existing.profiles) ? (existing.profiles as Loose[]) : []
  const tProfiles = Array.isArray((temp as Loose).profiles) ? ((temp as Loose).profiles as Loose[]) : []
  const profiles = eProfiles.map((q) => {
    const t = tProfiles.find((p) => keyOf(p) === keyOf(q))
    return t ? { ...q, ...t } : q
  })
  for (const t of tProfiles) if (!eProfiles.some((q) => keyOf(q) === keyOf(t))) profiles.push(t)
  return { ...existing, ...(temp as Loose), mnemonicPhrase: existing.mnemonicPhrase, profiles } as unknown as encrypt_keys_object
}

/**
 * 0.53.44 (item 2, after PART 1): the shell page record is read first and kept whole, then the new copy is merged or written.
 * - No existing record, or an existing record with no mnemonic (a key-only copy): the new copy is written as it is.
 * - The existing record holds a phrase that cannot be derived (fail-closed), or a valid mnemonic for another keyID than the new copy:
 *   refused, nothing written.
 * - The same account (keyID = the EOA of the existing valid mnemonic): a new copy with its own valid mnemonic for that EOA is written;
 *   a new copy without a mnemonic is merged into the complete existing record (the mnemonic is never lost); any other phrase is refused.
 * A read that fails throws before this check, so nothing is written either. Returns the copy to write.
 */
const assertPageRecordNotOverwritten = async (temp: encrypt_keys_object, pageExisting?: Loose | null): Promise<encrypt_keys_object> => {
  // unit (b) item 1 (): the page IndexedDB copy, when given, is the existing record (the shell start copy is no longer the native one)
  const existing = (pageExisting !== undefined ? pageExisting : ((await readInitObject({ probe: true })) ?? null)) as Loose | null
  if (!existing) return temp
  const phrase = typeof existing.mnemonicPhrase === 'string' ? existing.mnemonicPhrase.trim() : ''
  if (!phrase) return temp
  const existingEoa = validMnemonicEoa(existing as encrypt_keys_object)
  if (!existingEoa) refuseOverwrite()
  const existingKeyID = String((existing.profiles as Loose[] | undefined)?.[0]?.keyID ?? '').trim().toLowerCase()
  if (existingKeyID !== existingEoa) return temp
  const newKeyID = String((temp.profiles as Loose[] | undefined)?.[0]?.keyID ?? '').trim().toLowerCase()
  if (newKeyID !== existingKeyID) refuseOverwrite()
  const newPhrase = typeof (temp as Loose).mnemonicPhrase === 'string' ? ((temp as Loose).mnemonicPhrase as string).trim() : ''
  if (!newPhrase) return mergeKeepingAccount(existing, temp)
  if (validMnemonicEoa(temp) !== existingKeyID) refuseOverwrite()
  return temp
}

// exported for the persistence regression (0.53.39): the production write of the wallet record, shell and browser paths
/** Shell native copy syncs still in flight (unit (b) item 1). Tests and a QA flush wait on them with flushShellNativeSync. */
const shellNativeSyncs = new Set<Promise<void>>()
export const flushShellNativeSync = async (): Promise<void> => {
  await Promise.allSettled([...shellNativeSyncs])
}

/**
 * Unit (b) item 1 (the decision): a shell save writes the page's own IndexedDB first (existing wrap format, the same merge and refusal
 * rules as before), then reads the mnemonic back from it. The save resolves on that verified write. The native copy is synced in the background
 * through the trusted bridge; its failure is a pending sync, never a failed save and never a change of the page copy.
 */
const persistPageIdbCopy = async (written: encrypt_keys_object): Promise<void> => {
  let raw: string | null
  qaPersistStage('page_idb_read')
  try {
    raw = await readDocTitle('init')
  } catch (err) {
    if (process.env.REACT_APP_QA_BRIDGE_COUNTER === 'true') qaLine('[persist]', `page_idb read_failed name=${qaErrorName(err)} store=init`)
    throw new Error('page_idb_unknown')
  }
  const existing = raw ? parseInitRaw(raw) : null
  qaPersistStage('page_idb_wrap')
  const record = (await wrapForDisk(pageIdbWalletStores(existing), written as unknown as Loose)) as Loose
  qaPersistStage('page_idb_put')
  await putDocDurable('init', encodeInitRaw(record))
  qaPersistStage('page_idb_readback')
  const phrase = typeof (written as Loose).mnemonicPhrase === 'string' ? ((written as Loose).mnemonicPhrase as string).trim() : ''
  if (phrase) {
    const back = await readPageIdbInit()
    if (back.status !== 'valid' || back.phrase !== phrase || back.eoa !== validMnemonicEoa(written)) throw new Error('page_idb_readback_mismatch')
  }
}

/** The chats floor keeps the stored messages of a row, except while the user's own plaintext purge is in effect for this account (the bodies are removed on purpose). */
const floorOptionsFor = (record: unknown): { keepMessages: boolean } => {
  const first = Array.isArray((record as { profiles?: unknown })?.profiles) ? ((record as { profiles: Array<{ keyID?: unknown }> }).profiles[0]) : undefined
  const eoa = typeof first?.keyID === 'string' ? first.keyID : ''
  return { keepMessages: !isChatBodiesPurgedFor(eoa) }
}

export const persistInitRecord = async (temp: encrypt_keys_object): Promise<void> => {
  if (isShellContext()) {
    qaPersistStage('read_page_idb')
    const pageState = await readPageIdbInit()
    if (pageState.status === 'unknown') throw new Error('page_idb_unknown')
    qaPersistStage('read_native_probe')
    // the refusal floor holds against both copies: the page IndexedDB (the start copy) and the native copy (a valid account there is never replaced)
    // A native read that fails (any answer other than ok or absent) means the native state is unknown, not that the save failed: the page copy is
    // still written under the page-side refusal rules, and the native copy is synced afterwards by syncShellNativeCopy, which has its own
    // guarded write and records a pending sync.
    let nativeExisting: Loose | null = null
    try {
      nativeExisting = ((await readInitObject({ probe: true })) ?? null) as Loose | null
    } catch (err) {
      markPendingSync('native_profile_sync')
      publishNativePwaLog('warn', `[persistInitRecord] native state unknown before the page save (${diagnosticCode(err instanceof Error ? err.message : 'failed')}): the page copy is saved first`)
    }
    qaPersistStage('overwrite_guard')
    const byPage = await assertPageRecordNotOverwritten(temp, pageState.status === 'valid' ? pageState.data : null)
    const merged = await assertPageRecordNotOverwritten(byPage, nativeExisting)
    // The shell write whitelist refuses a copy whose chat rows carry the peer's PGP public armor (TR-37), so the persisted copy drops exactly that
    // field (memory is not touched; verifiedFingerprint and every other field stay). The chats floor: the stored rows (page copy and native copy)
    // are kept, a copy never makes them fewer (refused with chats_floor when they cannot be merged safely).
    qaPersistStage('chats_floor')
    // the floor's source is the page copy only: the native record owns its own chats and is not merged in (it could bring back rows the page removed)
    // the count is taken on the copy as it came in (before the strip), so it says how many rows carried the key
    const armorRows = countPeerArmorRows(merged)
    if (process.env.REACT_APP_QA_BRIDGE_COUNTER === 'true' && armorRows > 0) qaLine('[persist]', `peer_armor_dropped rows=${armorRows}`)
    const withFloor = keepStoredChats(withoutPeerArmorForShell(merged), pageState.status === 'valid' ? pageState.data : null, floorOptionsFor(merged))
    const written = withoutPeerArmorForShell(withFloor)
    // the shell write whitelist (PGP private and public fields, size) is checked here, synchronously, as before the save resolves
    qaPersistStage('shell_write_check')
    buildShellRecordWriteCommand(0, written as unknown as Loose, 0)
    await persistPageIdbCopy(written)
    qaRecordCounts('saved', written)
    const sync = syncShellNativeCopy(written)
    shellNativeSyncs.add(sync)
    void sync.finally(() => shellNativeSyncs.delete(sync))
    return
  }
  await persistInitRecordBrowser(temp)
}

/** The native copy of a shell save (background): the pre-existing shell write, unchanged, and a failure is a pending sync. */
const syncShellNativeCopy = async (written: encrypt_keys_object): Promise<void> => {
  try {
    const record = (await wrapForDisk(walletStores(), written as unknown as Loose)) as Loose
    // draft 22.4: a key-only copy (both sides confirmed no mnemonic) is isolated with an audit before any full write. Any other
    // record takes the editable-field path, unchanged. Refusal or unknown throws before anything is written.
    const newFirst = Array.isArray(record.profiles) ? (record.profiles[0] as Loose | undefined) : undefined
    const newKeyID = typeof newFirst?.keyID === 'string' ? newFirst.keyID : undefined
    const { isolated } = await prepareShellFreshWrite(isKeyOnlyCopyWithoutMnemonic as unknown as (rec: Loose) => boolean, newKeyID)
    await writeInitObject(record)
    if (isolated) {
      // draft 22.4 step 3: the fresh account is read back and must be the account written.
      const back = await shellRecordRead({ source: 'init' })
      const wanted = String((Array.isArray(record.profiles) ? (record.profiles[0] as Loose)?.keyID : '') ?? '').toLowerCase()
      const got = back.status === 'ok' && Array.isArray(back.record.profiles) ? String((back.record.profiles[0] as Loose)?.keyID ?? '').toLowerCase() : ''
      if (back.status !== 'ok' || !wanted || got !== wanted) throw new Error('fresh_write_readback_mismatch')
    }
  } catch (err) {
    markPendingSync('native_profile_sync')
    if (process.env.REACT_APP_QA_BRIDGE_COUNTER === 'true') qaLine('[persist]', `native_write deferred code=${qaErrorCode(err)} name=${qaErrorName(err)} store=native_record`)
    publishNativePwaLog('warn', `[persistInitRecord] native copy sync pending (${diagnosticCode(err instanceof Error ? err.message : 'failed')}): the page copy is saved`)
  }
}

const persistInitRecordBrowser = async (temp: encrypt_keys_object): Promise<void> => {
  // 0.53.39 (independent review item 2): the browser write goes through the same guarded writer as the shell (read, refuse a loss or an
  // unknown read, then write). The backup copy is taken only after the write was accepted, so a refused record is never cached.
  // the chats floor on the browser path too: the stored rows are kept; an unreadable stored record leaves the copy as it is (the writer's own guard reads it)
  const storedPlain = await readPlainForVerify(walletStores()).catch(() => null)
  const floored = keepStoredChats(temp, storedPlain, floorOptionsFor(temp))
  const record = (await wrapForDisk(walletStores(), floored as unknown as Loose)) as Loose
  await writeInitObject(record)
  qaRecordCounts('saved', floored)
  cacheStorageBackup(encodeInitRaw(record))
}

const walletStores = (): WalletStores => ({
  readInit: async () => readInitObject(),
  probeInit: async () => readInitObject({ probe: true }),
  // storageHashData verifies the read-back and refreshes the Cache API copy (it holds the wrapped blob only).
  writeInit: (data: Loose) => writeInitObject(data),
  readMeta: async (): Promise<WalletMeta> => {
    const raw = await readDocTitle('meta')
    try {
      const m = raw ? JSON.parse(raw) : null
      if (!m || typeof m !== 'object') return { failures: 0, nextAt: 0 }
      return {
        failures: Number(m.failures) || 0,
        nextAt: Number(m.nextAt) || 0,
        lastFailureMs: Number(m.lastFailureMs) || 0,
        ...(m.walletWrapState === 'wrapped' ? { walletWrapState: 'wrapped' as const } : {}),
      }
    } catch {
      return { failures: 0, nextAt: 0 }
    }
  },
  writeMeta: (m: WalletMeta) => putDocDurable('meta', JSON.stringify(m)),
  // unit f3: the cooldown record per account (PWA IndexedDB, atomic update, read back)
  attemptsFor: (eoa: string) => passcodeAttemptRecordStore(idbKeyValueDb(), eoa),
})

/** Persist: the in-memory wallet is written wrapped (a locked passcode session refuses; see wrapForPersist). */
const encodePersistBlob = async (temp: encrypt_keys_object): Promise<string> =>
  encodeInitRaw(await wrapForDisk(walletStores(), temp as unknown as Loose))

/** Device-key plaintext migration is removed (unit f3, 2026-11-22): no wrap is made here, so the result is always 'none'. */
const runPlainWalletMigration = (): Promise<PlainMigration> => Promise.resolve('none' as const)

/** Result of a passcode operation; `retryAfterMs` is set while a wait applies. */
export type VaultOpResult = { ok: true } | { ok: false; reason: string; retryAfterMs?: number; attempts?: number }

/** Account has a passcode on (wrap records). */
export const walletVaultHasPasscode = async (): Promise<boolean> => {
  try {
    return await passcodeEnabled(walletStores())
  } catch {
    return false
  }
}

/** Unlocks the passcode layer for the stored account. Failed tries are counted and waited on; nothing is erased. */
export const unlockWalletVaultWithPasscode = async (passcode: string): Promise<VaultOpResult> => {
  const res = await unlockWalletPasscode(walletStores(), passcode, Date.now())
  checkStorageInFlight = null
  if (!res.ok) return res
  return { ok: true }
}

/** Turns the passcode on. The caller must have the wallet loaded (the in-memory secrets are what gets wrapped). */
/** The first pwaWalletSync with the cipher and the passcode (set or change). Completed only on the shell's confirmed ok. */
const firstSyncWithPasscode = async (envelope: Loose, passcode: string): Promise<'ok' | 'not_completed'> => {
  const r = await sendPwaWalletSyncCipher('pwaWalletSync', nextShellTxSeq(), envelope, passcode)
  return r.code === 'ok' ? 'ok' : 'not_completed'
}

/**
 * A pending first sync (sync_pending) goes to the app's existing background sync mechanism (passcode/syncPendingHandoff): the passcode is
 * not kept, the cipher carries none, and completion is only the shell's confirmed read-back. No retry is added here.
 */
const handOffPendingSet = (cipher: Loose): void => {
  handOffSyncPending(cipher, String(cipher.eoa ?? ''))
}

export const setWalletVaultPasscode = async (passcode: string): Promise<SetResult> => {
  if (!CoNET_Data?.profiles?.length) return { ok: false, reason: 'error' }
  const res = await setWalletPasscode(walletStores(), passcode, CoNET_Data as unknown as Loose, firstSyncWithPasscode)
  if (!res.ok && res.reason === 'sync_pending') handOffPendingSet(res.cipher)
  checkStorageInFlight = null
  if (res.ok) notifyPasscodeStateChanged()
  return res
}

export const changeWalletVaultPasscode = async (oldPasscode: string, newPasscode: string): Promise<VaultOpResult | SetResult> => {
  const res = await changeWalletPasscode(walletStores(), oldPasscode, newPasscode, Date.now(), firstSyncWithPasscode)
  if (!res.ok && 'reason' in res && res.reason === 'sync_pending') handOffPendingSet(res.cipher)
  checkStorageInFlight = null
  return res
}

export const disableWalletVaultPasscode = async (passcode: string): Promise<VaultOpResult> => {
  // after the plaintext read-back, the plain phrase goes to the shell once, in the background (decision)
  const res = await disableWalletPasscode(walletStores(), passcode, Date.now(), (phrase, eoa) => {
    // background: a throw or a missing answer never reaches the caller (the sync is retried by its own rules)
    void Promise.resolve().then(() => shellMnemonicSync.sync(phrase, eoa)).catch(() => undefined)
  })
  checkStorageInFlight = null
  if (!res.ok) return res
  notifyPasscodeStateChanged()
  return { ok: true }
}

/** Copy of the in-memory wallet without its secrets (the stored wraps stay; wrapForPersist keeps them). */
const withoutSecretsInMemory = (data: encrypt_keys_object): encrypt_keys_object => {
  const { mnemonicPhrase: _m, recoveryWords: _r, ...rest } = data as unknown as Loose
  const profiles = (Array.isArray(data.profiles) ? (data.profiles as unknown[]).flat() : []).map((p) => {
    const q = p as Loose
    return { ...q, privateKeyArmor: undefined, pgpKey: q.pgpKey ? { ...q.pgpKey, privateKeyArmor: undefined } : q.pgpKey }
  })
  return { ...rest, profiles } as unknown as encrypt_keys_object
}

/**
 * Sign out. With a passcode on, the plaintext secrets leave memory and the passcode key is dropped, so the gate asks
 * for the passcode again. Without a passcode the existing sign-out (chat lock only) is unchanged.
 */
export const lockWalletVaultOnLogout = async (): Promise<boolean> => {
  const pc = await walletVaultHasPasscode()
  lockWalletSession()
  // unit e: sign-out drops the previous account's chat unlock record; the chat lock is shown again only when a passcode is on.
  clearChatAccessState(pc)
  if (pc && CoNET_Data) {
    setCoNET_Data(withoutSecretsInMemory(CoNET_Data))
    checkStorageInFlight = null
  }
  return pc
}

/** Explicit reset for "forgot passcode": deletes the local wallet copy so the user can re-import with the recovery phrase. */
export const wipeLocalWalletForRestore = async (): Promise<void> => {
  // Wallet documents only. The device key (IndexedDB 'beamio-vault-v1') is kept: it holds no user data and survives
  // clearing the cache and the local library (implementation note).
  for (const id of ['init', 'meta']) await removeDocIfExists(id)
  try {
    await caches.delete('beamio-wallet-v1')
  } catch {
    /* no Cache API in this context */
  }
  resetWalletSession()
  setCoNET_Data(null)
  checkStorageInFlight = null
  notifyPasscodeStateChanged()
}

let checkStorageInFlight: Promise<CheckStorageResult> | null = null

/**
 * Read the local wallet without collapsing storage failures into "new user".
 *
 * This distinction is important for the Android embedded WebView: a temporary
 * IndexedDB/PouchDB failure must never send an existing wallet to onboarding.
 */
const isPouchMissingDocError = (error: any): boolean => {
  const status = error?.status
  const name = String(error?.name ?? '')
  const message = String(error?.message ?? '')
  return (
    status === 404 ||
    status === '404' ||
    name === 'not_found' ||
    /^not_found/i.test(name) ||
    /^missing$/i.test(message) ||
    (/missing/i.test(message) && /not.?found/i.test(name + message))
  )
}

/** What a store read does to the page (H2): only a start-up read replaces the copy and applies its language. */
const storedReadEffects: StoredReadEffects = {
  setCopy: (data) => {
    // A shell's start-up read replaces the in-memory copy with the page IndexedDB copy. The chat rows the page already holds in memory (history
    // restore, a chat opened this session) are kept: rows are merged by peer address for the same account, never dropped by the replacement.
    if (isShellContext() && data) {
      try {
        setCoNET_Data(keepMemoryChats(data as unknown as encrypt_keys_object, CoNET_Data, floorOptionsFor(data)))
        return
      } catch {
        // an unmergeable memory copy: the stored copy is used as it was before
      }
    }
    setCoNET_Data(data as unknown as encrypt_keys_object | null)
  },
  writeBack: () => void storeSystemData(),
  applyLanguage: async (language) => {
    writeBeamioUiLanguageBootstrap(normalizeBeamioUiLocale(language))
    await applyBeamioUiLanguageFromProfile(language)
  },
}

/**
 * R95: the shell's native side answers no_key, and the raw shell record (if any) has no mnemonic and is not a completed account. Read-only:
 * the raw read is a probe; nothing is written, deleted or regenerated. A read failure (any other answer, or a throw) is false.
 */
const shellNoKeyWithoutMnemonic = async (): Promise<boolean> => {
  try {
    const native = await readWalletEoaAddress()
    if (!(native.kind === 'refused' && native.code === NO_KEY_ERROR)) return false
    const raw = await shellRecordRead({ probe: true, raw: true, source: 'probe' })
    // 0.53.44 (sc): the parser returns a keyless record with no mnemonic as keylessRecord; with native no_key that is no account (11-17 rule)
    if (raw.status === 'error' && raw.keylessRecord) return true
    if (raw.status === 'absent') return true
    if (raw.status !== 'ok') return false
    const rec = raw.record as unknown as encrypt_keys_object
    if (hasLocalPlaintextMnemonic(rec)) return false
    // 2026-11-17 (decision): the shell says no_key and the copy holds no valid mnemonic, so the account is none, even when a BeamioTag was
    // completed earlier. Onboarding; the record is kept (nothing is written or deleted here).
    return true
  } catch {
    return false
  }
}

/** r92 steps 1 and 2: the old PWA store read in a shell (read-only; a timeout is unknown). */
const LEGACY_SHELL_READ_TIMEOUT_MS = 5_000
const readLegacyShellInit = async (): Promise<{ status: 'valid'; data: Loose } | { status: 'absent' } | { status: 'unknown'; reason: 'native_retry' }> => {
  let raw: string | null
  try {
    // the timer is cleared when the read settles (no open handle after the read; 2026-11-22 startupIdbFirst)
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeoutP = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('legacy_timeout')), LEGACY_SHELL_READ_TIMEOUT_MS)
    })
    raw = await Promise.race([readDocTitle('init'), timeoutP]).finally(() => clearTimeout(timer))
  } catch {
    publishNativePwaLog('warn', '[startup] old PWA store not read (failure or timeout): unknown, held, nothing written')
    return { status: 'unknown', reason: 'native_retry' }
  }
  // unit (b): a stored document that cannot be parsed is corrupt, never absent (parseInitRaw returns null for it)
  if (raw && !parseInitRaw(raw)) return { status: 'unknown', reason: 'native_retry' }
  const data = raw ? parseInitRaw(raw) : null
  const decision = decideLegacyInit(data)
  if (decision.status === 'unknown') publishNativePwaLog('warn', '[startup] old PWA store does not match its account: unknown, held, nothing written')
  if (decision.status !== 'valid') return decision.status === 'absent' ? { status: 'absent' } : decision
  return { status: 'valid', data: data as Loose }
}

/**
 * The native side of a shell start (the native record first). Returns `result` when the answer is final (loaded, or a hold), `empty` when
 * the native side confirms there is no account (the old store then decides), or `rec` for the common read (the page copy from the native record).
 */
/** The fallback decision of the last shell start read (2026-11-21): null, 'onboard' (walletEoaAddress no_key) or 'hold'. */

type ShellNativeFirst = { kind: 'result'; result: CheckStorageResult } | { kind: 'empty' } | { kind: 'fallback'; reason: ShellRecordFallbackReason } | { kind: 'rec'; rec: Loose }
const shellNativeFirstRead = async (options: { probe?: boolean }): Promise<ShellNativeFirst> => {
  // Plan N: the native store holds the record; the page sees the sanitized copy. No store means no read (fail closed).
  let rec: Loose | null
  // validatedEoa is set below
  let validatedEoa: string | null = null
  try {
    const read = await shellRecordRead({ ...options, source: options.probe ? 'probe' : 'init' })
    // an answered read (ok or absent) releases a not_ready hold; a not_ready sets it in the catch below (v4 ceilings)
    if (read.status === 'ok' || read.status === 'absent') setShellReadHold('none')
    if (read.status === 'ok' && validatedCopyAccount(read)) {
      rec = read.record
      validatedEoa = read.eoa as string
    } else {
      rec = shellRecordAsWalletRecord(read)
    }
  } catch (err) {
    // a record without the EOA key for the account is the native recovery case (a hold, never onboarding).
    const msg = err instanceof Error ? err.message : String(err)
    const readReason = shellStorageErrorReason(msg)
    // the hold follows this answer: a not_ready keeps its ceiling; any other answered reply (origin_refused, bad_request, a record error…) releases it
    setShellReadHold(readReason === 'native_not_ready_bounded' ? 'bounded' : readReason === 'native_not_ready_final' ? 'final' : 'none')
    if (isUntrustedSourceAnswer(msg)) {
      // the shell refused the page as untrusted. Nothing is read from the page store, entered, onboarded or written: a wait.
      publishNativePwaLog('warn', '[startup] shell refused the page (untrusted_source): wait and retry; page store not read, nothing entered or written')
    }
    // 2026-11-21 (review): a definite fallback (shellRecordRead not_supported / unknown_command) is decided before walletEoaAddress is
    // consulted, so the fallback path never reads walletEoaAddress.
    const isFallback = nativeRecordFallbackOf(msg) !== null
    // R95: the native side answers no_key and the record has no mnemonic: both sides confirm no account, so the read is empty.
    // Read-only; a completed account, a mnemonic, or any other answer keeps the state below.
    // untrusted_source () is never an empty account: no native no_key check is made for it either.
    const shellEmpty = isFallback || isUntrustedSourceAnswer(msg) ? false : await shellNoKeyWithoutMnemonic()
    // r92 step 4: the inputs of the decision, status codes only (no record, key or value)
    publishNativePwaLog('info', `[startup] decision inputs: store=error(${diagnosticCode(msg.replace(/^shell_record_/, ''))}) native_empty=${shellEmpty}`)
    if (shellEmpty) return { kind: 'empty' }
    // 2026-11-21: the shell does not support the native record command (a definite old shell): no native record, so the page store is read next.
    const fallback = nativeRecordFallbackOf(msg)
    if (fallback) return { kind: 'fallback', reason: fallback.reason }
    // the store is not ready yet (migrating, import not done): a wait and a retry, never onboarding and never the old store.
    return { kind: 'result', result: { status: 'unavailable', reason: shellStorageErrorReason(msg) } }
  }
  if (validatedEoa !== null && rec) {
    // draft 21.8 step 1: the copy is validated natively. The native account must be this account (no_key is the expected answer
    // here; the page never answers onboarding for it). This branch does not derive a key; a key held by another path is not decided here.
    const native = await readWalletEoaAddress().catch(() => ({ kind: 'refused' as const, code: 'error' }))
    if (native.kind === 'address' && native.eoa !== validatedEoa) return { kind: 'result', result: { status: 'unavailable', reason: 'eoa_mismatch' } }
    if (native.kind === 'refused' && native.code !== NO_KEY_ERROR) return { kind: 'result', result: { status: 'unavailable', reason: 'native_retry' } }
    publishNativePwaLog('info', `[startup] shell copy validated natively (native ${native.kind === 'address' ? 'address' : native.code}): entered, synced after entry`)
    const validated = injectShellSessionKey(rec)
    await commitStoredRead(options, { cleaned: validated, hadPeerPrivateArmored: false }, storedReadEffects)
    return { kind: 'result', result: { status: 'loaded', data: validated as unknown as encrypt_keys_object, copyValidated: true } }
  }
  // the record is returned only when its account is the native account and it holds a credential. A refusal or a timeout
  // is a retry; a different account is never used.
  if (rec) {
    const native = await readWalletEoaAddress().catch(() => ({ kind: 'refused' as const, code: 'error' }))
    // a page copy exists and the native layer answers no_key: the native key is missing. Recovery only (no retry loop, no onboarding).
    if (native.kind === 'refused' && native.code === NO_KEY_ERROR) {
      // R94: a key-only copy with no mnemonic, and the native side answering no_key, is no account: empty.
      if (!hasLocalPlaintextMnemonic(rec as unknown as encrypt_keys_object) || isKeyOnlyCopyWithoutMnemonic(rec as unknown as encrypt_keys_object)) return { kind: 'empty' }
      return { kind: 'result', result: { status: 'unavailable', reason: 'native_recovery_needed' } }
    }
    const state = shellRecordReadState(rec, native)
    if (state.kind === 'unavailable') return { kind: 'result', result: { status: 'unavailable', reason: state.reason } }
    if (state.kind === 'not_account') return { kind: 'empty' }
    // the page-session key of this account, when one is held, is on the in-memory copy only (the write strips it)
    rec = injectShellSessionKey(rec)
  }
  if (!rec) return { kind: 'empty' }
  return { kind: 'rec', rec }
}

const readStorageWithStatus = async (allowMigration = true, options: { probe?: boolean } = {}): Promise<CheckStorageResult> => {
  try {
    let data: encrypt_keys_object
    if (isShellContext() && !options.probe) {
      // Unit (b), the decision: the page's own IndexedDB is read first and on its own. A native not_ready, lock or
      // refusal does not block it, and a valid mnemonic here enters the home without any native read (the native side is a background
      // sync target). Absent means the native pre-read decides (the gate asks it only then). Unknown is held: nothing is entered or written.
      const page = await readPageIdbInit()
      if (page.status === 'unknown') {
        publishNativePwaLog('warn', `[startup] page IndexedDB read unknown (${page.reason}): held, nothing entered, written or deleted`)
        return { status: 'unavailable', reason: 'native_retry' }
      }
      if (page.status === 'absent') return { status: 'empty' }
      const entered = injectShellSessionKey(stripLegacyChatContainers(page.data))
      await commitStoredRead(options, { cleaned: entered, hadPeerPrivateArmored: false }, storedReadEffects)
      publishNativePwaLog('info', '[startup] page IndexedDB mnemonic valid: entered on the page record; native reads are not needed at start')
      return { status: 'loaded', data: entered as unknown as encrypt_keys_object }
    }
    if (isShellContext()) {
      // 0.53.39, rule (read order for the shell start): the native record first. The old PWA store is read only when the
      // native side confirms there is no account (empty). A native unknown or failure is a hold (retried), never a fallback to the old store,
      // and nothing is written from it. The old store is never rewritten by this read.
      const nativeFirst = await shellNativeFirstRead(options)
      if (nativeFirst.kind === 'result') return nativeFirst.result
      // r92 steps 1 and 2 (24.1, 24.5): the old store is read after the native answer (never before, never instead of a hold). A valid mnemonic
      // for this account enters it; unknown is a hold; absent means no old account.
      const legacy = await readLegacyShellInit()
      if (legacy.status === 'unknown') return { status: 'unavailable', reason: legacy.reason }
      if (legacy.status === 'valid') {
        // the native record of the same account is newer and authoritative: it is used, and the old store is not
        // entered over it. A different account (or no native record) keeps the r94 entry, as before.
        const legacyEoa = String((legacy.data.profiles as Loose[] | undefined)?.[0]?.keyID ?? '').toLowerCase()
        const nativeEoa = nativeFirst.kind === 'rec' ? String((nativeFirst.rec.profiles as Loose[] | undefined)?.[0]?.keyID ?? '').toLowerCase() : ''
        if (!(nativeFirst.kind === 'rec' && nativeEoa !== '' && nativeEoa === legacyEoa)) {
          // the page copy is cleaned like the native read (no PGP container); the old store itself is not changed
          const entered = injectShellSessionKey(stripLegacyChatContainers(legacy.data))
          await commitStoredRead(options, { cleaned: entered, hadPeerPrivateArmored: false }, storedReadEffects)
          publishNativePwaLog('info', '[startup] account read from the old PWA store; the native sync follows the entry')
          return { status: 'loaded', data: entered as unknown as encrypt_keys_object }
        }
      }
      if (nativeFirst.kind === 'empty') return { status: 'empty' }
      if (nativeFirst.kind === 'fallback') {
        // the decision (2026-11-21): the shell's native record command is definitely absent. The page store was read above:
        // here it is absent (an unknown answer returned earlier). A confirmed empty page store is the terminal update prompt; nothing
        // is entered, created, recovered, imported or written, and walletEoaAddress is not consulted on this path.
        noteShellRecordFallback(nativeFirst.reason)
        const outcome = fallbackStartOutcome({ legacy: legacy.status })
        publishNativePwaLog('info', `[startup] fallback shell (shellRecordRead ${nativeFirst.reason}): page store ${legacy.status} → ${outcome}`)
        if (outcome === 'terminal') return { status: 'unavailable', reason: OLD_SHELL_UPGRADE_REASON }
        return { status: 'unavailable', reason: 'native_retry' }
      }
      data = nativeFirst.rec as unknown as encrypt_keys_object
    } else {
      const blobCompat = await idbBlobCompatReady()
      if (blobCompat === 'storage_unavailable') return { status: 'unavailable', reason: 'indexeddb' }
      const database = PouchDB(localDatabaseName, { auto_compaction: true })
      let doc: { title?: string }
      try {
        doc = await database.get("init", { latest: true })
      } catch (error: any) {
        // Missing init doc = trusted empty → onboarding. Never "storage unavailable".
        if (isPouchMissingDocError(error)) return { status: 'empty' }
        return { status: 'unavailable', reason: 'indexeddb' }
      }
      // Empty / stub init row has no wallet secrets — treat as first-time empty.
      if (typeof doc.title !== 'string' || !doc.title.trim()) {
        return { status: 'empty' }
      }
      try {
        data = JSON.parse(Buffer.from(doc.title, "base64").toString())
      } catch {
        return { status: 'unavailable', reason: 'invalid_document' }
      }
    }
    if (data == null || typeof data !== 'object') {
      return { status: 'empty' }
    }
    // plaintext secrets are wrapped in place once; on failure the plaintext copy stays in use.
    if (allowMigration && hasPlainSecrets(data as unknown as Loose)) {
      if ((await runPlainWalletMigration()) === 'migrated') return readStorageWithStatus(false, options)
    }
    // Wrapped secrets are opened here. A passcode record reports locked until it is unlocked.
    const opened = await openWalletForStartup(walletStores(), data as unknown as Loose)
    if (opened.status === 'locked') return { status: 'locked' }
    if (opened.status === 'error') return { status: 'unavailable', reason: 'vault_unreadable' }
    data = opened.data as unknown as encrypt_keys_object
    const hydrated = ensureProfilePrivateKeyArmorFromMnemonic(data)
    if (!hydrated) {
      // no EOA key on the record. A completed Beamio account is an existing account without a local key: a browser loads it (recover);
      // a shell holds it (the native recovery case). A trusted empty blob is no account. Anything else is not confirmed empty: it is
      // undetermined (unavailable, retried), never first-time onboarding and never an overwrite.
      // a browser record with a completed BeamioTag but no EOA key is undetermined (retry), not loaded and not onboarding.
      if (hasCompletedBeamioAccount(data)) {
        // Current code (11-17 reading, the recorded rule). A completed Beamio account with no EOA key in a shell
        // is the recovery entry (native_recovery_needed). The owner's reaffirmed rule:
        // a BeamioTag or a legacy address does not change the result; onboarding follows only when the mnemonic is confirmed missing. That change is
        // pending (a product change in the shared record parser), not made here. A trusted blank is onboarding (isTrustedEmptyWalletBlob below).
        return { status: 'unavailable', reason: isShellContext() ? 'native_recovery_needed' : 'invalid_document' }
      }
      if (isTrustedEmptyWalletBlob(data)) {
        // No mnemonic / privateKeyArmor / completed Beamio account → first-time onboarding. A probe does not touch the page copy (H2).
        await commitStoredRead(options, null, storedReadEffects)
        return { status: 'empty' }
      }
      // Current code (11-17 reading, the recorded rule): a shell record with no EOA key is the recovery entry
      // (native_recovery_needed); only isTrustedEmptyWalletBlob above is onboarding. The owner's reaffirmed rule
      // makes onboarding follow a confirmed missing mnemonic; that change is
      // pending, not made here. A browser keeps invalid_document.
      return { status: 'unavailable', reason: isShellContext() ? 'native_recovery_needed' : 'invalid_document' }
    }
    if (isTrustedEmptyWalletBlob(hydrated)) {
      await commitStoredRead(options, null, storedReadEffects)
      return { status: 'empty' }
    }
    // Drop our own PGP private key that old builds copied into peer chats, and write the cleaned data back once (start-up reads only).
    const { data: cleaned, changed: hadPeerPrivateArmored } = stripPeerChatPrivateArmored(hydrated)
    await commitStoredRead(options, { cleaned: cleaned as unknown as Record<string, unknown>, hadPeerPrivateArmored }, storedReadEffects)
    return { status: 'loaded', data: cleaned }
  } catch {
    return { status: 'unavailable', reason: 'indexeddb' }
  }
}

/**
 * Unit (b), the decision: the page's own IndexedDB `init` record, read on its own (no native call). Three states:
 * - valid: the record holds a mnemonic that derives an EOA (opened from its wrap when it is wrapped). The EOA may differ from keyID; the
 *   gate decides that mismatch (a hold), not this read.
 * - absent: the document is missing, or it holds no mnemonic and is a trusted empty blob (a key-only copy is not an account).
 * - unknown: a timeout, a read failure, a locked or unreadable vault, a corrupt document, or a record without a mnemonic that is not empty.
 *   Unknown is never absent: nothing is onboarded, deleted or overwritten on it.
 */
export type PageIdbState =
  | { status: 'valid'; eoa: string; phrase: string; data: Loose }
  | { status: 'absent' }
  | { status: 'unknown'; reason: 'timeout' | 'read_failed' | 'corrupt_record' | 'locked' | 'vault_unreadable' | 'no_mnemonic_record' | 'unrecognized_secret' }

/**
 * The wallet stores for the page's IndexedDB record only (unit (b)): the existing record is the one read from IndexedDB, never the shell
 * record, so the wrap and the open never touch the native store. The device key still comes from the page's own device store.
 */
const pageIdbWalletStores = (existing: Loose | null): WalletStores => ({
  ...walletStores(),
  readInit: async () => existing,
  probeInit: async () => existing,
})

/** Read-only: the key-only test of the page record (see pageRecordKeyState). Never changes readPageIdbInit's answer. */
export const readPageIdbKeyState = async (): Promise<'key_only' | 'unknown'> => {
  let raw: string | null
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const timeoutP = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('idb_timeout')), LEGACY_SHELL_READ_TIMEOUT_MS)
    })
    raw = await Promise.race([readDocTitle('init'), timeoutP]).finally(() => clearTimeout(timer))
  } catch {
    return 'unknown'
  }
  if (raw === null) return 'unknown'
  return classifyPageKeyState(parseInitRaw(raw) as Loose | null)
}

/**
 * The v3 mnemonic envelope of the page's own IndexedDB record, exactly as stored (nothing is decrypted, opened or written). Null when the
 * record is missing, unreadable, or its mnemonic is not an envelope. Used by the passcode unlock sync (M6): the cipher goes to the shell with the
 * passcode just typed.
 */
export const readPageCipherEnvelope = async (): Promise<Record<string, unknown> | null> => {
  let raw: string | null
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const timeoutP = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('idb_timeout')), LEGACY_SHELL_READ_TIMEOUT_MS)
    })
    raw = await Promise.race([readDocTitle('init'), timeoutP]).finally(() => clearTimeout(timer))
  } catch {
    return null
  }
  if (raw === null) return null
  const parsed = parseInitRaw(raw) as Loose | null
  if (!parsed) return null
  const field = pageMnemonicField(parsed)
  return field.kind === 'envelope' ? field.envelope : null
}

export const readPageIdbInit = async (): Promise<PageIdbState> => {
  let raw: string | null
  try {
    // the timer is cleared when the read settles (no open handle after the read; 2026-11-22 startupIdbFirst)
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeoutP = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('idb_timeout')), LEGACY_SHELL_READ_TIMEOUT_MS)
    })
    raw = await Promise.race([readDocTitle('init'), timeoutP]).finally(() => clearTimeout(timer))
  } catch (err) {
    return { status: 'unknown', reason: err instanceof Error && err.message === 'idb_timeout' ? 'timeout' : 'read_failed' }
  }
  if (raw === null) return { status: 'absent' }
  const parsed = parseInitRaw(raw)
  if (!parsed) return { status: 'unknown', reason: 'corrupt_record' }
  let data: Loose = parsed
  if (hasPlainSecrets(parsed)) {
    // a plaintext copy (0.52.930 format): read as it is. No migration write from a startup read.
  } else {
    // a wrapped copy: opened with the page's device key, as the browser start opens it (read-only; no write from here)
    try {
      const opened = await openWalletForStartup(pageIdbWalletStores(parsed), parsed)
      if (opened.status === 'locked') return { status: 'unknown', reason: 'locked' }
      if (opened.status === 'error') return { status: 'unknown', reason: 'vault_unreadable' }
      data = opened.data as Loose
    } catch {
      return { status: 'unknown', reason: 'vault_unreadable' }
    }
  }
  const phrase = typeof data.mnemonicPhrase === 'string' ? data.mnemonicPhrase.trim() : ''
  if (!phrase) {
    if (isTrustedEmptyWalletBlob(data as encrypt_keys_object)) {
      // A record that holds a non-empty secret-class field the reader did not recognise is not empty: unknown, never absent
      if (hasUnrecognizedSecret(data as encrypt_keys_object)) return { status: 'unknown', reason: 'unrecognized_secret' }
      return { status: 'absent' }
    }
    return { status: 'unknown', reason: 'no_mnemonic_record' }
  }
  const eoa = validMnemonicEoa(data as encrypt_keys_object)
  if (!eoa) return { status: 'unknown', reason: 'corrupt_record' }
  return { status: 'valid', eoa, phrase, data }
}

/**
 * Unit (b): the write-back of a mnemonic that the native pre-read returned for this account (the decision rule 4). The record is written
 * to the page's own IndexedDB in the existing format (wrapForDisk, then the durable put). Verified only by an independent read of the mnemonic
 * from IndexedDB whose derived address equals the account. A shell record read, an address read or a generic record read-back is not evidence.
 * A valid mnemonic of another account in IndexedDB is refused (nothing written); an unknown read before the write is not overwritten.
 */
export type PageIdbWriteResult = 'verified' | 'refused_other_account' | 'unknown_before' | 'write_failed' | 'readback_absent' | 'readback_unknown' | 'readback_mismatch'

/**
 * M6, entry (b) (the shell answered a ciphertext pre-read and the page decrypted it with the passcode just typed): the page's own IndexedDB gets the
 * account as a PASSCODE record (the v3 envelope in `mnemonicPhrase`, the other secrets wrapped under the same passcode key), never the plaintext
 * phrase. The plaintext lives only in memory (the record argument and the unlocked session). The first pwaWalletSync{eoa, cipher, passcode, seq}
 * is sent inside this call, once; a sync that is not confirmed is handed to the background mechanism (the record is already written and read back).
 * A refusal, a weak passcode, a failed write or a failed read-back writes nothing readable as plaintext and clears nothing. `verified` means the
 * read-back is the envelope of this account.
 */
export const persistPageIdbPasscodeRecord = async (record: Loose, phrase: string, eoa: string, passcode: string): Promise<PageIdbWriteResult> => {
  const want = eoa.trim().toLowerCase()
  const before = await readPageIdbInit()
  if (before.status === 'unknown') return 'unknown_before'
  if (before.status === 'valid' && before.eoa !== want) return 'refused_other_account'
  const pageStores: WalletStores = {
    ...walletStores(),
    readInit: async () => {
      const raw = await readDocTitle('init')
      return raw ? parseInitRaw(raw) : null
    },
    probeInit: async () => {
      const raw = await readDocTitle('init')
      return raw ? parseInitRaw(raw) : null
    },
    writeInit: async (data: Loose) => {
      const raw = await readDocTitle('init')
      assertStoredSecretsKept(((raw ? parseInitRaw(raw) : null) ?? {}) as Loose, data)
      await putDocDurable('init', encodeInitRaw(data))
    },
  }
  let res: SetResult
  try {
    res = await setWalletPasscode(pageStores, passcode, record, firstSyncWithPasscode)
  } catch {
    return 'write_failed'
  }
  if (!res.ok && res.reason === 'sync_pending') handOffPendingSet(res.cipher)
  else if (!res.ok) return 'write_failed'
  const env = await readPageCipherEnvelope()
  if (!env) return 'readback_absent'
  void phrase
  return String(env.eoa ?? '').toLowerCase() === want ? 'verified' : 'readback_mismatch'
}

export const persistPageIdbMnemonic = async (record: Loose, phrase: string, eoa: string): Promise<PageIdbWriteResult> => {
  const want = eoa.trim().toLowerCase()
  const before = await readPageIdbInit()
  if (before.status === 'unknown') return 'unknown_before'
  if (before.status === 'valid' && before.eoa !== want) return 'refused_other_account'
  // the existing stored document (IndexedDB, as it is) keeps the stored secrets on the wrap; a read that fails was refused above
  let existing: Loose | null = null
  try {
    const raw = await readDocTitle('init')
    existing = raw ? parseInitRaw(raw) : null
  } catch {
    return 'unknown_before'
  }
  try {
    const wrapped = (await wrapForDisk(pageIdbWalletStores(existing), record as Loose)) as Loose
    await putDocDurable('init', encodeInitRaw(wrapped))
  } catch {
    return 'write_failed'
  }
  const back = await readPageIdbInit()
  if (back.status === 'absent') return 'readback_absent'
  if (back.status === 'unknown') return 'readback_unknown'
  return back.eoa === want && back.phrase === phrase.trim() ? 'verified' : 'readback_mismatch'
}

/** A read for a user action that does not feed the page copy (H2): a probe in the shell, so it does not move the write basis. */
let checkStorageProbeInFlight: Promise<CheckStorageResult> | null = null
export const checkStorageWithStatus = (options: { probe?: boolean } = {}): Promise<CheckStorageResult> => {
  if (options.probe) {
    if (checkStorageProbeInFlight) return checkStorageProbeInFlight
    const probe = readStorageWithStatus(true, { probe: true })
    checkStorageProbeInFlight = probe
    probe.then(
      () => {
        if (checkStorageProbeInFlight === probe) checkStorageProbeInFlight = null
      },
      () => {
        if (checkStorageProbeInFlight === probe) checkStorageProbeInFlight = null
      },
    )
    return probe
  }
  // A slow IndexedDB read must not be duplicated by the retry path.
  if (checkStorageInFlight) return checkStorageInFlight
  const read = readStorageWithStatus()
  checkStorageInFlight = read
  void read.then((r) => { if (r.status === 'loaded') qaRecordCounts('read', r.data); else if (process.env.REACT_APP_QA_BRIDGE_COUNTER === 'true') qaLine('[persist]', `read status=${String((r as { status?: unknown }).status)} store=init`) }, (e) => { if (process.env.REACT_APP_QA_BRIDGE_COUNTER === 'true') qaLine('[persist]', `read failed name=${qaErrorName(e)} code=${qaErrorCode(e)} store=init`) })
  read.then(
    () => {
      if (checkStorageInFlight === read) checkStorageInFlight = null
    },
    () => {
      if (checkStorageInFlight === read) checkStorageInFlight = null
    },
  )
  return read
}

export const checkStorage = async (options: { probe?: boolean } = {}) => {
  const result = await checkStorageWithStatus(options)
  return result.status === 'loaded' ? result.data : null
}

/** Safari 私密浏览等环境 IndexedDB 可能永不 resolve；超时按「无本地钱包」处理。 */
export const CHECK_STORAGE_TIMEOUT_MS = 8_000

export async function checkStorageWithTimeout(
  timeoutMs = CHECK_STORAGE_TIMEOUT_MS,
): Promise<encrypt_keys_object | null> {
  if (typeof window === 'undefined') return null
  return Promise.race([
    checkStorageWithStatus().then((result) => result.status === 'loaded' ? result.data : null),
    new Promise<null>((resolve) => {
      window.setTimeout(() => resolve(null), timeoutMs)
    }),
  ])
}

/** The onboarding gate's answer: a record, null (confirmed empty), or WALLET_STORAGE_HOLD (any other status). */
export const WALLET_STORAGE_HOLD = 'hold' as const

/**
 * The read that may lead to onboarding. Only a confirmed-empty store (`empty`) gives null; any other status (unavailable, timeout, a
 * bad record) gives WALLET_STORAGE_HOLD, and the caller must not onboard. 2026-11-17 (runtime/review): the browser used to fold a
 * timeout into null here, which read as "no wallet" and sent a private-mode browser to onboarding. Both contexts now hold.
 */
export async function readWalletRecordForOnboardingGate(
  timeoutMs = CHECK_STORAGE_TIMEOUT_MS,
): Promise<encrypt_keys_object | null | typeof WALLET_STORAGE_HOLD> {
  const r = await checkStorageWithStatusWithTimeout(timeoutMs)
  if (r.status === 'loaded') return r.data
  if (r.status === 'empty') return null
  return WALLET_STORAGE_HOLD
}

export async function checkStorageWithStatusWithTimeout(
  timeoutMs = CHECK_STORAGE_TIMEOUT_MS,
): Promise<CheckStorageResult> {
  if (typeof window === 'undefined') return { status: 'unavailable', reason: 'indexeddb' }
  return raceCheckStorageWithTimeout(checkStorageWithStatus(), timeoutMs)
}

/**
 * Races one read the caller holds with a limit. The read itself is never cancelled by the limit. Browser: a timed-out shared in-flight
 * is dropped so Retry / remount can start a fresh read (an IndexedDB read has no cap). Shell (0.53.44): the in-flight read is kept; its
 * native request is capped at 30 s, and a retry awaits the same request.
 */
function raceCheckStorageWithTimeout(read: Promise<CheckStorageResult>, timeoutMs: number): Promise<CheckStorageResult> {
  return Promise.race([
    read,
    new Promise<CheckStorageResult>((resolve) => {
      window.setTimeout(() => {
        if (!isShellContext() && checkStorageInFlight === read) checkStorageInFlight = null
        resolve({ status: 'unavailable', reason: 'timeout' })
      }, timeoutMs)
    }),
  ])
}

/**
 * iOS WebViews can briefly reject IndexedDB/PouchDB reads while a newly
 * promoted embedded bundle is settling. Retry only transient read failures;
 * malformed wallet documents remain a hard failure. The read itself is
 * single-flight, so retries never create concurrent PouchDB operations.
 */
export async function checkStorageWithTransientRetry(
  timeoutMs = 5_000,
  maxAttempts = 2,
): Promise<CheckStorageResult> {
  // unit (c), 2026-11-22: in the shell this call keeps the read it started by reference. The module-level in-flight slot is cleared by
  // other paths (a write, a passcode or a reset) while the native request is open; a retry or the final await that re-reads that slot
  // would then miss the read, and its late ok (for example at 12 s) would be dropped. Every attempt races this same read.
  const shell = isShellContext()
  let shellRead: Promise<CheckStorageResult> | null = null
  const attempt = (): Promise<CheckStorageResult> => {
    if (typeof window === 'undefined') return Promise.resolve({ status: 'unavailable', reason: 'indexeddb' })
    if (!shell) return checkStorageWithStatusWithTimeout(timeoutMs)
    if (shellRead === null) shellRead = checkStorageWithStatus()
    return raceCheckStorageWithTimeout(shellRead, timeoutMs)
  }
  let result = await attempt()
  for (let round = 1; round < maxAttempts; round += 1) {
    if (
      result.status !== 'unavailable' ||
      result.reason === 'invalid_document' ||
      result.reason === 'native_recovery_needed' ||
      result.reason === 'native_not_ready_bounded' ||
      result.reason === 'native_not_ready_final'
    ) {
      return result
    }
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, 350 * round)
    })
    result = await attempt()
  }
  // 0.53.44: in the shell, a read whose native request is still open after the races is awaited to its answer. The request is capped
  // by the native side (30 s), so a late ok (for example at 11 s) is taken by this start instead of being lost.
  if (shell && result.status === 'unavailable' && result.reason === 'timeout' && shellRead !== null) {
    result = await shellRead
  }
  return result
}

/** Cache 用的绝对 URL（Safari / PWA 路径不同，必须用 origin 级别 key 确保一致）
 * 注意：iOS 上 Cache API 与 IndexedDB 同样与 Safari 隔离，PWA 无法读取。仅对 Android 等平台可能有效。 */
const CACHE_WALLET_URL = typeof window !== 'undefined'
  ? new URL('/__beamio_wallet_backup__', window.location.origin).href
  : ''

/** 写入 Cache Storage（iOS Safari→PWA 迁移备份，Cache API 在部分环境下共享） */
const cacheStorageBackup = async (data: string) => {
  try {
    if (typeof caches === 'undefined' || !CACHE_WALLET_URL) return
    const cache = await caches.open('beamio-wallet-v1')
    const req = new Request(CACHE_WALLET_URL, { method: 'GET' })
    await cache.put(req, new Response(data, { headers: { 'Content-Type': 'text/plain' } }))
  } catch (_) {}
}

/**
 * Durable write of Base64 wallet blob into PouchDB `"conet"` at `_id: init`.
 * Must throw on failure — silent return previously left Welcome success with empty IndexedDB
 * so clearing deep-link params + refresh re-entered onboarding.
 */
const storageHashData = async (docId: string, data: string) => {
  await idbBlobCompatReady()
  const database = PouchDB(localDatabaseName, { auto_compaction: true })
  const isConflict = (ex: any) =>
    ex?.status === 409 || ex?.status === '409' || String(ex?.name ?? '').toLowerCase() === 'conflict'

  let lastError: unknown = null
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      let existingRev: string | undefined
      try {
        const doc = await database.get(docId, { latest: true })
        existingRev = typeof doc?._rev === 'string' ? doc._rev : undefined
      } catch (getEx: any) {
        if (!isPouchMissingDocError(getEx)) throw getEx
        existingRev = undefined
      }

      // Always `put` with a known `_id`. Never `post` — post can soft-fail or leave no
      // document at `init`, so `get("init")` stays empty after refresh.
      if (existingRev) {
        await database.put({ _id: docId, title: data, _rev: existingRev })
      } else {
        await database.put({ _id: docId, title: data })
      }

      // Round-trip verify before claiming success.
      const written = await database.get(docId, { latest: true })
      if (typeof written?.title !== 'string' || written.title !== data) {
        throw new Error(`[storageHashData] verify mismatch for ${docId}`)
      }
      await cacheStorageBackup(data)
      return
    } catch (ex: any) {
      lastError = ex
      if (isConflict(ex)) {
        await new Promise((r) => setTimeout(r, 30 + attempt * 40))
        continue
      }
      // the error name and status only (a library error text is not printed: it could name a document or a value)
      console.warn(`[storageHashData] Error: name=${/^[A-Za-z_]{1,40}$/.test(String(ex?.name)) ? String(ex?.name) : 'other'} status=${Number(ex?.status) || 0}`)
      throw ex instanceof Error ? ex : new Error(String(ex?.message ?? ex ?? 'storageHashData failed'))
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`[storageHashData] conflict retries exhausted for ${docId}`)
}

const ensureFlatProfiles = (p: any): profile[] => {
  if (!p || !Array.isArray(p)) return []
  if (p.length === 0) return []
  const first = p[0]
  if (Array.isArray(first)) return p.flat()
  return p
}

let storeSystemDataTimer: ReturnType<typeof setTimeout> | null = null
/** Callers of storeSystemDataAndWait whose state the next write will include. */
let storeSystemDataWaiters: Array<(stored: boolean) => void> = []

/**
 * 0.53.44 (PART 2): the session write gate. It is the one state every app-side page-store save consults (storeSystemData, its timer,
 * flushStoreSystemData; persistAndVerifyLocalWallet goes through the flush). Closed by default. AppEntryGate opens it at the three
 * entry points only (page valid mnemonic, native restore read back consistent, new account created) and closes it on every hold.
 * While closed a save is discarded, not queued: the counter and the code are recorded, and its waiters resolve false.
 * Chosen as a module state (not a React state) because the savers are plain service functions outside React.
 */
export type PageWritePermit =
  | 'page_valid_mnemonic'
  | 'native_restore'
  | 'new_account_created'
  | 'native_wallet_present'
  | 'recovery_completed'
  | 'browser_key_only_established'
let pageWritePermit: PageWritePermit | null = null
/**
 * Open only between allowRestoreWrite and endRestoreWriteWindow: the restore write that completes a restore (a native restore, a pre-read
 * adoption, a recovery or an onboarding restore). The gate opens on the read-back of that write, never by the window itself.
 */
let restoreWriteWindow = false
let pageWriteDiscarded = 0
let pageWriteLastDiscardCode: string | null = null
let pageRecordOverwriteRefused = 0

/** AppEntryGate sets the permit (null = closed). */
export const setPageWritePermit = (permit: PageWritePermit | null): void => {
  if (process.env.REACT_APP_QA_BRIDGE_COUNTER === 'true' && pageWritePermit !== permit) qaLine('[persist]', `gate permit=${permit ?? 'none'}`)
  pageWritePermit = permit
}

/** QA builds only: the number of chat rows and of messages of a record, with the permit kind of the moment. Integers and an enum only. */
const qaRecordCounts = (tag: string, data: unknown): void => {
  if (process.env.REACT_APP_QA_BRIDGE_COUNTER !== 'true') return
  const profiles = (data as { profiles?: unknown } | null)?.profiles
  const chats = Array.isArray(profiles) && Array.isArray((profiles[0] as { chats?: unknown } | undefined)?.chats) ? ((profiles[0] as { chats: unknown[] }).chats) : []
  const messages = chats.reduce<number>((n, c) => n + (Array.isArray((c as { messages?: unknown })?.messages) ? (c as { messages: unknown[] }).messages.length : 0), 0)
  if (process.env.REACT_APP_QA_BRIDGE_COUNTER === 'true') qaLine('[persist]', `${tag} chats=${chats.length} messages=${messages} permit=${pageWritePermit ?? 'none'}`)
}

/** Diagnostics: the gate state, the number of discarded saves and the code of the last discard. Never record content. */
export const pageWriteGateStatus = (): {
  open: boolean
  permit: PageWritePermit | null
  discarded: number
  lastDiscardCode: string | null
  overwriteRefused: number
} => ({
  open: pageWritePermit !== null,
  permit: pageWritePermit,
  discarded: pageWriteDiscarded,
  lastDiscardCode: pageWriteLastDiscardCode,
  overwriteRefused: pageRecordOverwriteRefused,
})

/** Consulted by every save. true: the save may go on. false: the save is discarded here (counted and coded). */
export const consultPageWriteGate = (code: string): boolean => {
  if (pageWritePermit !== null || restoreWriteWindow) return true
  pageWriteDiscarded += 1
  pageWriteLastDiscardCode = code
  if (process.env.REACT_APP_QA_BRIDGE_COUNTER === 'true') qaLine('[persist]', `not_saved reason=gate_closed code=${code} permit=none`)
  console.warn(`[pageWriteGate] save discarded (${code}): the page write gate is closed`)
  return false
}

/**
 * Opens the restore write window: the one write that completes a restore may save while the gate is closed. Callers close it with
 * endRestoreWriteWindow right after that write has resolved; the gate itself opens only after the read-back is consistent.
 */
export const allowRestoreWrite = (): void => {
  restoreWriteWindow = true
}

export const endRestoreWriteWindow = (): void => {
  restoreWriteWindow = false
}

const takeStoreSystemDataWaiters = (): Array<(stored: boolean) => void> => {
  const waiters = storeSystemDataWaiters
  storeSystemDataWaiters = []
  return waiters
}

/**
 * Persist CoNET_Data. Heavy JSON.stringify + base64 MUST run inside the deferred
 * timer — doing it synchronously froze the UI for seconds after chat history
 * restore / large profile writes ("app frozen ~10s after launch").
 * Resolves at once; the write happens later. Use storeSystemDataAndWait to
 * know when it has landed.
 */
export const storeSystemData = async () => {
  if (!consultPageWriteGate('closed_at_call')) {
    takeStoreSystemDataWaiters().forEach((done) => done(false))
    return
  }
  if (!CoNET_Data) {
    takeStoreSystemDataWaiters().forEach((done) => done(false))
    return
  }
  if (storeSystemDataTimer) clearTimeout(storeSystemDataTimer)
  storeSystemDataTimer = setTimeout(async () => {
    storeSystemDataTimer = null
    // This write includes everything set so far; later callers wait for the next one.
    const waiters = takeStoreSystemDataWaiters()
    // the gate is consulted again at write time: a hold that closed it meanwhile discards this save as well.
    if (!consultPageWriteGate('closed_at_write')) {
      waiters.forEach((done) => done(false))
      return
    }
    if (!CoNET_Data) {
      waiters.forEach((done) => done(false))
      return
    }
    let stored = false
    try {
      const temp = { ...CoNET_Data }
      // Boundary: the PWA keeps its own account record in its store in a shell, as before.
      if (temp.profiles) temp.profiles = profilesForPersist(ensureFlatProfiles(temp.profiles))
      if ((CoNET_Data as any)?.cardRedeems) (temp as any).cardRedeems = (CoNET_Data as any).cardRedeems
      await persistInitRecord(temp)
      stored = true
    } catch (ex) {
      if (process.env.REACT_APP_QA_BRIDGE_COUNTER === 'true') qaLine('[persist]', `not_saved reason=${ex instanceof Error && ex.message === CHATS_FLOOR_REFUSED ? 'chats_floor' : 'write_failed'} code=${qaErrorCode(ex)} name=${qaErrorName(ex)} stage=${qaPersistStageNow()}`)
      console.warn(`[storeSystemData] Error:`, ex)
      // 0.53.44: a refused overwrite is final for this save. One attempt, no retry notice (a retry would be refused the same way).
      if (!(ex instanceof Error && ex.message === PAGE_RECORD_OVERWRITE_REFUSED)) {
        // 0.53.39 (item 3): the save did not complete; the notice shows it and offers a retry (no record is shown)
        setPersistFailed()
      }
    }
    if (stored) clearPersistFailed()
    waiters.forEach((done) => done(stored))
  }, 200)
}

// the notice's retry runs the same debounced save again (registered once, at module load)
setPersistRetry(() => {
  void storeSystemData()
})

/**
 * Same debounced write as storeSystemData, but resolves only once the data
 * has been written (true) or the write failed (false).
 */
/**
 * Profiles as stored in the PouchDB `init` document (read back after a write, check).
 * Returns null when the document is missing or unreadable. Never logs the content.
 */
export const readStoredProfilesForVerify = async (): Promise<unknown[] | null> => {
  try {
    if (isShellContext()) {
      // In a shell the page's chat rows (and the verified fingerprint in them) live in the page IndexedDB copy; the native record does not take
      // chat rows. The send gate and the read-back therefore read the page copy. A read that does not answer valid is null (the safe side).
      const page = await readPageIdbInit()
      return page.status === 'valid' && Array.isArray(page.data.profiles) ? ensureFlatProfiles(page.data.profiles) : null
    }
    const plain = await readPlainForVerify(walletStores())
    return plain && Array.isArray(plain.profiles) ? ensureFlatProfiles(plain.profiles) : null
  } catch {
    return null
  }
}

/** The stored record as plain data, for the read-back of a restored mnemonic (1c). Null when unreadable. Never logs the content. */
export const readStoredRecordForVerify = async (): Promise<Loose | null> => {
  try {
    return await readPlainForVerify(walletStores())
  } catch {
    return null
  }
}

export const storeSystemDataAndWait = (): Promise<boolean> =>
  new Promise<boolean>((resolve) => {
    storeSystemDataWaiters.push(resolve)
    void storeSystemData()
  })

/** 立即将当前 CoNET_Data 写入存储（用于 cardRedeems 等需马上落盘的数据），并取消待执行的 storeSystemData 定时器 */
export const flushStoreSystemData = async () => {
  if (storeSystemDataTimer) {
    clearTimeout(storeSystemDataTimer)
    storeSystemDataTimer = null
  }
  // The cancelled timer's waiters ride on this write.
  const waiters = takeStoreSystemDataWaiters()
  if (!consultPageWriteGate('closed_at_flush')) {
    waiters.forEach((done) => done(false))
    return
  }
  if (!CoNET_Data) {
    waiters.forEach((done) => done(false))
    return
  }
  try {
    const temp = { ...CoNET_Data }
    if (temp.profiles) temp.profiles = profilesForPersist(ensureFlatProfiles(temp.profiles))
    if ((CoNET_Data as any)?.cardRedeems) (temp as any).cardRedeems = (CoNET_Data as any).cardRedeems
    // Drop any in-flight checkStorage so the next read sees this write.
    checkStorageInFlight = null
    await persistInitRecord(temp)
  } catch (ex) {
    waiters.forEach((done) => done(false))
    throw ex
  }
  waiters.forEach((done) => done(true))
}

/**
 * Flush mnemonic + privateKeyArmor + beamio.accountName to IndexedDB `"conet"`,
 * then re-read and verify. Call after Create Beamio ID / before Welcome so
 * stripping deep-link params + refresh still enters the app.
 */
export const persistAndVerifyLocalWallet = async (
  expectedAccountName?: string,
): Promise<encrypt_keys_object> => {
  if (!CoNET_Data?.profiles?.length) {
    throw new Error('[persistAndVerifyLocalWallet] CoNET_Data is empty')
  }
  const tagWanted = (expectedAccountName || CoNET_Data.beamio?.accountName || '')
    .trim()
    .replace(/^@+/, '')
  if (tagWanted) {
    const existing = (CoNET_Data.beamio?.accountName || '').trim().replace(/^@+/, '')
    if (!existing) {
      CoNET_Data.beamio = buildMinimalBeamioFromAccountName(tagWanted)
      setCoNET_Data(CoNET_Data)
    }
  }
  if (!hasLocalPlaintextMnemonic(CoNET_Data)) {
    throw new Error('[persistAndVerifyLocalWallet] missing mnemonicPhrase')
  }
  await flushStoreSystemData()

  checkStorageInFlight = null
  // the re-read checks the write; it does not move the copy basis (a probe in the shell).
  const result = await readStorageWithStatus(true, { probe: true })
  if (result.status !== 'loaded' || !result.data) {
    throw new Error(
      `[persistAndVerifyLocalWallet] re-read failed: ${result.status}${
        result.status === 'unavailable' ? `:${result.reason}` : ''
      }`,
    )
  }
  const loaded = result.data
  if (!hasLocalPlaintextMnemonic(loaded)) {
    throw new Error('[persistAndVerifyLocalWallet] IndexedDB missing mnemonicPhrase')
  }
  // 2026-11-17: the read-back must be the same account that was saved (keyID / EOA), not just any record with the fields.
  const savedKey = String(CoNET_Data.profiles?.[0]?.keyID ?? '').trim().toLowerCase()
  const readKey = String(loaded.profiles?.[0]?.keyID ?? '').trim().toLowerCase()
  if (!savedKey || readKey !== savedKey) {
    throw new Error('[persistAndVerifyLocalWallet] IndexedDB account mismatch')
  }
  if (tagWanted && !hasCompletedBeamioAccount(loaded)) {
    throw new Error('[persistAndVerifyLocalWallet] IndexedDB missing beamio.accountName')
  }
  setCoNET_Data(loaded)
  return loaded
}


export const MobileType = () => {
	const iOS = 'ios'
	const android = 'android'
	const deskyop = 'desktop'
	const ua = navigator.userAgent
	const platform = navigator.platform
	const macLike = /Macintosh/i.test(platform)
	const touch = navigator.maxTouchPoints && navigator.maxTouchPoints > 1

	if (/iPhone|iPad|iPod/i.test(ua)) return iOS
	if (macLike && touch) return iOS
	if (/Android/i.test(ua)) return android

	return deskyop
}

export const isStandalone = (() => {
	try {
		// Android / Desktop PWA
		if (typeof window !== 'undefined' && window.matchMedia?.('(display-mode: standalone)').matches) {
			return true
		}
		// iOS Safari PWA (added to home screen)
		if (typeof navigator !== 'undefined' && (navigator as any).standalone === true) {
			return true
		}
	} catch {}
	return false
})()


export const aesGcmEncrypt = async (plaintext: string, password: string) => {
	const pwUtf8 = new TextEncoder().encode(password)                                 // encode password as UTF-8
	const pwHash = await crypto.subtle.digest('SHA-256', pwUtf8)                      // hash the password

	const iv = crypto.getRandomValues(new Uint8Array(12))                             // get 96-bit random iv
	const ivStr = Array.from(iv).map(b => String.fromCharCode(b)).join('')            // iv as utf-8 string

	const alg = { name: 'AES-GCM', iv: iv }                                           // specify algorithm to use

	const key = await crypto.subtle.importKey('raw', pwHash, alg, false, ['encrypt']) // generate key from pw

	const ptUint8 = new TextEncoder().encode(plaintext)                               // encode plaintext as UTF-8
	const ctBuffer = await crypto.subtle.encrypt(alg, key, ptUint8)                   // encrypt plaintext using key

	const ctArray = Array.from(new Uint8Array(ctBuffer))                              // ciphertext as byte array
	const ctStr = ctArray.map(byte => String.fromCharCode(byte)).join('')             // ciphertext as string

	return btoa(ivStr+ctStr)   
}

export const aesGcmDecrypt= async (ciphertext: string, password: string) => {
	const pwUtf8 = new TextEncoder().encode(password)                                 // encode password as UTF-8
	const pwHash = await crypto.subtle.digest('SHA-256', pwUtf8)                      // hash the password

	const ivStr = atob(ciphertext).slice(0,12)                                        // decode base64 iv
	const iv = new Uint8Array(Array.from(ivStr).map(ch => ch.charCodeAt(0)))          // iv as Uint8Array

	const alg = { name: 'AES-GCM', iv: iv }                                           // specify algorithm to use

	const key = await crypto.subtle.importKey('raw', pwHash, alg, false, ['decrypt']) // generate key from pw

	const ctStr = atob(ciphertext).slice(12)                                          // decode base64 ciphertext
	const ctUint8 = new Uint8Array(Array.from(ctStr).map(ch => ch.charCodeAt(0)))     // ciphertext as Uint8Array
	// note: why doesn't ctUint8 = new TextEncoder().encode(ctStr) work?

	try {
		const plainBuffer = await crypto.subtle.decrypt(alg, key, ctUint8)            // decrypt ciphertext using key
		const plaintext = new TextDecoder().decode(plainBuffer)                       // plaintext from ArrayBuffer
		return plaintext                                                              // return the plaintext
	} catch (e) {
		throw new Error('Decrypt failed')
	}
}

const deriveAesKeyFromPassword = async (
	password: string,
	stored: Argon2idHash
): Promise<CryptoKey> => {
	const passwordBytes = enc.encode(password)
	const salt = b64ToBytes(stored.salt)

	// Argon2id runs in a Web Worker so Create-ID loading CSS keeps animating
	const keyBytes = await argon2idAsync(passwordBytes, salt, {
		m: stored.m,
		t: stored.t,
		p: stored.p,
		dkLen: 32,
	})

	return crypto.subtle.importKey(
		'raw',
		keyBytes,
		{ name: 'AES-GCM' },
		false,
		['encrypt', 'decrypt']
	)
}
const dec = new TextDecoder()
export const aesGcmDecryptWithStored = async (
	cipherB64: string,
	password: string,
	stored: Argon2idHash
): Promise<string> => {
	const key = await deriveAesKeyFromPassword(password, stored)

	const combined = b64ToBytes(cipherB64)
	const iv = combined.slice(0, 12)
	const cipherBytes = combined.slice(12)

	const decrypted = await crypto.subtle.decrypt(
		{ name: 'AES-GCM', iv },
		key,
		cipherBytes
	)

	return dec.decode(decrypted)
}

export const isBeamioAndroidWebView = () => {
    const ua = navigator.userAgent.toLowerCase()
    return /wv|webview|beamioappwebview/i.test(ua)
}

let processing = false
export const getBalanceProcess = async (
	keyID: string,
	setBalance: (val: number) => void,
	setUsdcToUsd: (val: number) => void
): Promise<{ success: boolean; balance?: number; usdcToUSD?: number }> => {
	if (processing) {
		return { success: false }
	}
	processing = true
	try {
		const ba = await getBalance(keyID)
		if (!ba) {
			return { success: false }
		}
		
		const usdc = Number(ba.usdc)
		setBalance(usdc)
		const ethUsdc = typeof ba.oracle?.eth === 'object' && ba.oracle.eth && 'usdc' in ba.oracle.eth
			? ba.oracle.eth.usdc
			: '1'
		const usdcToUSD = usdc * Number(ethUsdc)
		setUsdcToUsd(usdcToUSD)
		return { success: true, balance: usdc, usdcToUSD }
	} finally {
		processing = false
	}
}

const listenning = async (listenningProcess: boolean, setListenningProcess: (val: boolean) => void, keyID: string, setBalance: (val: number) => void, setUsdcToUsd: (val: number) => void) => {
	if (listenningProcess) return
	setListenningProcess(true)
	await getBalanceProcess(keyID, setBalance, setUsdcToUsd)

	// conetDepinProvider.on ('block', async (block: number) => {
	// 	console.log (block)
	// 	if (!(block % 5)) {
	// 		getBalanceProcess(keyID, setBalance, setUsdcToUsd)
	// 	}
	// })
}

/** ethers 默认等满 5 分钟。恢复全屏不能跟着一条挂起的 eth_call 一直转。 */
const REGISTRY_READ_TIMEOUT_MS = 12_000

const conetJsonRpcProvider = (url: string, timeoutMs = REGISTRY_READ_TIMEOUT_MS) => {
	const req = new FetchRequest(url)
	req.timeout = timeoutMs
	return new ethers.JsonRpcProvider(req, CONET_MAINNET_CHAIN_ID, {
		staticNetwork: Network.from(CONET_MAINNET_CHAIN_ID),
	})
}

const beamioAccountContract = {
	address: CONET_ACCOUNT_REGISTRY,
	network: 'CONET DePIN',
	abi: beamioAccountABI,
	provider: conetJsonRpcProvider(CONET_RPC_URL),
}

const beamioAccountSC = new ethers.Contract(beamioAccountContract.address, beamioAccountContract.abi, beamioAccountContract.provider)

const withRegistryReadTimeout = async <T>(work: Promise<T>, ms = REGISTRY_READ_TIMEOUT_MS): Promise<T> => {
	let timer: number | undefined
	try {
		return await Promise.race([
			work,
			new Promise<T>((_, reject) => {
				timer = window.setTimeout(() => reject(new Error('registry_read_timeout')), ms)
			}),
		])
	} finally {
		if (timer !== undefined) window.clearTimeout(timer)
	}
}

type RecoverStoragePayload = {
	stored?: Argon2idHash
	img?: string
	recoverData?: unknown
}

type ValidRecoverStoragePayload = RecoverStoragePayload & {
	stored: Argon2idHash
	img: string
}

const decodeRecoverStoragePayload = (encoded: string): RecoverStoragePayload | null => {
	try {
		const obj = JSON.parse(fromBase64(encoded)) as RecoverStoragePayload
		if (!obj || typeof obj !== 'object') return null
		return {
			stored: obj.stored,
			img: typeof obj.img === 'string' ? obj.img : undefined,
			recoverData: obj.recoverData,
		}
	} catch {
		return null
	}
}

const isValidRecoverStoragePayload = (obj: RecoverStoragePayload | null): obj is ValidRecoverStoragePayload =>
	!!obj?.img && !!obj?.stored

/**
 * The PIN recover blob read in three exclusive results: `found`; `none` (a valid answer with no blob: the empty value);
 * `unavailable` (a failed or timed-out read, or a blob that does not decode). Only `none` means "no record".
 */
export type RecoverLookup =
	| { status: 'found'; encoded: string; payload: ValidRecoverStoragePayload }
	| { status: 'none' }
	| { status: 'unavailable'; reason: string }

/** 从指定 AccountRegistry 读取 @tag 对应的 PIN recover blob（三态，见 RecoverLookup） */
const fetchRecoverPayloadByAccountName = async (
	accountName: string,
	registry: ethers.Contract
): Promise<RecoverLookup> => {
	let encoded: string
	try {
		encoded = await withRegistryReadTimeout(registry.getBase64ByAccountName(accountName))
	} catch (ex) {
		return { status: 'unavailable', reason: ex instanceof Error ? ex.message.slice(0, 80) : 'rpc' }
	}
	if (!encoded?.trim()) return { status: 'none' }
	try {
		const payload = decodeRecoverStoragePayload(encoded)
		if (!isValidRecoverStoragePayload(payload)) return { status: 'unavailable', reason: 'undecodable_blob' }
		return { status: 'found', encoded, payload }
	} catch {
		return { status: 'unavailable', reason: 'undecodable_blob' }
	}
}

export const buildMinimalBeamioFromAccountName = (accountName: string): beamio => ({
	accountName,
	firstName: '',
	lastName: '',
	image: '',
	darkTheme: false,
	isUSDCFaucet: false,
	isETHFaucet: false,
	initialLoading: true,
	createdAt: Date.now(),
	language: 'en',
	currency: 'USD',
	tax: '0',
})

const parseRegistryAccountToBeamio = (userInfo: {
	accountName?: string
	image?: string
	darkTheme?: boolean
	isUSDCFaucet?: boolean
	isETHFaucet?: boolean
	initialLoading?: boolean
	firstName?: string
	lastName?: string
	createdAt?: bigint | number
	exists?: boolean
	pgpKeyID?: string
	pgpKey?: string
} | null): beamio | null => {
	if (!userInfo?.exists || !userInfo.accountName?.trim()) return null
	const { displayLastName, setup } = parseBeamioAddedSetupFromRegistryLastName(userInfo.lastName || '')
	const addedSetup: beamioAddedSetup = setup ?? { language: 'en', currency: 'USD', tax: '0' }
	return {
		accountName: userInfo.accountName,
		image: userInfo.image ?? '',
		darkTheme: userInfo.darkTheme ?? false,
		initialLoading: userInfo.initialLoading ?? false,
		isUSDCFaucet: userInfo.isUSDCFaucet ?? false,
		isETHFaucet: userInfo.isETHFaucet ?? false,
		firstName: userInfo.firstName ?? '',
		lastName: displayLastName,
		createdAt: Number(userInfo.createdAt),
		language: normalizeBeamioUiLocale(addedSetup.language) as ILanguage,
		currency: normalizeBeamioDisplayCurrency(addedSetup.currency) as ICurrency,
		tax: addedSetup.tax || '0',
		localeCurrencyConfigured: setup !== null,
		// in a shell the PGP public material is not stored in the record; the page takes it from identityPublic.
		...(isShellContext() ? {} : { pgpPublicKeyID: userInfo.pgpKeyID ?? '', pgpPublicKeyArmor: userInfo.pgpKey ?? '' }),
	}
}

/**
 * The account read in three exclusive results (the global RPC rule): `ok`, `no_account`(a valid answer that holds
 * no account), and `network_error` (a failed or timed-out read, or an undecodable answer). A failed read is never `no_account`.
 */
export type UserInfoLookup =
	| { status: 'ok'; info: beamio }
	| { status: 'no_account' }
	| { status: 'network_error'; reason: string }

const readUserInfoLookup = async (registry: ethers.Contract, keyID: string): Promise<UserInfoLookup> => {
	let userInfo: Parameters<typeof parseRegistryAccountToBeamio>[0]
	try {
		userInfo = await withRegistryReadTimeout(registry.getAccount(keyID))
	} catch (ex) {
		if (isAccountNotFoundError(ex)) return { status: 'no_account' }
		return { status: 'network_error', reason: ex instanceof Error ? ex.message.slice(0, 80) : 'rpc' }
	}
	try {
		const info = parseRegistryAccountToBeamio(userInfo)
		return info ? { status: 'ok', info } : { status: 'no_account' }
	} catch {
		return { status: 'network_error', reason: 'undecodable_answer' }
	}
}

const defaultBrowserParams: Argon2idParams = {
	memoryKB: 32 * 1024, // 32 MB
	iterations: 3,
	parallelism: 1,
	hashLen: 32
}



const hashPasswordBrowser = async (
	password: string,
	params: Argon2idParams = defaultBrowserParams
): Promise<Argon2idHash> => {
	const salt = randomBytes(16)

	const hash = await argon2idAsync(enc.encode(password), salt, {
		m: params.memoryKB,
		t: params.iterations,
		p: params.parallelism,
		dkLen: params.hashLen,
	})

	return {
		algo: 'argon2id',
		v: 19,
		m: params.memoryKB,
		t: params.iterations,
		p: params.parallelism,
		salt: b64encode(salt),
		hash: b64encode(hash),
	}
}


export const checkBeamioAccountAPI = async (preBeamio: string): Promise<boolean> => {
	try {
		const isExits = await beamioAccountSC.isAccountNameAvailable(preBeamio)
		return isExits
	} catch (ex: any) {
		// On-chain probe failed (RPC down, contract missing, ABI mismatch, decode error, ...).
		// MUST NOT default to "available" — that lets the user finish onboarding on a broken
		// chain and silently take an already-taken handle. Surface to caller's catch instead.
		console.warn(`checkBeamioAccountAPI: on-chain probe failed for "${preBeamio}": ${ex?.shortMessage || ex?.message || ex}`)
		throw new Error('UNABLE_TO_VERIFY_HANDLE_ONCHAIN')
	}
}

type IAccountRecover = {
	hash: string
	encrypto: string
}

export const newUser = async (BeamioName: string, recoverData:IAccountRecover[], privateKey: string) => {
	let signWallet: ethers.Wallet
	let signMessage: string
	try {
		signWallet = new ethers.Wallet(privateKey)
		signMessage = await signWallet.signMessage(signWallet.address)
	} catch (err) {
		console.warn(`[newUser] sign fail errType=${err instanceof Error ? err.name : typeof err}`)
		throw new LocalCreateError('sign_failed')
	}
	const Url = storageNewUser
	try {
		const body = {
			accountName: BeamioName,
			recover: recoverData,
			wallet: signWallet.address,
			signMessage
		}

		const resp = await fetch(Url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json"
			},
			body: JSON.stringify(body)
		})

		if (!resp.ok) {
			// the server answered: keep its status (never folded into false)
			throw new CreateRemoteError('http', resp.status)
		}

		await resp.json()
		return true
	} catch (err) {
		if (err instanceof CreateRemoteError) throw err
		// a fetch that never got an answer (offline, DNS, CORS, TLS): a network failure. Only the error type is logged, never a message or a payload.
		publishNativePwaLog('warn', `[newUser] network failure errType=${err instanceof Error ? err.name : typeof err}`)
		throw new CreateRemoteError('network')
	}
}

/**
 * The new-account registration of a shell (the native layer signs and forms the payload; the page only forwards it). The body is
 * `{accountName, recover, wallet, signMessage}` exactly as the native layer gave it: no field is changed and nothing is reordered.
 * Never logs the body.
 */
export type AddUserBody = { accountName: string; recover: unknown[]; wallet: string; signMessage: string }
export type AddUserPostResult = { kind: 'ok' } | { kind: 'http'; status: number } | { kind: 'network' }
export const postAddUserPayload = async (body: AddUserBody): Promise<AddUserPostResult> => {
	try {
		const resp = await fetch(storageNewUser, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
		if (!resp.ok) return { kind: 'http', status: resp.status }
		return { kind: 'ok' }
	} catch {
		return { kind: 'network' }
	}
}

/**
 * Whether the registry already holds this tag for this EOA with its recover record (the restart rule: read first, then decide).
 * 'unknown' for any read failure: it is never taken as "not registered".
 */
export const registryHasAccount = async (tag: string, eoa: string): Promise<'yes' | 'no' | 'unknown'> => {
	let info: UserInfoLookup
	try {
		info = await getUserInfoLookup(eoa)
	} catch {
		return 'unknown'
	}
	if (info.status === 'network_error') return 'unknown'
	if (info.status === 'no_account') return 'no'
	const name = String(info.info?.accountName ?? '').trim().replace(/^@+/, '').toLowerCase()
	if (name !== tag.trim().replace(/^@+/, '').toLowerCase()) return 'no'
	const recover = await fetchRecoverPayloadByAccountName(tag, beamioAccountSC)
	if (recover.status === 'found') return 'yes'
	if (recover.status === 'none') return 'no'
	return 'unknown'
}

const isValidEthersPrivateKey = (pk: unknown): pk is string => {
	if (!pk || typeof pk !== 'string') return false
	const s = String(pk).trim().replace(/^0x/i, '')
	return /^[0-9a-fA-F]{64}$/.test(s)
}

/**
 * postBeamio's result: true (the server has it); false (not sent: invalid input, or a browser failure, or a shell
 * HTTP refusal that is queued for a re-send); 'deferred' (shell only: queued in the persistent pending sync, re-sent later).
 */
export type PostBeamioResult = boolean | 'deferred'

/** a save (a user's update) or a re-send from the pending queue. A queued re-send keeps its failure count. */
type PostBeamioFrom = 'save' | 'queue'
/** A save that could not reach the server is a new intent (its count starts again); a re-send keeps the queued item. */
const queueSync = (eoa: string, from: PostBeamioFrom): void => (from === 'queue' ? ensurePendingServerSync(eoa) : enqueuePendingServerSync(eoa))

/**
 * The chain account read, a seam for tests (the registry read in production). It serves the PGP identity of a profile sync or a
 * backup update (the chain's current value) and the registration check of the create path.
 */
export const chainIdentityRead: { read: (keyID: string) => Promise<UserInfoLookup> } = {
	read: (keyID) => getUserInfoLookup(keyID),
}

/**
 * This account's own PGP identity in the browser record, when it is self-consistent (the keyID is the keyID of the armor). Null when the
 * record has none, is for another account, or does not match. Nothing is written from it unless the chain has no identity (first registration).
 */
const ownBrowserPgpIdentity = async (eoa: string): Promise<{ keyID: string; armor: string } | null> => {
	const profile = CoNET_Data?.profiles?.[0]
	if (!profile || String(profile.keyID ?? '').toLowerCase() !== eoa.toLowerCase()) return null
	const own = await loadOwnPgpPublicMaterial(profile as Parameters<typeof loadOwnPgpPublicMaterial>[0])
	if (!own.keyID || !own.publicArmor) return null
	try {
		// loaded only on this path (openpgp is not loaded at module start: it does not load under jest's module loader)
		const { readKey } = await import('openpgp')
		const id = (await readKey({ armoredKey: own.publicArmor })).getKeyIDs()[1]?.toHex().toUpperCase() ?? ''
		return id !== '' && id === own.keyID.replace(/^0x/i, '').toUpperCase() ? { keyID: own.keyID, armor: own.publicArmor } : null
	} catch {
		return null
	}
}

/**
 * The PGP identity of a browser save (profile sync) or backup update, from the chain record just read. One rule for both:
 * - the chain has both pgpKey and pgpKeyID: the chain's values, unchanged (a non-empty chain value is never overwritten);
 * - a partial chain value: null, and the caller refuses (nothing is sent);
 * - the chain has neither: the first registration, from this account's own browser PGP key, only when BOTH hold (R78 2.1):
 *   (a) the user saved the profile (`firstRegistrationAllowed`: postBeamio's 'save', never a queued re-send and never a backup update);
 *   (b) this device created the account (the local creation record, localAccountCreation.ts; a restored account never has it);
 *   and the own key is self-consistent. Otherwise null (refused, nothing sent).
 * An empty value is never sent.
 */
const pgpIdentityFromChainRecord = async (
	r: UserInfoLookup,
	eoa: string,
	firstRegistrationAllowed: boolean,
): Promise<{ keyID: string; armor: string } | null> => {
	if (r.status !== 'ok') return null
	const keyID = r.info.pgpPublicKeyID ?? ''
	const armor = r.info.pgpPublicKeyArmor ?? ''
	if (keyID && armor) return { keyID, armor }
	if (keyID || armor) return null
	if (!firstRegistrationAllowed || !isLocallyCreatedAccount(eoa)) return null
	return ownBrowserPgpIdentity(eoa)
}

/**
 * The PGP identity for a profile sync in the browser: read from the chain now (see pgpIdentityFromChainRecord). Null when the chain cannot
 * be read or the rule refuses; the caller then refuses the request (nothing is sent).
 */
const chainPgpIdentityNow = async (eoa: string, firstRegistrationAllowed: boolean): Promise<{ keyID: string; armor: string } | null> => {
	let r: UserInfoLookup
	try {
		r = await chainIdentityRead.read(eoa)
	} catch {
		return null
	}
	return pgpIdentityFromChainRecord(r, eoa, firstRegistrationAllowed)
}

const postBeamioFrom = async (beamio: beamio, privateKey: string, from: PostBeamioFrom): Promise<PostBeamioResult> => {
	if (!isValidEthersPrivateKey(privateKey)) {
		// a shell without the account's EOA key here (a native wallet session) keeps the update pending: it is re-sent once a
		// read gives the key. It is never dropped silently.
		const accountInMemory = String(CoNET_Data?.profiles?.[0]?.keyID ?? '').trim().toLowerCase()
		if (isShellContext() && /^0x[0-9a-f]{40}$/.test(accountInMemory)) {
			queueSync(accountInMemory, from)
			return 'deferred'
		}
		console.warn('[postBeamio] invalid privateKey, skipping')
		return false
	}
	const Url = storageNewUser
	let signWallet: ethers.Wallet
	try {
		signWallet = new ethers.Wallet(privateKey)
	} catch (ex: any) {
		console.warn('[postBeamio] Wallet creation failed:', diagnosticCode(ex?.message)) // a code only: the message of a wallet error may carry key material
		return false
	}
	const shell = isShellContext()
	const eoa = signWallet.address
	// The queue generation at the start: a newer queued intent during this request keeps its queued item.
	const startedGen = shell ? pendingServerSyncGeneration(eoa) : 0
	// (c) and : in a shell the PGP public material comes from identityPublic. Not ready: the request is queued (never sent
	// with an empty or omitted value, since the server writes that as '').
	const shellPgp = shell ? await shellPgpForServerRequest() : null
	if (shell && !shellPgp) {
		console.warn('[postBeamio] shell: identityPublic not ready; queued for a re-send')
		queueSync(eoa, from)
		return 'deferred'
	}
	// Browser: the PGP identity is the chain's current value, read now and passed through unchanged. An unreadable or empty value
	// refuses the save (nothing is sent). Shell: identityPublic, as before.
	const pgp = shell
		? (shellPgp ? { keyID: shellPgp.keyID, armor: shellPgp.publicArmor } : null)
		: await chainPgpIdentityNow(eoa, from === 'save')
	if (!pgp) {
		console.warn('[postBeamio] PGP identity not available from the chain; save refused, nothing sent')
		return false
	}
	const signMessage = await signWallet.signMessage(signWallet.address)


	const lastname = encodeRegistryLastNameWithLocaleSetup(
		beamio.lastName ?? '',
		buildLocaleCurrencySetupPayload(beamio),
	)
	try {
		// Known deviation (kind 2): the profile sync still writes the whole package to the chain. It carries the PGP identity above, unchanged.
		// Delete condition: when the server's updateProfile whitelist endpoint is live, send only the whitelisted fields here (no pgp fields).
		const body = {
			accountName: beamio.accountName,
			wallet: signWallet.address,
			image: beamio.image,
			isUSDCFaucet: beamio.isUSDCFaucet,
			darkTheme: beamio.darkTheme,
			isETHFaucet: beamio.isETHFaucet,
			firstName: beamio.firstName,
			lastName: lastname,
			pgpKeyID: pgp.keyID,
			pgpKey: pgp.armor,
			signMessage
		}

		// the start awaits this save, so a stalled server is a failed call after the bound (never an endless wait).
		const timeout = abortAfter(BOOT_REQUEST_TIMEOUT_MS)
		let resp: Response
		try {
			resp = await fetch(Url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json"
				},
				body: JSON.stringify(body),
				signal: timeout.signal,
			})
		} finally {
			timeout.done()
		}

		if (!resp.ok) {
			// Shell: the request is kept for a re-send. A server answer that is not an explicit refusal (5xx, 408, 429) waits
			// and is not counted; a 4xx refusal is returned as a refusal (it counts as a failure when re-sent).
			if (shell) {
				queueSync(eoa, from)
				if (resp.status >= 500 || resp.status === 408 || resp.status === 429) return 'deferred'
			}
			return false
		}
		if (shell) completePendingServerSync(eoa, startedGen)
		return true
	} catch (err) {
		console.error("newUser error:", err)
		// Shell: a network failure is retried later (not counted as a refusal).
		if (shell) {
			queueSync(eoa, from)
			return 'deferred'
		}
	}
	return false
}

/**
 * Profile sync (kind 2): a user's save only, never a start, and never a recover. The PGP identity sent is the chain's current value
 * (read now, browser) passed through unchanged; an empty or unreadable value refuses the save. Shell: identityPublic, as before.
 */
export const postBeamio = async (beamio: beamio, privateKey: string): Promise<PostBeamioResult> => postBeamioFrom(beamio, privateKey, 'save')

/**
 * The re-send of a queued account: built at send time from the latest local state (the profile and the account
 * copy in memory), never from an older copy. If that state is not the queued account, the item waits (deferred).
 */
export async function sendPendingProfileSync(eoa: string): Promise<FlushOutcome> {
	const profile = CoNET_Data?.profiles?.[0]
	const current = CoNET_Data?.beamio
	// Not this account in memory yet, or no EOA private key in this session (a native wallet session): the item waits (deferred).
	// The key comes back with the record read (option B); the update is sent once a read gives it. This is not a failure.
	if (!profile || !current || String(profile.keyID ?? '').toLowerCase() !== eoa) return 'deferred'
	if (typeof profile.privateKeyArmor !== 'string' || !profile.privateKeyArmor.trim()) return 'deferred'
	const r = await postBeamioFrom(current as beamio, profile.privateKeyArmor, 'queue')
	if (r === true) return 'sent'
	if (r === 'deferred') return 'deferred'
	return 'failed'
}

/** Single path: profile language / currency / tax → chain + local + UI i18n */
export async function persistBeamioProfileLocaleCurrency(
	beamio: beamio,
	privateKeyArmor: string,
	patch?: Partial<Pick<beamio, 'language' | 'currency' | 'tax'>>,
): Promise<beamio | null> {
	if (!isValidEthersPrivateKey(privateKeyArmor)) return null
	const bo: beamio = {
		...beamio,
		...patch,
		language: normalizeBeamioUiLocale(patch?.language ?? beamio.language) as ILanguage,
		currency: normalizeBeamioDisplayCurrency(patch?.currency ?? beamio.currency) as ICurrency,
		tax: String(patch?.tax ?? beamio.tax ?? '0'),
		localeCurrencyConfigured: true,
	}
	// Explicit: false is a failure; 'deferred'is queued for a re-send (the local copy is kept).
	const serverSync = await postBeamio(bo, privateKeyArmor)
	if (serverSync === false) return null
	if (CoNET_Data) {
		CoNET_Data.beamio = bo
		setCoNET_Data(CoNET_Data)
	}
	writeBeamioUiLanguageBootstrap(bo.language as BeamioUiLocale)
	await storeSystemData()
	await applyBeamioUiLanguageFromProfile(bo.language)
	return bo
}

/** Local CoNET_Data + bootstrap mirror when chain save unavailable or wallet locked. */
export async function persistBeamioLanguageLocally(
	beamio: beamio | null | undefined,
	language: unknown,
): Promise<beamio | null> {
	const nextLang = normalizeBeamioUiLocale(language) as ILanguage
	writeBeamioUiLanguageBootstrap(nextLang)
	await applyBeamioUiLanguageFromProfile(nextLang)
	if (!CoNET_Data && !beamio) return null
	const base = beamio ?? CoNET_Data?.beamio
	if (!base?.accountName?.trim()) return null
	const bo: beamio = { ...base, language: nextLang }
	if (CoNET_Data) {
		CoNET_Data.beamio = bo
		setCoNET_Data(CoNET_Data)
	}
	await flushStoreSystemData()
	return bo
}

export function mergeLocalLocaleLanguageOntoChainProfile(
	chainBeamio: beamio,
	localBeamio?: beamio | null,
): beamio {
	if (chainBeamio.localeCurrencyConfigured) return chainBeamio
	const localLang = localBeamio?.language ?? readBeamioUiLanguageBootstrap()
	if (!localLang) return chainBeamio
	return { ...chainBeamio, language: normalizeBeamioUiLocale(localLang) as ILanguage }
}

/** First launch when chain has no locale JSON: browser defaults → chain + local + UI */
/**
 * Startup locale and currency for an account whose chain record has no setup. The defaults are display values only: they are
 * kept locally, and a start never writes them to the chain. A chain write of the locale or currency is a user save
 * (persistBeamioProfileLocaleCurrency, from the language and currency screens). A start sends no addUser.
 * The four kinds of call: (1) restore (a start, or a recovery) sends no addUser and writes no identity field; (2) a profile
 * sync is a user save only (postBeamio); (3) the create path (newUser, createRecover) sends the full addUser with recover, only
 * for an EOA the chain does not register (assertUnregisteredBeforeCreate); (4) a backup update is the user's explicit regeneration
 * of the recovery code for an already registered account (RegenerateUser, RegenerateRecover; with recover).
 */
export async function bootstrapProfileLocaleCurrencyIfUnset(beamio: beamio): Promise<beamio> {
	if (beamio.localeCurrencyConfigured) {
		writeBeamioUiLanguageBootstrap(normalizeBeamioUiLocale(beamio.language))
		await applyBeamioUiLanguageFromProfile(beamio.language)
		return beamio
	}
	const localLang = CoNET_Data?.beamio?.language ?? readBeamioUiLanguageBootstrap()
	const defaults = localLang
		? {
				...buildBrowserLocaleCurrencyDefaults(),
				language: normalizeBeamioUiLocale(localLang),
			}
		: buildBrowserLocaleCurrencyDefaults()
	const fallback: beamio = {
		...beamio,
		...defaults,
		localeCurrencyConfigured: true,
	}
	if (CoNET_Data) {
		CoNET_Data.beamio = fallback
		setCoNET_Data(CoNET_Data)
	}
	writeBeamioUiLanguageBootstrap(normalizeBeamioUiLocale(fallback.language))
	await flushStoreSystemData()
	await applyBeamioUiLanguageFromProfile(fallback.language)
	return fallback
}

const aesGcmEncryptWithStored = async (
		plaintext: string,
		password: string,
		stored: Argon2idHash
	): Promise<string> => {
	const key = await deriveAesKeyFromPassword(password, stored)

	// 12 字节随机 IV（GCM 推荐长度）
	const iv = crypto.getRandomValues(new Uint8Array(12))

	const data = enc.encode(plaintext)

	const encrypted = await crypto.subtle.encrypt(
		{ name: 'AES-GCM', iv },
		key,
		data
	)

	const cipherBytes = new Uint8Array(encrypted)

	// 拼成 iv || ciphertext
	const combined = new Uint8Array(iv.length + cipherBytes.length)
	combined.set(iv, 0)
	combined.set(cipherBytes, iv.length)

	return bytesToB64(combined)
}

export function fromBase64(b64: string): string {
	const bin = atob(b64)
	const bytes = new Uint8Array(bin.length)
	for (let i = 0; i < bin.length; i++) {
		bytes[i] = bin.charCodeAt(i)
	}
	return new TextDecoder().decode(bytes)
}


/**
 * A failure of the remote registration call while creating an account: `network` (no answer: offline, DNS, CORS, TLS) or `http` (the server answered with a
 * non-2xx status, kept in `status`). It is thrown, never folded into false or null, so the page can tell the two apart and show a message for each.
 */
export class CreateRemoteError extends Error {
	constructor(readonly kind: 'network' | 'http', readonly status?: number) {
		super(kind === 'http' ? `http_${status ?? 0}` : 'network')
		this.name = 'CreateRemoteError'
	}
}

/** A local (device-side) failure while creating an account. The message is a step name, never a secret. */
export class LocalCreateError extends Error {
	constructor(readonly step: string) {
		super(step)
		this.name = 'LocalCreateError'
	}
}

/**
 * One create step, logged through the native debug channel. The production build drops `console` (craco: drop_console),
 * so the channel is `publishNativePwaLog`. Only the step name and the error type are logged, never a key, passphrase,
 * recovery code or payload.
 */
const logRecoverStep = (step: string, outcome: 'ok' | 'fail', err?: unknown): void => {
	const errType = err === undefined ? '' : ` errType=${err instanceof Error ? err.name : typeof err}`
	publishNativePwaLog(outcome === 'ok' ? 'info' : 'warn', `[createRecover] ${step} ${outcome}${errType}`)
}

/**
 * The create path sends the full addUser (with recover) only for an EOA the chain does not register. A registered EOA is refused,
 * and so is a lookup that cannot tell (fail closed).
 */
export async function assertUnregisteredBeforeCreate(
	eoa: string,
	lookup: (keyID: string) => Promise<UserInfoLookup> = (keyID) => chainIdentityRead.read(keyID),
): Promise<void> {
	let r: UserInfoLookup
	try {
		r = await lookup(eoa)
	} catch {
		throw new LocalCreateError('registration_unknown')
	}
	if (r.status === 'no_account') return
	if (r.status === 'ok') throw new LocalCreateError('already_registered')
	throw new LocalCreateError('registration_unknown')
}

/**
 * Test seam for createRecover: the local store probe and the new wallet, which read or write IndexedDB and the key store (not available
 * under jest). Production never passes deps: the defaults are the real functions.
 */
export type CreateRecoverDeps = { checkStatus: typeof checkStorageWithStatus; createWallet: typeof createOrGetWallet; persist: typeof persistAndVerifyLocalWallet }

export const createRecover = async (BeamioName: string, pin: string, options: { mustReuseKey?: boolean; deps?: Partial<CreateRecoverDeps> } = {}) => {
	// The test seam is honoured only under the test runner: NODE_ENV is fixed at build time, so a production page cannot pass deps (R78 2.2 (d)).
	const testSeam = process.env.NODE_ENV === 'test' ? options.deps : undefined
	const deps: CreateRecoverDeps = { checkStatus: checkStorageWithStatus, createWallet: createOrGetWallet, persist: persistAndVerifyLocalWallet, ...testSeam }
	let step = 'createOrGetWallet'
	try {
		// (overwrite estimate): a confirmed local EOA key is reused, so the EOA stays the same and the key is not replaced. A new
		// wallet is created only when the store is confirmed empty; a locked, unreadable or unconfirmed store is refused (nothing is written).
		const local = await deps.checkStatus({ probe: true })
		// keyPresent here means local signing material (a mnemonic or a private key). It only drives the account-creation reuse rule
		// (recoverSourceOf). It is NOT the entry signal: the entry judgement uses valid_mnemonic (accountJudgement.ts), never this value.
		const source = recoverSourceOf({
			status: local.status === 'unavailable' ? 'unavailable' : local.status,
			keyPresent: local.status === 'loaded' && hasLocalSigningMaterial(local.data),
		})
		if (source === 'refuse') throw new LocalCreateError('local_wallet_unconfirmed')
		// the page opened for an existing key never creates a new wallet, even if the store reads as empty now.
		if (!recoverAllowed(source, options.mustReuseKey === true)) throw new LocalCreateError('existing_key_required')
		const temp = source === 'reuse_local' && local.status === 'loaded'
			? ensureProfilePrivateKeyArmorFromMnemonic(local.data)
			: await deps.createWallet('')
		// / A reviewed rule: the reuse keeps the EOA and the private key, or nothing is written (fail closed).
		if (source === 'reuse_local' && !reuseKeepsKey(local.status === 'loaded' ? local.data : null, temp)) {
			logRecoverStep('reuse_key_changed', 'fail')
			throw new LocalCreateError('reuse_key_changed')
		}
		logRecoverStep(step, 'ok')
		if (!temp || !temp?.mnemonicPhrase || !temp?.profiles?.length) {
			throw new LocalCreateError(!temp ? 'wallet_null' : !temp?.mnemonicPhrase ? 'mnemonic_missing' : 'profile_missing')
		}
		const wallet = temp.profiles[0].privateKeyArmor
		if (!wallet) throw new LocalCreateError('private_key_missing')

		step = 'generateCODE'
		const recoverCode = generateCODE('')
		step = 'hashPassword'
		const stored = await hashPasswordBrowser(pin)

		const phraseBase64 = toBase64(temp.mnemonicPhrase)

		step = 'encrypt'
		const img = await aesGcmEncryptWithStored(phraseBase64, recoverCode.code, stored)
		const img1 = await aesGcmEncryptWithStored(phraseBase64, pin, stored)

		const storageEncryptedImg = toBase64(JSON.stringify({stored, img}))
		temp.encryptedString = recoverCode.code
		const obj = { pin, recoverCode: recoverCode.code, qrCode: recoverCode.code, temp}
		const hash = ethers.solidityPackedKeccak256(['string'], [BeamioName])
		const storageEncryptedImg1 = toBase64(JSON.stringify({stored, img: img1}))

		// newUser returns false only on an HTTP or network failure; a local failure throws (LocalCreateError).
		step = 'newUser'
		await assertUnregisteredBeforeCreate(new ethers.Wallet(wallet).address)
		const registered = await newUser(BeamioName, [{hash: recoverCode.hash, encrypto: storageEncryptedImg}, {hash, encrypto: storageEncryptedImg1}], wallet)
		logRecoverStep('newUser', registered ? 'ok' : 'fail')
		if (!registered) return null

		// AppEntryGate requires beamio.accountName + mnemonic in IndexedDB `"conet"`.
		// Verify round-trip so Welcome is never shown with an empty local wallet.
		// 0.53.48.1: the page write gate is closed until the create flow is complete (LoadingPage opens it after this function returns), so this
		// one write runs inside the restore write window: the window lets exactly this save through, the gate itself still opens later.
		// Before, the save was discarded by the closed gate, the re-read was empty, and an account that newUser had already registered was
		// reported as not created with its recovery code never shown.
		step = 'persist'
		const tag = BeamioName.trim().replace(/^@+/, '')
		let persistFailed = false
		allowRestoreWrite()
		try {
			if (tag) {
				temp.beamio = buildMinimalBeamioFromAccountName(tag)
				setCoNET_Data(temp)
				await deps.persist(tag)
			} else {
				setCoNET_Data(temp)
				await deps.persist()
			}
			logRecoverStep('persist', 'ok')
		} catch (persistErr) {
			// The account is registered already (newUser answered ok): the user gets the recovery code in any case. The local copy is written
			// again by the onboarding save after the user has seen the code (the gate is open by then).
			persistFailed = true
			logRecoverStep('persist', 'fail', persistErr)
		} finally {
			endRestoreWriteWindow()
		}
		// the create flow succeeded on this device: the local creation record (never sent). A failed write only leaves the account
		// without the record, so its first registration stays refused; the create itself is not failed.
		if (!markLocallyCreatedAccount(new ethers.Wallet(wallet).address)) logRecoverStep('local_record', 'fail')

		if (persistFailed) return { ...obj, persistFailed: true as const }
		return obj
	} catch (err) {
		if (err instanceof LocalCreateError || err instanceof CreateRemoteError) throw err
		logRecoverStep(step, 'fail', err)
		throw new LocalCreateError(step)
	}
}

/**
 * Register a fresh BeamioTag + access password on-chain without touching the
 * signed-in Consumer profile or IndexedDB. Used by agent temp EOA pre-registration.
 */
export const createDetachedRecoverAccount = async (BeamioName: string, pin: string) => {
	// Shell: the page creates no random account key; the agent temp account is native.
	if (isShellContext()) return null
	const acc = ethers.Wallet.createRandom()
	const phrase = acc.mnemonic?.phrase
	if (!phrase) return null
	const recoverCode = generateCODE('')
	const stored = await hashPasswordBrowser(pin)
	const phraseBase64 = toBase64(phrase)
	const img = await aesGcmEncryptWithStored(phraseBase64, recoverCode.code, stored)
	const img1 = await aesGcmEncryptWithStored(phraseBase64, pin, stored)
	const storageEncryptedImg = toBase64(JSON.stringify({ stored, img }))
	const hash = ethers.solidityPackedKeccak256(['string'], [BeamioName])
	const storageEncryptedImg1 = toBase64(JSON.stringify({ stored, img: img1 }))
	await assertUnregisteredBeforeCreate(acc.address)
	let registered = false
	try {
		registered = await newUser(
			BeamioName,
			[{ hash: recoverCode.hash, encrypto: storageEncryptedImg }, { hash, encrypto: storageEncryptedImg1 }],
			acc.privateKey,
		)
	} catch (err) {
		// the detached (agent temp) registration keeps its contract: a remote failure is null
		if (err instanceof CreateRemoteError) return null
		throw err
	}
	if (!registered) return null
	const eoa = ethers.getAddress(acc.address)
	// newUser can return before Master finishes AccountRegistry write — wait until PIN decrypt works.
	const deadline = Date.now() + 45_000
	while (Date.now() < deadline) {
		const hit = await fetchRecoverPayloadByAccountName(BeamioName, beamioAccountSC)
		if (hit.status === 'found' && hit.payload.img && hit.payload.stored) {
			try {
				await aesGcmDecryptWithStored(hit.payload.img, pin, hit.payload.stored)
				return { eoa }
			} catch {
				/* blob incomplete or still propagating — keep waiting */
			}
		}
		await new Promise((resolve) => window.setTimeout(resolve, 1_500))
	}
	return { eoa }
}

/** Decrypt a recover package in memory. Does not call createOrGetWallet or storeSystemData. */
export const unlockDetachedRecoverPrivateKey = async (
	username: string,
	pin: string,
): Promise<string | null> => {
	// Shell: the page derives no account key from a recover package.
	if (isShellContext()) return null
	const accountName = username.trim()
	if (!accountName || !pin) return null
	try {
		const recoverHit = await fetchRecoverPayloadByAccountName(accountName, beamioAccountSC)
		// none and unavailable both mean "could not unlock": the caller reports a failed unlock, never a claimed absence.
		if (recoverHit.status !== 'found' || !recoverHit.payload.img || !recoverHit.payload.stored) return null
		const mnemonicBase64 = await aesGcmDecryptWithStored(
			recoverHit.payload.img,
			pin,
			recoverHit.payload.stored,
		)
		const phrase = fromBase64(mnemonicBase64)
		const key = createKeyHDWallets(phrase)
		if (!key?.privateKey) return null
		return key.privateKey
	} catch {
		return null
	}
}

/**
 * Recovery-code restore with a reason. 2026-11-17: the old form returned false for every failure, so a failed chain read showed as
 * "invalid code". Now each outcome has its own kind; no kind writes or clears anything (the caller saves only after a verified read-back).
 *  - ok: a wallet record (the chain read may have failed; the local copy is then used, as before)
 *  - invalid_code: no chain record for this code, or the stored record does not open with it (AES-GCM auth failure)
 *  - chain_read_failed: the chain read itself threw (network / RPC)
 *  - unknown: the record opened but the wallet could not be derived; treat as a failure to retry, not as a wrong code
 */
export type RestoreRedeemResult =
	| { kind: 'ok'; temp: encrypt_keys_object }
	| { kind: 'invalid_code' }
	| { kind: 'chain_read_failed' }
	| { kind: 'unknown'; reason: string }

export const restoreWithRedeemDetailed = async (recoveryCode: string, pin: string): Promise<RestoreRedeemResult> => {
	// Shell: recovery is done by the native recovery engine; the page never restores here.
	if (isShellContext()) throw new Error('native_recovery_only')
	const hash = ethers.solidityPackedKeccak256(['string'], [recoveryCode])

	let hashedImg: string
	try {
		hashedImg = await beamioAccountSC.getBase64ByNameHash(hash)
	} catch (ex: any) {
		console.log(`[restoreWithRedeem] chain read failed: ${ex?.code ?? ex?.name ?? 'error'}`)
		return { kind: 'chain_read_failed' }
	}
	if (!hashedImg) return { kind: 'invalid_code' }

	let obj: any
	try {
		obj = JSON.parse(fromBase64(hashedImg))
	} catch {
		return { kind: 'unknown', reason: 'record_unreadable' }
	}
	if (!obj?.img || !obj?.stored) return { kind: 'invalid_code' }

	let mnemonicPhrase: string
	try {
		mnemonicPhrase = await aesGcmDecryptWithStored(obj.img, pin + recoveryCode, obj.stored)
	} catch {
		// The key material is the recovery code: a record that does not open is a wrong code.
		return { kind: 'invalid_code' }
	}

	let temp: encrypt_keys_object | null
	try {
		temp = await createOrGetWallet(fromBase64(mnemonicPhrase))
	} catch (ex: any) {
		console.log(`[restoreWithRedeem] derive failed: ${ex?.name ?? 'error'}`)
		return { kind: 'unknown', reason: 'derive_failed' }
	}
	if (!temp || !temp?.profiles?.length) return { kind: 'unknown', reason: 'no_profile' }

	const profile: profile = temp.profiles[0]
	// The chain read: a record is used; "no record" and a failed read both keep the local copy (nothing is written from a failure).
	try {
		const beamioRead = await getUserInfoLookup(profile.keyID)
		if (beamioRead.status === 'ok') temp.beamio = beamioRead.info
	} catch {
		/* keep the local copy */
	}
	return { kind: 'ok', temp }
}

/** Compatibility wrapper: the wallet record on success, false otherwise. New callers use restoreWithRedeemDetailed. */
export const restoreWithRedeem = async (recoveryCode: string, pin: string) => {
	const r = await restoreWithRedeemDetailed(recoveryCode, pin)
	return r.kind === 'ok' ? r.temp : false
}

/** The account read in three results (see UserInfoLookup). App init uses this one, so a failed read is not taken for "no account". */
export const getUserInfoLookup = async (keyID: string): Promise<UserInfoLookup> => readUserInfoLookup(beamioAccountSC, keyID)

export const restoreWithUserPin = async (username: string, pin: string, test = false) => {
	// Shell: recovery is done by the native recovery engine; the page never restores here.
	if (isShellContext()) throw new Error('native_recovery_only')
	try {
		const accountName = username.trim()
		if (!accountName) return false

		// The current registry only: the deprecated rpc-old read is removed (no legacy fallback, no migration write).
		const recoverHit = await fetchRecoverPayloadByAccountName(accountName, beamioAccountSC)
		// A valid "no blob" answer is a wrong or unknown name (false). A failed read is not: it is reported as unavailable.
		if (recoverHit.status === 'none') {
			return false
		}
		if (recoverHit.status === 'unavailable') {
			throw new Error('recover_lookup_unavailable')
		}

		const obj = recoverHit.payload

		const mnemonicPhrase = await aesGcmDecryptWithStored (obj.img, pin, obj.stored)
		const mnemonicPhraseB = fromBase64(mnemonicPhrase)

		const key = createKeyHDWallets(mnemonicPhraseB)
		if (!key) {
			return
		}
		if (test) {
			return true
		}
		const temp = await createOrGetWallet(mnemonicPhraseB)

		if (!temp||!temp?.profiles?.length) {
			return false
		}

		const profile: profile = temp.profiles[0]

		// A record is used. A valid "no account" keeps the local name as the copy; a failed read writes nothing, and the restore then reports
		// the wallet as incomplete.
		const onchainRead = await getUserInfoLookup(profile.keyID)
		if (onchainRead.status === 'ok') {
			temp.beamio = onchainRead.info
		} else if (onchainRead.status === 'no_account' && !temp.beamio) {
			temp.beamio = buildMinimalBeamioFromAccountName(accountName)
		}
		if (obj.recoverData) {
			;(temp as any).recoveredBusinessDraft = obj.recoverData
		}

		return temp
	} catch (ex: any) {
		// a failed registry read is rethrown: the caller reports it as unavailable, never as a wrong name
		if (ex?.message === 'recover_lookup_unavailable') throw ex
		console.log(`checkBeamioAccount error ${ex.message}`)
		return false
	}
}

function workerHitToSearchResult(hit: Record<string, unknown>): searchResult {
	return {
		username: String(hit.username ?? hit.accountName ?? ''),
		address: String(hit.address ?? ''),
		image: String(hit.image ?? ''),
		first_name: String(hit.first_name ?? hit.firstName ?? ''),
		last_name: String(hit.last_name ?? hit.lastName ?? ''),
		created_at: typeof hit.created_at === 'number' ? hit.created_at : Number(hit.created_at) || 0,
		follow_count: String(hit.follow_count ?? ''),
		follower_count: String(hit.follower_count ?? ''),
	} as searchResult
}

function searchResultToBeamioTagBasicMetadata(r: searchResult): BeamioTagBasicMetadata {
	return {
		username: String(r.username ?? ''),
		address: String(r.address ?? ''),
		image: String(r.image ?? ''),
		first_name: String(r.first_name ?? ''),
		last_name: String(r.last_name ?? ''),
		created_at: typeof r.created_at === 'number' ? r.created_at : Number(r.created_at) || 0,
		follow_count: String(r.follow_count ?? ''),
		follower_count: String(r.follower_count ?? ''),
	}
}

function beamioTagBasicMetadataToSearchResult(m: BeamioTagBasicMetadata): searchResult {
	return {
		username: m.username,
		address: m.address,
		image: m.image,
		first_name: m.first_name,
		last_name: m.last_name,
		created_at: m.created_at,
		follow_count: m.follow_count,
		follower_count: m.follower_count,
	} as searchResult
}

/**
 * @deprecated Prefer BeamioTag Worker IDB. Kept only for one-shot read of old LS during migration.
 */
function rememberSearchUsersIfTrustworthy(keyword: string, live: { results?: searchResult[] } | null) {
	const q = keyword.trim()
	if (!q || !live?.results?.length) return
	if (!ethers.isAddress(q)) return
	const first = live.results[0]
	if (!first?.address) return
	const qAddrNorm = ethers.getAddress(q).toLowerCase()
	if (first.address.toLowerCase() === qAddrNorm) {
		rememberBeamioTagBasicMetadata(searchResultToBeamioTagBasicMetadata(first))
	}
}

/**
 * search-users via BeamioTag Worker serverDB (IndexedDB local-first).
 * All UI call sites keep `searchUsername` — network + IDB live in the Worker when ready.
 */
export async function searchUsernameStaleWhileRevalidate(
	keyward: string,
	opts?: { forceNetwork?: boolean },
): Promise<{ results?: searchResult[] } | null> {
	const raw = (keyward ?? '').trim()
	if (!raw) return { results: [] }

	if (!opts?.forceNetwork && ethers.isAddress(raw)) {
		const cached = peekBeamioTagBasicMetadataForQuery(raw)
		if (cached) {
			void searchBeamioTagRemote(raw).then((live) => {
				if (live?.results?.length) {
					rememberSearchUsersIfTrustworthy(raw, {
						results: live.results.map((h) => workerHitToSearchResult(h)),
					})
				}
			})
			return { results: [beamioTagBasicMetadataToSearchResult(cached)] }
		}
	}

	const viaWorker = await searchBeamioTagRemote(raw)
	if (!viaWorker) return null
	const results = (viaWorker.results ?? []).map((h) => workerHitToSearchResult(h))
	if (raw && results.length) {
		rememberSearchUsersIfTrustworthy(raw, { results })
	}
	return { results }
}

export const searchUsername = (keyward: string) => searchUsernameStaleWhileRevalidate(keyward)

export { peekBeamioTagBasicMetadataForQuery, rememberBeamioTagBasicMetadata }
export type { BeamioTagBasicMetadata }

export const getFollowStatus = async (wallet: string, followAddress: string) => {
	//		isFollowingAddress

	const params = new URLSearchParams({wallet, followAddress}).toString()
	const Url = `${followStatusUrl}?${params}`
	try {
		const res = await fetch(Url, {method: 'GET'})
		if (res.status !== 200) {
			return null
		}
		return await res.json()
	} catch (ex: any) {
		return null
	}
	
}

export const removeFollowing = async (privateKey: string, followAddress: string) => {
	const Url = removeFollowingUrl
	const wallet = new ethers.Wallet(privateKey)

	try {
		const body = {
			wallet: wallet.address,
			followAddress,
			signMessage: await wallet.signMessage(wallet.address)
		}

		const resp = await fetch(Url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json"
			},
			body: JSON.stringify(body)
		})

		if (!resp.ok) {
			return false
		}

		const json = await resp.json()
		return true
	} catch (err) {
		console.error("removeFollowing error:", err)
	}
	return false
}

export const addFollowing = async (privateKey: string, followAddress: string) => {
	const Url = addFollowingUrl
	const wallet = new ethers.Wallet(privateKey)

	try {
		const body = {
			wallet: wallet.address,
			followAddress,
			signMessage: await wallet.signMessage(wallet.address)
		}

		const resp = await fetch(Url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json"
			},
			body: JSON.stringify(body)
		})

		if (!resp.ok) {
			return false
		}

		const json = await resp.json()
		return true
	} catch (err) {
		console.error("addFollowing error:", err)
	}
	return false
}

export const getMyFollowStatus = async (wallet: string) => {
	const params = new URLSearchParams({wallet}).toString()
	const Url = `${myFollowStatusUrl}?${params}`
	try {
		const res = await fetch(Url, {method: 'GET'})
		const data = await res.json()
		if (res.status !== 200) {
			console.log(`getMyFollowStatus Error!, status code: ${data}`)
			return null
		}
		return data
	} catch (ex: any) {
		return null
	}
}

export const RegenerateUser = async (beamio: beamio, recoverData:IAccountRecover[], privateKey: string) => {
  // as in postBeamio, a shell sends only with the PGP material from identityPublic; otherwise the request is deferred.
  const shellPgp = isShellContext() ? await shellPgpForServerRequest() : null
  // RegenerateUser is not queued (its recovery data does not travel with the queued re-send, which is postBeamio only).
  if (isShellContext() && !shellPgp) return false
	
	const signWallet = new ethers.Wallet(privateKey)
	const signMessage = await signWallet.signMessage(signWallet.address)
	// PGP identity of this request. Shell: identityPublic (as before). Browser: the chain's current PGP value, passed through unchanged (kind
	// (4) backup update). A chain with no identity (no_account), an unreadable chain, or an empty value refuses the request (nothing is sent).
	let pgp: { keyID: string; armor: string } | null = null
	if (isShellContext()) {
		pgp = shellPgp ? { keyID: shellPgp.keyID, armor: shellPgp.publicArmor } : null
	} else {
		let r: UserInfoLookup | null = null
		try {
			r = await chainIdentityRead.read(signWallet.address)
		} catch {
			r = null
		}
		if (r?.status === 'ok') {
			// kind (4) backup update: the same rule as a profile sync (chain value unchanged; first registration from the own record; else refused)
			// a backup update never makes the first registration (R78 2.1 (a)): the chain must already hold the identity
			pgp = await pgpIdentityFromChainRecord(r, signWallet.address, false)
		}
		// no_account (review 2026-11-17): a backup update never makes a first registration (R78 2.1 (a)). The page's own
		// profile key is not sent from here: pgp stays null and the request is refused. First registration runs only through the
		// save path (newUser / createRecover, pgpIdentityFromChainRecord with firstRegistrationAllowed).
	}
	if (!pgp) {
		console.warn('[RegenerateUser] PGP identity not available; request refused, nothing sent')
		return false
	}
	const Url = storageNewUser
	const lastName = encodeRegistryLastNameWithLocaleSetup(
		beamio.lastName ?? '',
		buildLocaleCurrencySetupPayload({ ...beamio, tax: beamio.tax ?? '0' }),
	)
	try {
		const body = {
			accountName: beamio.accountName,
			recover: recoverData,
			wallet: signWallet.address,
			signMessage,
			isUSDCFaucet: beamio.isUSDCFaucet,
			darkTheme: beamio.darkTheme,
			isETHFaucet: beamio.isETHFaucet,
			firstName: beamio.firstName,
			lastName: lastName,
			pgpKeyID: pgp.keyID,
			pgpKey: pgp.armor
		}

		const controller = new AbortController()
		const timeout = window.setTimeout(() => controller.abort(), 30_000)
		const resp = await fetch(Url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json"
			},
			body: JSON.stringify(body),
			signal: controller.signal,
		})
		window.clearTimeout(timeout)

		if (!resp.ok) {
			return false
		}

		const json = await resp.json()
		return true
	} catch (err) {
		console.error("newUser error:", err)
	}
	return false
}

export const RegenerateRecover = async (mnemonicPhrase: string, beamio: beamio, pin: string, privateKey: string) => {
	await new Promise(executor => setTimeout(() => executor(true), 1000))
	const recoverCode =  generateCODE('')
	const stored = await hashPasswordBrowser(pin)
	const phraseBase64 = toBase64(mnemonicPhrase)
	const img = await aesGcmEncryptWithStored (phraseBase64, recoverCode.code, stored)
	const img1 = await aesGcmEncryptWithStored (phraseBase64, pin, stored)

	const storageEncryptedImg = toBase64(JSON.stringify({stored, img}))
	const obj = { pin, recoverCode: recoverCode.code, qrCode: recoverCode.code}
	const hash = ethers.solidityPackedKeccak256(['string'], [beamio.accountName])
	const storageEncryptedImg1 = toBase64(JSON.stringify({stored, img: img1}))
	const result = await RegenerateUser(beamio, [{hash: recoverCode.hash, encrypto: storageEncryptedImg}, {hash, encrypto: storageEncryptedImg1}], privateKey)
	if (!result) {
		return null
	}
	return obj
}


export const getFololowsData = async (wallet: string) => {
	const params = new URLSearchParams({wallet}).toString()
	const Url = `${getFollowersUrl}?${params}`
	try {
		const res = await fetch(Url, {method: 'GET'})
		const data = await res.json()
		if (res.status !== 200) {
			console.log(`getMyFollowStatus Error!, status code: ${data}`)
			return null
		}
		return data
	} catch (ex: any) {
		return null
	}
	
}


export const postToIPFS = async (profile: profile, image: string): Promise<string | null> => {
	const url = `${ipfsEndpoint}storageFragment`
	const wallet = new ethers.Wallet(profile.privateKeyArmor)
	const hash = keccak256(toUtf8Bytes(image))
	try {
		const body = {
			wallet: wallet.address,
			image,
			signMessage: await wallet.signMessage(wallet.address)
		}

		const resp = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json"
			},
			body: JSON.stringify(body)
		})

		const respText = await resp.text()

		if (!resp.ok) {
			let errMsg = `IPFS upload failed: ${resp.status} ${resp.statusText}`
			try {
				const parsed = respText ? JSON.parse(respText) : null
				if (parsed?.error) errMsg = parsed.error
			} catch (_) {
				if (respText) errMsg += ` - ${respText.slice(0, 200)}`
			}
			console.error("postToIPFS error:", errMsg)
			throw new Error(errMsg)
		}

		// Server returns 200 with empty body on success; parse JSON only if body present
		if (respText) {
			try {
				const data = JSON.parse(respText)
				if (data?.error) {
					console.error("postToIPFS error:", data.error)
					throw new Error(data.error)
				}
			} catch (e: any) {
				if (e instanceof SyntaxError) {
					// Non-JSON body, treat as success (e.g. empty or plain text)
				} else {
					throw e
				}
			}
		}

		// Permanent local cache keyed by hash (local-first library).
		void import('@/utils/ipfsImageLibrary')
			.then(({ putLocalIpfsImageFromDataUrl }) => putLocalIpfsImageFromDataUrl(hash, image))
			.catch(() => {})

		return hash
	} catch (err: any) {
		console.error("postToIPFS error:", err)
		throw err instanceof Error ? err : new Error(err?.message ?? "IPFS upload failed")
	}
}
