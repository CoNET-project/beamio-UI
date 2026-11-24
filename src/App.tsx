import { isBeamioWebHostname } from '@/utils/beamioWebHost'
import { qaLine } from '@/utils/qaLog'
import { shellChatBlockedText } from '@/services/shellChatCapability'
import { nativePrereadRoundInFlight } from '@/services/prereadRound'
import { resolveRecipientForSend } from "@/utils/recipientPublicKey"
// App.tsx
import { useCallback, useEffect, useMemo, useRef, useState, useLayoutEffect, startTransition, useSyncExternalStore } from "react"
import { Navigate, Route, Routes, useNavigate, useLocation, useParams } from "react-router-dom"
import { useDaemonContext } from "./providers/DaemonProvider"
import { useBeamioTagDatabase } from "./providers/BeamioTagDatabaseProvider"
import Footer from "@/components/Footer"
import { ShellChatGate } from "@/components/ShellChatUnavailableNotice"
import { shellChatBlockedNow } from "@/services/shellChatCapability"
import EoaUsdcStripeReturnHost from "@/components/addUSDC/EoaUsdcStripeReturnHost"
import {
	dispatchNativeSystemCallAction,
	getCashTreesNativeNfcBridge,
	getCashTreesNativeNfcHost,
	isCashTreesNativeWebView,
	openExternalUrl,
} from "@/utils/cashTreesNativeNfc"
import { clearOfflineChatAlertsViaBridge } from "@/utils/cashTreesNativeAppStateBridge"
import SearchInputWithDropdown from "@/components/Home/SearchBarWithResults"
import AppEntryGate from "@/components/AppEntryGate"
import Home from "@/components/Home/Home"
import Chat from "@/pages/chat"
import History from "./pages/History/MyWalletDashboardNew"
import Pay from "./pages/Pay"
import QrOperationPage from "./pages/Pay/QrOperationPage"
import MinimizedVoiceCallWindow from "@/components/MinimizedVoiceCallWindow"
import PhoneHistoryPage from "./pages/Phone"
import BeamioInstallOnboarding from "@/components/launchPage"
import Browser from "@/pages/Browser"
import { initChat, recoverChatSigner, createInboundChatSession, makeMessage, sendMessage, resumeGossipListenOnForeground, pauseGossipListenOnBackground, prepareGossipListenResume, getGossipDeliveryAckContext, getKeysFromCoNETPGPSC, lookupRecipientRecord, emptySearchResultForAddress, rememberRecipientRoute } from "@/services/chat"
import {
	parseChatDeliveryReceiptV1,
	markMessageDeliveredBySendId,
	extractInboundSendId,
	emitDualChatDeliveryReceipts,
	postMailboxDeliveryAck,
} from "@/utils/chatDeliveryReceipt"
import { ensureNativePushBoundForWallet, ensurePushDeviceTokenListener } from "@/utils/cashTreesPushBind"
import { mirrorChatMessageToHistory } from "@/services/chatHistoryMirror"
import { runChatLocalMigration } from "@/services/chatLocalMigration"
import { unlockChatLocalWallet } from "@/services/chatLocalWallet"
import { onShellChatStarted, offerContactRoute } from '@/services/chat'
import { createColdStartBackoff } from '@/services/coldStartBackoff'
import { setHistoryListStatus } from '@/services/historyListStatus'
import { shellPublicEoaOrEmpty, onShellPublicEoaChange } from '@/services/nativeIdentityPublic'
import { nativeRoutes } from "@/services/chatWorkerBridge"
import { nativeReceiptPath } from "@/services/receiptCapability"
import { awaitWorkerHistoryTail, onHistoryBuffer, loadWorkerHistory, resumeNativeChatListen, onWorkerReady, readDecryptedChatHistory, boundAccountOfActiveClient, setCurrentAccountGetter, captureInboundAckTarget, releaseInboundLines, inboundAckIsBrowser, inboundArmorHashesOf, isInboundLineMarked } from "@/services/chatWorkerBridge"
import { settleInboundBatch } from "@/services/inboundBatchSettle"
import { recordInboundLine, recordDroppedLine, recordRejectedLine, newInboundLists, classifyInboundLine, parseInboundLine, settleInputOf } from "@/services/inboundRowRecord"
import { recordInboundDedupeMarkers, forgetInboundDedupeMarkers } from "@/utils/inboundDedupeStore"
import { dropTakenInboundLines } from "@/utils/inboundLineQueue"
import type { HistoryEntry } from "@conet.project/chat-sdk"
import { unseenHistoryEntries } from '@/services/historyRestoreSeen'
import { createHistoryApplier, commitRestorePlan } from '@/services/historyRestoreApply'
import { shouldApplyBufferBatch, gossipStartDecision, accountChangeAction } from '@/services/historyClientBinding'
import { accountEoaFor } from '@/services/gossipAckSign'
import { createCorpusReadScheduler, type CorpusReadScheduler } from '@/services/historyCorpusRead'
import { isRemovedNfcLinkUrl } from '@/services/nfcLinkRemoved'
import { checkStorage, storeSystemData, storeSystemDataAndWait, runAutoBUnitFreeClaimIfEligible, ensureProfilePrivateKeyArmorFromMnemonic, bootstrapProfileLocaleCurrencyIfUnset, mergeLocalLocaleLanguageOntoChainProfile } from "@/services/beamio"
import { hasLocalPlaintextMnemonic } from "@/utils/consumerWalletGate"
import { keyOnlyEntryDecision } from "@/utils/keyOnlyEntry"
import { setShellInitPending } from "@/services/shellInitPending"
import { SHELL_ENTRY_RESET_EVENT } from "@/services/shellEntryReset"
import { VAULT_LOCKED_EVENT } from "@/services/walletVaultEvents"
import { ensureEphemeralWalletForCouponClaim } from "@/utils/ephemeralCouponClaimWallet"
import { CoNET_Data, setCoNET_Data } from "@/utils/globals"
import { isShellContext } from "@/services/shellContext"
import { autoBUnitClaimGated } from "@/services/firstOpenClaimGateNow"
import { withoutPeerPublicArmor } from "@/services/shellRecordSanitizer"
import { resolveSigningPrivateKeyArmor } from "@/utils/resolveSigningPrivateKeyArmor"
import { searchResultFromProfileRecord } from "@/utils/beamioTagDatabase"
import { recordDiscoverShareClickIfNeeded } from '@/utils/discoverShareClickEvent'
import { stashAgentInviteIntroducerFromCurrentUrl } from '@/utils/agentInviteIntroducerStash'
import { baseEndpoint, USDCContract_BASE } from "@/utils/constants"
import usdc_abi from "@/services/ABI/usdc_abi.json"
import Vouchers from "@/pages/Vouchers/index"
import MyWallet from "@/pages/Settings/index"
import { ethers } from "ethers"
import { getDeprecatedBeamioConetLinkMemo } from "@/utils/deprecatedBeamioConet"
import BeamioContactProfilePreview from "@/components/Home/BeamioContactProfilePreview"
import { createPortal } from "react-dom"
import { motion, AnimatePresence } from "framer-motion"
import PayScreen from '@/pages/Pay/send'
import HistoryAll from '@/pages/History/components/HistoryAll'
import BeamioNavBack from '@/components/Setting/BeamioNavBack'
import Market from "@/pages/Vouchers/Market"
import VouchersExample from "@/pages/Vouchers/example/index"
import Express from "@/pages/Vouchers/example/express"
import ExampleExpress from "@/pages/Vouchers/example/exampleExpress"
import TenKeyInput from "@/pages/Pay/components/TenKeyInput"
import { Toast } from "antd-mobile"
import EmapmpleCard from '@/pages/Vouchers/example/ExampleCard'
import NewCardExample from '@/pages/Vouchers/example/newCardExample'
import ExampleCardNew from '@/pages/Vouchers/example/ExampleCardNew'
import BeamioTransactions from '@/pages/Vouchers/example/uelCenter'
import MobilePOS from '@/pages/Vouchers/example/Pos'
import CardManager from '@/pages/cardManager'
import WalletOverview from '@/pages/Wallet/WalletOverview'
import BusinessStartKetRedeemAdminPage from '@/pages/Wallet/BusinessStartKetRedeemAdminPage'
import AaMultisigPage from '@/pages/Wallet/AaMultisigPage'
import ValidatorNodeProfilePage from '@/pages/Wallet/ValidatorNodeProfilePage'
import ReferralRegistryDashboardPage from '@/pages/Wallet/ReferralRegistryDashboardPage'
import MyBrandsPage from '@/pages/Brands/MyBrandsPage'
import BountyBoard from '@/pages/BountyBoard'
import CoNetMiningDetailPage from '@/pages/BountyBoard/CoNetMiningDetailPage'
import GenesisNodeReferralPage from '@/pages/BountyBoard/GenesisNodeReferralPage'
import GenesisL0RedeemManagePage from '@/pages/BountyBoard/GenesisL0RedeemManagePage'
import GenesisL1EvangelistManagePage from '@/pages/BountyBoard/GenesisL1EvangelistManagePage'
import { AcrossTheNetworkRoute } from '@/pages/BountyBoard/NetworkContributionRewardsPage'
import StripePaymentReturnPage from '@/pages/Vouchers/StripePaymentReturnPage'
import RenderActionPage from '@/renderAction'
import { getUserInfoLookup } from "@/services/beamio"
import { loadUserInfoWithBackoff } from "@/services/userInfoLoad"
import { ACCOUNT_INFO_RETRY_EVENT, setAccountInfoUnavailable } from "@/services/accountInfoUnavailable"
import { AccountInfoUnavailableNotice } from "@/components/AccountInfoUnavailableNotice"
import { withBootTimeout } from "@/utils/bootTimeout"
import { AppButton } from "@/components/button/AppButton"
import { Check } from "lucide-react"
import { BeamioAddressCapsule, shortAddressLabel } from "@/components/BeamioAddressCapsule"
import { localCallerAvatarDataUri, syncCallerAvatarsToShell } from "@/utils/callerAvatar"
import { postCardCouponOpenClaimWithCurrentWallet, type CouponOpenClaimEligibility } from "@/services/BeamioCard"
import CouponClaimTicketPreview from "@/components/Home/CouponClaimTicketPreview"
import ShowPayCodeSheet from "@/components/Home/ShowPayCodeSheet"
import MerchantGiftClaimSheet from "@/components/Home/MerchantGiftClaimSheet"
import type { ActiveCouponListItem } from "@/pages/Home/ActiveCouponsScreen"
import {
	collectDeepLinkSearchParams,
	parseCouponOpenClaimFromParams,
	parseRedeemClaimFromParams,
	isRedeemDeepLink,
	isCouponOpenClaimDeepLink,
	normalizeDeepLinkInput,
} from "@/utils/beamioDeepLinkParams"
import { parseDiscoverMerchantFromParams, stripDiscoverMerchantDeepLinkParams } from "@/utils/discoverMerchantShare"
import { readDiscoverShareReferrer, stashDiscoverShareReferrer } from "@/utils/discoverShareReferrerStash"
import { applyPendingConsumerDeepLinkIfNeeded } from "@/utils/pendingConsumerDeepLink"
import { routeDiscoverMerchantDeepLink } from "@/utils/routeDiscoverMerchantDeepLink"
import { publishNativePwaLog } from "@/utils/cashTreesNativePwaLog"
import { registerUnlockChatRestart, runUnlockChatStart, takeUnlockChatOwnership } from "@/services/unlockChatRestart"
import { startChatPreheat } from "@/services/chatPreheat"
import { startupRetryDelayMs, STARTUP_RETRY_OFFER_EVENT } from "@/services/startupRetryPolicy"
import { isShellTerminal, runEmptyReadBranch, subscribeShellTerminal } from "@/services/shellTerminalState"
import { declineIncomingVoiceOffer, notifyIncomingVoiceRinging, resolvePeerVoiceMaterialAsync, timeoutIncomingVoiceOffer } from '@/services/voiceCallController'
import { BEAMIO_WALLET_READY_EVENT } from "@/utils/beamioWalletReadyEvent"
import { ensureConetAaForProfileAndPersist } from "@/utils/ensureConetAa"
import { useAccountBindEffects } from "@/hooks/useAccountBindEffects"
import { ingestAaMultisigFromChat } from '@/utils/aaMultisigIngest'
import { tu } from '@/locale/beamioLocale'
import { getCallCapabilityState, probeCallCapabilityNow, startCallCapabilityProbe, subscribeCallCapabilityState } from '@/services/callCapabilityRuntime'
import { callAllowed } from '@/services/callCapability'
import { mapServerError } from '@/locale/mapServerError'
import { installPwaLifecycleRecovery } from '@/utils/pwaLifecycleRecovery'
import { clearConnectedCallIfMatches, installNativeCallHangupWatcher, handleRegisteredNativeCallHangup } from '@/utils/nativeCallHangup'
import { storedVoiceSignal, verifiedVoiceSignalFromLine, dismissRevokedIncomingCall, revokeRingForLateTag, admitIncomingVoiceOffer, setIncomingOfferTagLookup, applyNativeIncomingVoiceOfferFromLine, askShellWhichIncomingCallsRang, sameCallId, browserVoiceCallBusyFor, closeSettledIncomingCalls, markIncomingCallNeverRang, missedIncomingCallRow, incomingSettledStatusForAction, noteIncomingCallSettled, reportNativeIncomingSystemCall, claimIncomingVoiceCallReport, isPhoneCallTerminalStatus, noteVoiceCallsEnded, voiceCallHandlesEndedInBatch, claimedVoiceCallerAddress, claimedVoiceCallerTag, dismissNativeIncomingVoiceCall, findPhoneCallByIds, forgetIncomingVoiceOffer, formatLookedUpBeamioTag, isVoiceCallOfferActive, isVoiceCallOfferRinging, lookupIncomingVoiceOffer, markVoiceCallTerminal, mergePhoneCallRecord, nativeIncomingSystemCallPayload, noteNativeCallAnswered, noteVoicePeerRinging, parseVoiceCallSignal, phoneCallStatusForPeerHangup, recoverVoiceCallOfferSigner, rememberIncomingVoiceOffer, replacePhoneCallInRows, VOICE_CALL_IDENTITY_WARNING, voiceCallClaimMismatchesKey } from '@/utils/voiceCallSession'

/** bounds on the start path's side calls. A stalled call falls back and the start goes on (the UI is already shown). */
const BOOT_PROVISION_TIMEOUT_MS = 8_000
const BOOT_LOCALE_SYNC_TIMEOUT_MS = 15_000

global.Buffer = require("buffer").Buffer

type message = {
  from: string
  signMessage: string
  text: string
  timestamp: number
  /** Attached by gossip decrypt — keccak256(utf8(PGP armor)) for mailbox ACK */
  _beamioPgpArmorHash?: string
}

// 你原来的 addNewMessage 保持不动（略）
// ..

/**
 * Deep link `/chat/:id` used to render a demo stub (chatDetail) with no real
 * composer/video player — inbound multimodal looked "broken". Redirect into the
 * real Chat surface via chatHomeItem (same path as Search / voice accept).
 */
function ChatAddressDeepLinkRedirect() {
	const { id } = useParams()
	const navigate = useNavigate()
	const { setChatHomeItem } = useDaemonContext()
	const { resolvePeerSearchResult } = useBeamioTagDatabase()
	// Every admission path (the shell's applyNative included) checks a declared @tag against this local lookup (v10 §12).
	useEffect(() => {
		setIncomingOfferTagLookup((addr) => formatLookedUpBeamioTag(resolvePeerSearchResult(addr)?.username))
		return () => setIncomingOfferTagLookup(null)
	}, [resolvePeerSearchResult])
	// Native local hangup of a connected call (v66 §73): global, so it works when the chat page is not mounted. One watcher only.
	useEffect(() => installNativeCallHangupWatcher((payload) => {
		handleRegisteredNativeCallHangup(payload)
	}) ?? undefined, [])
	const redirectedRef = useRef(false)

	useEffect(() => {
		if (redirectedRef.current) return
		const raw = String(id || '').trim()
		if (!raw) {
			navigate('/chat', { replace: true })
			return
		}
		redirectedRef.current = true
		const contact =
			resolvePeerSearchResult(raw) ||
			(ethers.isAddress(raw) ? emptySearchResultForAddress(raw) : null)
		if (contact) setChatHomeItem(contact)
		navigate('/chat', { replace: true })
	}, [id, navigate, resolvePeerSearchResult, setChatHomeItem])

	return null
}

/** The signature check of addNewMessage, for a replayed line (the same rule: the sender's own signature, or the inner text claimed by `from`). */
function inboundSignatureValid(msg: message): boolean {
	const claimedFrom = String(msg.from || '').trim().toLowerCase()
	let sign = recoverChatSigner(msg.text as string, msg.signMessage as string)
	if (sign !== claimedFrom && typeof msg.text === 'string') {
		try {
			const inner = JSON.parse(msg.text) as { text?: string }
			if (typeof inner?.text === 'string') {
				const innerSigner = recoverChatSigner(inner.text, msg.signMessage as string)
				if (innerSigner && innerSigner === claimedFrom) sign = innerSigner
			}
		} catch {}
	}
	return !!sign && ethers.isAddress(sign)
}

function AppShell() {
  const ROUTE_LOCK_ENABLED = false
  const {
    isInitialLoading,
    showFooter,
    setShowFooter,
    chatSearchOpen,
    setChatSearchOpen,
    setChatHomeItem,
    seenMsgRef,
    charts,
    setMessageCount,
    setCharts,
    profiles,
    setProfiles,
    allNodes,
    setAllNodes,
    setGossip: setGossipState,
    setSecureCode,
    setRedeemCode,
    setPaymentLinkCode,
    gossip,
    scanData,
    setPaymentLink,
    setSendToMemo,
    setScanData,
    scanIntent,
    setScanIntent,
    setVoucherPayFromScan,
	setIsInitialLoading,
	beamio,
	setBeamio,
	redeemResult,
	setRedeemResult,
	setMyAddress,
	refreshRecentActivityNoAa,
	applyCouponOpenClaimStatus,
  } = useDaemonContext()

  const {
    searchRemoteAndIngest,
    resolvePeerSearchResult,
    ensureProfilesForAddresses,
  } = useBeamioTagDatabase()

  const bodyRef = useRef<HTMLDivElement | null>(null)
  const [userPreviewItem, setUserPreviewItem] = useState<searchResult | null>()
  const [couponClaimIntent, setCouponClaimIntent] = useState<{
    cardAddress: string
    couponId: string
    referrerEoa?: string | null
  } | null>(null)
  const [couponClaimPreviewRow, setCouponClaimPreviewRow] = useState<ActiveCouponListItem | null>(null)
  const [couponClaimEligibility, setCouponClaimEligibility] = useState<CouponOpenClaimEligibility | null>(null)
  const [couponClaimSubmitting, setCouponClaimSubmitting] = useState(false)
  /** Already-claimed open-claim → OpenContainer QR for POS 核销. */
  const [couponClaimShowPayOpen, setCouponClaimShowPayOpen] = useState(false)
  // Call capability (the decision): one hello probe in a shell; an old shell gets the upgrade copy and no Accept.
  const callCapState = useSyncExternalStore(subscribeCallCapabilityState, getCallCapabilityState, getCallCapabilityState)
  // One startup probe, after the start has had time to settle (2026-11-21): it never runs concurrently with the start's own reads.
  useEffect(() => {
    const t = window.setTimeout(() => startCallCapabilityProbe(isCashTreesNativeWebView()), 4000)
    return () => window.clearTimeout(t)
  }, [])
  // Foreground re-probe (decision 2026-11-21): on return to the foreground a fresh hello decides.
  useEffect(() => {
    const onVisible = () => { if (!document.hidden) void probeCallCapabilityNow() }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [])
  const [globalIncomingVoiceCall, setGlobalIncomingVoiceCall] = useState<{
    signal: ReturnType<typeof parseVoiceCallSignal>
    from: string
    displayTag: string
    claimedTag: string
    claimedAddress: string
    identityWarning: string
  } | null>(null)
  const [globalIncomingVoiceMuted, setGlobalIncomingVoiceMuted] = useState(false)
  const [browserNotificationPermission, setBrowserNotificationPermission] = useState<NotificationPermission | 'unsupported'>(() =>
    typeof window !== 'undefined' && 'Notification' in window ? Notification.permission : 'unsupported',
  )
  const nativeVoiceAnswerKeyRef = useRef<string | null>(null)
  const [redeemClaimIntent, setRedeemClaimIntent] = useState<{
    cardAddress?: string
    redeemCode: string
    giftImageUrl?: string
  } | null>(null)

  useEffect(() => {
    if (
      !globalIncomingVoiceCall ||
      typeof window === 'undefined' ||
      !('Notification' in window) ||
      Notification.permission !== 'granted'
    ) {
      return
    }
    const peer = resolvePeerSearchResult(globalIncomingVoiceCall.from)
    const tag = globalIncomingVoiceCall.displayTag || formatLookedUpBeamioTag(peer?.username)
    const label = tag || shortAddressLabel(globalIncomingVoiceCall.from)
    const notification = new Notification('Incoming voice call', {
      body: `${label} is calling`,
      tag: `beamio-global-voice-${globalIncomingVoiceCall.signal?.sessionId ?? globalIncomingVoiceCall.from}`,
      requireInteraction: true,
    })
    notification.onclick = () => {
      window.focus()
      notification.close()
    }
    return () => notification.close()
  }, [browserNotificationPermission, globalIncomingVoiceCall, resolvePeerSearchResult])

  // Android shell: hand contacts' verified tags and avatars over ahead of time,
  // so its call windows never look a caller up online (see callerAvatar.ts).
  useEffect(() => {
    const chats = profiles?.[0]?.chats
    if (!Array.isArray(chats) || !chats.length) return
    const timer = window.setTimeout(() => {
      const contacts = chats.map((chat: chatData) => ({
        address: chat.address,
        tag: resolvePeerSearchResult(chat.address)?.username,
      }))
      void syncCallerAvatarsToShell(contacts)
    }, 3000)
    return () => window.clearTimeout(timer)
  }, [profiles, resolvePeerSearchResult])

  const enableBrowserCallNotifications = useCallback(async () => {
    if (typeof window === 'undefined' || !('Notification' in window)) {
      setBrowserNotificationPermission('unsupported')
      return
    }
    const permission = await Notification.requestPermission()
    setBrowserNotificationPermission(permission)
  }, [])
  /** 扫码 beamio URL 中的 wallet 参数：{ beamioAccount, wallet }，PayScreen 优先使用此地址 */
  const [preferredPayeeWallet, setPreferredPayeeWallet] = useState<{ beamioAccount: string; wallet: string } | null>(null)
  const runningRef = useRef(false)
  const pendingQueueRef = useRef<string[]>([])
  const processedIdsRef = useRef<Set<string>>(new Set())
  /** Keys of inbound lines that produced a chat row in this page session (only these get a row-backed ACK on a replay). */
  const storedRowKeysRef = useRef<Set<string>>(new Set())
  const setChartsRef = useRef(setCharts)
  // The lines of a chat start (App init and the account change). A signed end on a line stops its (replayed) offer from ringing the shell.
  const handleInitChatLine = useCallback((message: string) => {
    noteVoiceCallsEnded(voiceCallHandlesEndedInBatch([message], recoverChatSigner))
    applyNativeIncomingVoiceOfferFromLine(message)
    setChartsRef.current((prev: string[]) => [...prev, message])
  }, [])
  setChartsRef.current = setCharts
  const gossipActiveRef = useRef(gossip)
  gossipActiveRef.current = gossip
  // setGossip writes the gossip ref at once: a queued init reads the ref before React has committed the state.
  const setGossip = useCallback((v: boolean) => { gossipActiveRef.current = v; setGossipState(v) }, [setGossipState])
  const bUnitClaimAttemptedRef = useRef(false)
  const initialRedeemUrlProcessedRef = useRef(false)
  /**the account a shell has entered in this page process. A second init for the same account is a skip. */
  const shellEnteredAccountRef = useRef<string | null>(null)
  /** the bounded re-reads of a shell init whose storage read ended empty (reset when an account is read). */
  const shellEmptyReadRetryRef = useRef(0)
  /** r92 step 5: the pending re-read of an init skip; cleared on unmount so no old App instance re-reads. */
  const shellEmptyReadTimerRef = useRef<number | null>(null)
  useEffect(() => () => {
    if (shellEmptyReadTimerRef.current !== null) window.clearTimeout(shellEmptyReadTimerRef.current)
    shellEmptyReadTimerRef.current = null
  }, [])
  // The gate decided the terminal update prompt: the pending re-read is cancelled and none is scheduled (only the user's Retry probes).
  useEffect(() => subscribeShellTerminal((terminalNow) => {
    if (!terminalNow) return
    if (shellEmptyReadTimerRef.current !== null) window.clearTimeout(shellEmptyReadTimerRef.current)
    shellEmptyReadTimerRef.current = null
  }), [])
  //bumped by a vault lock or sign-out; a pending account read stops when it changes.
  const accountInfoEpochRef = useRef(0)
  const initialOpenClaimUrlProcessedRef = useRef(false)
  const initialDiscoverMerchantUrlProcessedRef = useRef(false)
  /** (a′): the account was entered as key-only (no local mnemonic); the account network effects stay off. */
  const [keyOnlyEntered, setKeyOnlyEntered] = useState(false)
  const routeLockHashRef = useRef<string>("")
  const routeLockApplyingRef = useRef(false)

  const navigate = useNavigate()
  const location = useLocation()

  /** Restore merchant/coupon + `ref=` / `invite=` stashed on app-download before App Store install. */
  useLayoutEffect(() => {
    applyPendingConsumerDeepLinkIfNeeded()
    stashAgentInviteIntroducerFromCurrentUrl()
  }, [])

  useAccountBindEffects({ isInitialLoading, profiles, setProfiles, keyOnlyEntered })

  // 直接打开 redeem URL（如 https://beamio.ca/app/?beamiocard=...&redeemcode=...）时先打开确认页
  useEffect(() => {
    if (isInitialLoading || initialRedeemUrlProcessedRef.current) return
    if (typeof window === 'undefined') return
    const parsed = parseRedeemClaimFromParams(collectDeepLinkSearchParams(window.location.href))
    if (!parsed) return
    initialRedeemUrlProcessedRef.current = true
    setCouponClaimIntent(null)
    setRedeemClaimIntent(parsed)
    setShowFooter(false)
    navigate('/History')
  }, [isInitialLoading, navigate, setShowFooter])

  // 直接打开 coupon open-claim URL（如 ?beamiocard=0x...&couponId=...&claim=open）时先打开确认页
  useEffect(() => {
    if (isInitialLoading || initialOpenClaimUrlProcessedRef.current) return
    if (typeof window === 'undefined') return

    const parsed = parseCouponOpenClaimFromParams(collectDeepLinkSearchParams(window.location.href))
    if (!parsed) return

    initialOpenClaimUrlProcessedRef.current = true
    stashDiscoverShareReferrer(parsed.cardAddress, parsed.referrerEoa)
    setRedeemClaimIntent(null)
    setCouponClaimIntent(parsed)
    setShowFooter(false)
    navigate('/History', {
      state: { discoverShareReferrerEoa: parsed.referrerEoa },
    })
  }, [isInitialLoading, navigate, setShowFooter])

  // Discover merchant deep link (?beamiocard=&discover=open) → open merchant detail on /discover
  useEffect(() => {
    if (isInitialLoading || keyOnlyEntered || initialDiscoverMerchantUrlProcessedRef.current) return
    if (typeof window === 'undefined') return

    const parsed = parseDiscoverMerchantFromParams(collectDeepLinkSearchParams(window.location.href))
    if (!parsed) return

    initialDiscoverMerchantUrlProcessedRef.current = true
    // Same hand-off as pasting the link into global search (stash ref, bind, open detail).
    routeDiscoverMerchantDeepLink({
      cardAddress: parsed.cardAddress,
      referrerEoa: parsed.referrerEoa,
      profile: profiles?.[0],
      navigate,
      setShowFooter,
    })
  }, [isInitialLoading, keyOnlyEntered, navigate, profiles?.[0], setShowFooter])

  const couponShareClickRecordedRef = useRef(false)
  useEffect(() => {
    if (isInitialLoading || keyOnlyEntered || couponShareClickRecordedRef.current || !couponClaimIntent) return
    const privateKeyArmor = resolveSigningPrivateKeyArmor(profiles?.[0])
    if (!privateKeyArmor) return
    couponShareClickRecordedRef.current = true
    void recordDiscoverShareClickIfNeeded({
      cardAddress: couponClaimIntent.cardAddress,
      privateKeyArmor,
      referrerEoa: couponClaimIntent.referrerEoa ?? readDiscoverShareReferrer(couponClaimIntent.cardAddress),
      couponId: couponClaimIntent.couponId,
    })
  }, [isInitialLoading, keyOnlyEntered, couponClaimIntent, profiles?.[0]])

  useEffect(() => {
    if (!couponClaimIntent) {
      setCouponClaimPreviewRow(null)
      setCouponClaimEligibility(null)
      setCouponClaimShowPayOpen(false)
    }
  }, [couponClaimIntent])

  const closeCouponClaimPanel = () => {
    setCouponClaimIntent(null)
    setCouponClaimEligibility(null)
    setCouponClaimShowPayOpen(false)
    setShowFooter(true)
    navigate('/')
  }

  const closeRedeemClaimPanel = () => {
    setRedeemClaimIntent(null)
    setShowFooter(true)
    navigate('/')
  }

  const handleConfirmCouponClaim = async () => {
    if (!couponClaimIntent || couponClaimSubmitting) return
    if (
      couponClaimEligibility === 'already_claimed' ||
      couponClaimEligibility === 'already_redeemed' ||
      couponClaimEligibility === 'sold_out' ||
      couponClaimEligibility === 'expired' ||
      couponClaimEligibility === 'not_open_claim' ||
      couponClaimEligibility === 'insufficient_social_points'
    ) {
      return
    }
    const privateKeyArmor = resolveSigningPrivateKeyArmor(profiles?.[0])
    if (!privateKeyArmor) {
      // In a shell without the chat capability the password unlock does not exist; say so instead.
      Toast.show({
        content: shellChatBlockedNow()
          ? shellChatBlockedText()
          : tu('unlock_your_wallet_with_your_access_password_to_claim_coupons'),
        position: 'top',
      })
      return
    }
    setCouponClaimSubmitting(true)
    try {
      const ret = await postCardCouponOpenClaimWithCurrentWallet({
        cardAddress: couponClaimIntent.cardAddress,
        couponId: couponClaimIntent.couponId,
        tokenId: couponClaimPreviewRow?.tokenId,
        privateKeyArmor,
        referrerEoa: couponClaimIntent.referrerEoa ?? null,
      })
      Toast.show({
        content: ret.success
          ? tu('claimed')
          : (ret.error ?? tu('coupon_open_claim_failed')),
        position: 'top',
      })
      if (ret.success) {
        const tid = couponClaimPreviewRow?.tokenId?.trim()
        if (tid) {
          applyCouponOpenClaimStatus({
            cardAddress: couponClaimIntent.cardAddress,
            tokenId: tid,
            couponId: couponClaimIntent.couponId,
            status: 'claimed',
            source: 'optimistic',
          })
        }
        // Keep panel open → Show Pay for POS redeem/burn (same as app-download landing).
        setCouponClaimEligibility('already_claimed')
      }
    } catch (e: any) {
      Toast.show({ content: mapServerError(e?.message), position: 'top' })
    } finally {
      setCouponClaimSubmitting(false)
    }
  }

  // App 初始化时检查可否领取 BeamioBUnits，可领取则自动发起领取请求（静默，不弹提示）
  // 重要：claimant 必须从私钥推导，不能使用 keyID，否则会导致 signer != claimant 链上失败
  useEffect(() => {
    if (bUnitClaimAttemptedRef.current || !profiles?.length) return
    const p0 = profiles[0] as { privateKeyArmor?: string; keyID?: string } | undefined
    if (!p0?.privateKeyArmor) return
    let claimant: string
    try {
      claimant = new ethers.Wallet(p0.privateKeyArmor).address
    } catch {
      return
    }
    if (!claimant || !ethers.isAddress(claimant)) return
    // 防御：keyID 与私钥推导地址不一致时跳过，避免 signer != claimant 导致链上 revert
    if (p0.keyID && ethers.isAddress(p0.keyID) && p0.keyID.toLowerCase() !== claimant.toLowerCase()) {
      return
    }
    bUnitClaimAttemptedRef.current = true
    // on the browser first-open path (no PGP record, the SDK confirms it) no automatic claim is sent. Other entries are unchanged.
    void autoBUnitClaimGated({ privateKeyArmor: p0.privateKeyArmor!, profile: p0, shell: isShellContext(), lookup: lookupRecipientRecord, claimant, claim: runAutoBUnitFreeClaimIfEligible }).catch(() => {})
  }, [profiles])

  const { pathname } = useLocation()

  useEffect(() => {
    if (!ROUTE_LOCK_ENABLED || typeof window === "undefined") return

    const normalizeHash = (hash: string) => (hash && hash.startsWith("#") ? hash : `#${hash || "/"}`)
    const originalPushState = window.history.pushState.bind(window.history)
    const originalReplaceState = window.history.replaceState.bind(window.history)

    routeLockHashRef.current = normalizeHash(window.location.hash || "#/")

    const forceBackToLockedHash = () => {
      const locked = normalizeHash(routeLockHashRef.current || "#/")
      const current = normalizeHash(window.location.hash || "#/")
      if (current === locked) return
      routeLockApplyingRef.current = true
      originalReplaceState(window.history.state, "", `${window.location.pathname}${window.location.search}${locked}`)
      setTimeout(() => {
        routeLockApplyingRef.current = false
      }, 0)
    }

    const onHashChange = (e: HashChangeEvent) => {
      if (routeLockApplyingRef.current) return
      const locked = normalizeHash(routeLockHashRef.current || "#/")
      const current = normalizeHash(window.location.hash || "#/")
      if (current === locked) return
      e.preventDefault?.()
      forceBackToLockedHash()
    }

    const onPopState = () => {
      if (routeLockApplyingRef.current) return
      forceBackToLockedHash()
    }

    const onClickCapture = (e: MouseEvent) => {
      const target = (e.target as HTMLElement | null)?.closest?.("a[href]") as HTMLAnchorElement | null
      if (!target) return
      if (target.target === "_blank" || target.hasAttribute("download")) return
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
      const href = (target.getAttribute("href") || "").trim()
      if (!href) return
      const isHashLink = href.startsWith("#")
      const isRelativeLink = href.startsWith("/") || href.startsWith("./") || href.startsWith("../")
      const isSameOriginAbsolute = /^https?:\/\//i.test(href) && new URL(href, window.location.href).origin === window.location.origin
      if (!isHashLink && !isRelativeLink && !isSameOriginAbsolute) return
      e.preventDefault()
      e.stopPropagation()
      const ie = e as MouseEvent & { stopImmediatePropagation?: () => void }
      ie.stopImmediatePropagation?.()
      forceBackToLockedHash()
    }

    window.history.pushState = ((..._args: Parameters<History["pushState"]>) => {
      forceBackToLockedHash()
    }) as History["pushState"]

    window.history.replaceState = ((..._args: Parameters<History["replaceState"]>) => {
      forceBackToLockedHash()
    }) as History["replaceState"]

    window.addEventListener("hashchange", onHashChange, true)
    window.addEventListener("popstate", onPopState, true)
    document.addEventListener("click", onClickCapture, true)

    forceBackToLockedHash()

    return () => {
      window.history.pushState = originalPushState
      window.history.replaceState = originalReplaceState
      window.removeEventListener("hashchange", onHashChange, true)
      window.removeEventListener("popstate", onPopState, true)
      document.removeEventListener("click", onClickCapture, true)
    }
  }, [ROUTE_LOCK_ENABLED])

  const [showAlphaHowItWorks, setShowAlphaHowItWorks] =
    useState<"BeamioContactProfilePreview" | ""|'支付'>("")
  const [payFocusAmountOnMount, setPayFocusAmountOnMount] = useState(false)

	/** Enter Chat (list or thread): tray only. Icon badge stays unread via syncNativeFooterChatBadge. */
	const onChatRoute = useMemo(() => {
		const p = (pathname || '/').toLowerCase()
		return p === '/chat' || p.startsWith('/chat/') || p.startsWith('/chat?')
	}, [pathname])

	useEffect(() => {
		if (!onChatRoute) return
		clearOfflineChatAlertsViaBridge()
	}, [onChatRoute])

	/** 消息唯一键：优先 sendId，否则 from_timestamp，用于去重与角标 */
	const getMsgKey = (raw: any) => {
		try {
			const obj = typeof raw === 'string' ? JSON.parse(raw) : raw
			const from = String(obj?.from || '')
			const ts = Number(obj?.timestamp)
			const text = obj?.text
			// 优先用内层 sendId（发送方已用 crypto.randomUUID）
			if (text && typeof text === 'string') {
				try {
					const inner = JSON.parse(text)
					if (inner?.sendId) return String(inner.sendId)
				} catch {}
			}
			if (Number.isFinite(ts) && ts > 0 && from) return `${from}_${ts}`
			if (Number.isFinite(ts) && ts > 0) return `${ts}`
		} catch {}
		return null
	}

  useEffect(() => {
		let touchStartX = 0
		let touchStartY = 0
		let edgeSwipeBlock = false
		/** touch identifier(s) that began on an interactive control — skip scroll suppression for whole gesture */
		const interactiveTouchIds = new Set<number>()
		const TOUCH_INTERACTIVE_SELECTOR =
			"button, a[href], input, textarea, select, [role='button'], label, summary, [data-touch-priority='1']"
		const EDGE_GUARD_PX = 28
		const captureOpts: AddEventListenerOptions = { capture: true }
		const capturePassiveStart: AddEventListenerOptions = { capture: true, passive: true }
		const captureActiveMove: AddEventListenerOptions = { capture: true, passive: false }

		const canScrollX = (el: HTMLElement) => {
			const style = window.getComputedStyle(el)
			const overflowX = style.overflowX
			if (overflowX !== "auto" && overflowX !== "scroll") return false
			return el.scrollWidth > el.clientWidth
		}

		/** touch 落在文本节点 / SVG 上时 e.target 可能不是 Element，closest/canScroll 会失效或异常 */
		const touchTargetToElement = (t: EventTarget | null): Element | null => {
			if (t == null) return null
			if (t instanceof Element) return t
			if (t instanceof Text) return t.parentElement
			return null
		}

		const hasHorizontalScrollableAncestor = (target: Element | null) => {
			const root = (document.scrollingElement as HTMLElement) || document.documentElement
			let el: Element | null = target
			while (el && el !== root) {
				if (el instanceof HTMLElement && canScrollX(el)) return true
				el = el.parentElement
			}
			return false
		}

		const stopEvent = (e: TouchEvent) => {
			e.preventDefault()
			// Do not stopImmediatePropagation — it can prevent synthesized click on buttons.
		}

		const canScroll = (el: HTMLElement) => {
			const style = window.getComputedStyle(el)
			const overflowY = style.overflowY
			if (overflowY !== "auto" && overflowY !== "scroll") return false
			return el.scrollHeight > el.clientHeight
		}

		const isTouchInteractiveTarget = (target: Element | null) =>
			Boolean(target?.closest(TOUCH_INTERACTIVE_SELECTOR))

		const handleTouchStart = (e: TouchEvent) => {
			const t = e.touches[0]
			if (!t) return
			touchStartX = t.clientX
			touchStartY = t.clientY
			const targetEl = touchTargetToElement(e.target)
			if (isTouchInteractiveTarget(targetEl)) {
				for (let i = 0; i < e.touches.length; i++) {
					interactiveTouchIds.add(e.touches[i].identifier)
				}
			}
			const vw = window.innerWidth || document.documentElement.clientWidth || 0
			const startedAtEdge = touchStartX <= EDGE_GUARD_PX || touchStartX >= vw - EDGE_GUARD_PX
			// 保留可横向滚动容器（例如 Market 横向菜单）的手势，不拦截其内部 touch
			edgeSwipeBlock = startedAtEdge && !hasHorizontalScrollableAncestor(targetEl)
		}

		const touchMoveIsOnInteractiveGesture = (e: TouchEvent) => {
			for (let i = 0; i < e.touches.length; i++) {
				if (interactiveTouchIds.has(e.touches[i].identifier)) return true
			}
			return false
		}

		const clearInteractiveTouchIds = (e: TouchEvent) => {
			for (let i = 0; i < e.changedTouches.length; i++) {
				interactiveTouchIds.delete(e.changedTouches[i].identifier)
			}
		}

		const handleTouchMove = (e: TouchEvent) => {
			const touchTarget = e.target

			const touch = e.touches[0]
			if (!touch) return

			if (touchMoveIsOnInteractiveGesture(e)) return

			// 禁用 iOS/PWA 边缘左右滑动返回/前进手势
			if (edgeSwipeBlock) {
				const dx = touch.clientX - touchStartX
				const dy = touch.clientY - touchStartY
				if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy) + 2) {
					stopEvent(e)
					return
				}
			}

			if (!touchTarget) return

			const elHit = touchTargetToElement(touchTarget)
			if (!elHit) return

			/** 可点击控件（含点在按钮内文字/SVG 子节点时）：勿对 touchmove preventDefault，否则会吞掉 tap */
			if (isTouchInteractiveTarget(elHit)) {
				return
			}

			const root = (document.scrollingElement as HTMLElement) || document.documentElement
			let node: Element | null = elHit
			while (node && node !== root && !(node instanceof HTMLElement && canScroll(node))) {
				node = node.parentElement
			}

			if (!node || node === root) {
				stopEvent(e)
				return
			}

			const current = node as HTMLElement

			if (bodyRef.current && current === bodyRef.current) {
			return
			}

			const anyEl = current as any
			const lastY = anyEl.__lastTouchY as number | undefined
			anyEl.__lastTouchY = touch.clientY
			if (lastY === undefined) return

			const deltaY = touch.clientY - lastY
			const atTop = current.scrollTop <= 0
			const atBottom = current.scrollTop + current.clientHeight >= current.scrollHeight - 1

			if ((atTop && deltaY > 0) || (atBottom && deltaY < 0)) {
				stopEvent(e)
			}
		}

		const handleTouchEnd = (e: TouchEvent) => {
			edgeSwipeBlock = false
			clearInteractiveTouchIds(e)
			const elHit = touchTargetToElement(e.target)
			if (!elHit) return

			let el: Element | null = elHit
			const root = (document.scrollingElement as HTMLElement) || document.documentElement

			while (el && el !== root) {
				if (el instanceof HTMLElement && (el as any).__lastTouchY !== undefined) {
					delete (el as any).__lastTouchY
				}
				el = el.parentElement
			}
		}

		document.addEventListener("touchstart", handleTouchStart, capturePassiveStart)
		document.addEventListener("touchmove", handleTouchMove, captureActiveMove)
		document.addEventListener("touchend", handleTouchEnd, capturePassiveStart)
		document.addEventListener("touchcancel", handleTouchEnd, capturePassiveStart)
		// iOS 某些场景下 document 层拦截不足，补一层 window capture
		window.addEventListener("touchmove", handleTouchMove, captureActiveMove)

		return () => {
			document.removeEventListener("touchstart", handleTouchStart as any, captureOpts)
			document.removeEventListener("touchmove", handleTouchMove as any, captureOpts)
			document.removeEventListener("touchend", handleTouchEnd as any, captureOpts)
			document.removeEventListener("touchcancel", handleTouchEnd as any, captureOpts)
			window.removeEventListener("touchmove", handleTouchMove as any, captureOpts)
		}
	}, [])

	const initProceed = async (source = 'mount', temp?: encrypt_keys_object) => {
		// Terminal (the update prompt, decided by the gate on a fallback shell): no read, no bridge command, no retry until the user's Retry.
		if (isShellContext() && isShellTerminal()) {
			publishNativePwaLog('warn', `[AppShell] init skip (${source}): terminal update prompt; no read, no retry`)
			return
		}
		publishNativePwaLog('info', `[AppShell] init start (${source})`)
		// the unlock restart (lock → unlock) owns the chat start when it claimed this run: this run then skips its own initChat (single entry).
		const unlockOwnsChatStart = takeUnlockChatOwnership()

		// Shell: the native wallet's public seed in memory is the wallet; page storage is not read there.
		// (A): in a shell the in-memory native seed is read again after the storage read: the native wallet may be applied while the
		// read is in flight, and the snapshot taken before the read is not the account the gate entered.
		let isAcc = temp ?? (isShellContext() && CoNET_Data?.profiles?.length ? CoNET_Data : null)
		if (!isAcc) {
			const fromStore = await checkStorage()
			isAcc = isShellContext() && CoNET_Data?.profiles?.length ? CoNET_Data : fromStore
		}
		if ((!isAcc || !hasLocalPlaintextMnemonic(isAcc)) && !temp) {
			const provisioned = await withBootTimeout(ensureEphemeralWalletForCouponClaim(), BOOT_PROVISION_TIMEOUT_MS, null)
			if (provisioned) {
				isAcc = provisioned
				temp = provisioned
			}
		}

		if (!isAcc) {
			if (isShellContext()) {
				// (B): a shell with no account read yet does not set the loading flag. The entry gate owns the bar, and its native or
				// page entry asks this init to run again (dispatchBeamioWalletReady) once the account is in memory.
				// shellTerminalState.runEmptyReadBranch: the terminal is decided first; a terminal at any point before this line schedules nothing
				// and logs nothing. Bounded re-reads (2, 4, 8, 16 s, then 30 s) only while the start is not terminal (r92 step 5).
				runEmptyReadBranch({
					nextAttempt: () => {
						const attempt = shellEmptyReadRetryRef.current + 1
						shellEmptyReadRetryRef.current = attempt
						return attempt
					},
					delayFor: startupRetryDelayMs,
					log: (line) => publishNativePwaLog('info', line),
					schedule: (delay) => {
						setShellInitPending(true)
						window.dispatchEvent(new Event(STARTUP_RETRY_OFFER_EVENT))
						if (shellEmptyReadTimerRef.current !== null) window.clearTimeout(shellEmptyReadTimerRef.current)
						shellEmptyReadTimerRef.current = window.setTimeout(() => {
							shellEmptyReadTimerRef.current = null
							if (isShellTerminal()) return
							// (option A): while a pre-read round is open, the retry sends no native read; it waits for that round's conclusion
							const inFlight = nativePrereadRoundInFlight()
							if (inFlight) {
								void inFlight.then(() => {
									if (!isShellTerminal()) void init('empty-read-retry')
								})
								return
							}
							void init('empty-read-retry')
						}, delay)
					},
				})
				return
			}
			publishNativePwaLog('info', '[AppShell] init skip: no local wallet storage')
			setIsInitialLoading(true)
			return 
		}

		setShellInitPending(false)
		shellEmptyReadRetryRef.current = 0
		temp = temp || isAcc
		temp = ensureProfilePrivateKeyArmorFromMnemonic(temp) ?? temp

		const profiles = temp?.profiles

		if (!temp || !profiles) {
			publishNativePwaLog('info', '[AppShell] init skip: missing profiles')
			// (B): the same rule as above: a shell does not hold the bar hidden here; the entry gate owns it.
			if (!isShellContext()) setIsInitialLoading(true)
			else setShellInitPending(true)
			return 
		}

		const keyOnlyEntry = keyOnlyEntryDecision(temp, isShellContext())
		if (keyOnlyEntry === 'hold_no_key') {
			// Per: "只要没有助记词，就进入 onboarding 页面": a record without a valid mnemonic is not an account, so it is
			// not an entry and binds no push. The loading flag is not set here: the entry gate decides (onboarding when both sides confirm none;
			// unknown is kept and retried). The record is kept; nothing is written or deleted here.
			publishNativePwaLog('info', '[AppShell] init skip: no valid mnemonic — not an entry (entry gate decides)')
			setCoNET_Data(temp)
			setProfiles(profiles)
			setKeyOnlyEntered(false)
			return
		}
		//a shell runs the init once per account. A second call for the same account (the loading page's wallet-ready, or
			// the entry gate's re-run) would repeat the chat start, the push bind and the history reload, so it is a skip.
			if (isShellContext()) {
				const enteredKey = (profiles[0]?.keyID || '').trim().toLowerCase()
				if (enteredKey && shellEnteredAccountRef.current === enteredKey) {
					publishNativePwaLog('info', `[AppShell] init skip: account already entered (${source}); re-entry guard`)
					return
				}
				if (enteredKey) shellEnteredAccountRef.current = enteredKey
			}
			// (2026-11-17) a key without a valid mnemonic never enters in the browser: keyOnlyEntryDecision holds it; the gate decides.

		// an active gossip for ANOTHER account is not kept: the start goes on, and chat.ts stops the old client first.
		setKeyOnlyEntered(false)
		if (gossipActiveRef.current && gossipStartDecision({ gossip: true, bound: boundAccountOfActiveClient(), account: historyAccountNow(), shell: isShellContext() }) === 'skip') {
			// Onboard LoadingPage may have already started gossip — still bind push here.
			publishNativePwaLog('info', '[AppShell] init skip chat (gossip active); ensuring push bind')
			setCoNET_Data(temp)
			setProfiles(profiles)
			ensurePushDeviceTokenListener()
			ensureNativePushBoundForWallet(profiles[0])
			// History restore is owned by the worker; re-kick in case the early gossip=true
			// race queued a load before activeClient existed (or App effect ran too early).
			void loadWorkerHistory(undefined, 'historyEoa_change')
			setIsInitialLoading(false)
			return
		}

		publishNativePwaLog('info', '[AppShell] init proceeding → initChat')

		setCoNET_Data(temp)
		setProfiles(profiles)
		// (B): a shell's bar is shown once the account is in the App's state. The entry gate keeps it hidden until then.
		if (isShellContext()) setIsInitialLoading(false)

		// SDK chat preheat (non-blocking; sdk-roles-chat-preheat.v1 SDR-08): the history load is requested at account-ready, in parallel
		// with the wallet start and the offline home. Nothing awaits it here; the UI reads the same in-flight preheat (awaitChatPreheat).
		// Browser runtime only (shell: no-op). The worker start is the browser chat start, and its history tail is the completion signal.
		void startChatPreheat({
			accountKey: profiles[0]?.keyID || '',
			shell: isShellContext(),
			mnemonicHandle: () => (typeof temp?.mnemonicPhrase === 'string' ? temp.mnemonicPhrase : null),
			startWorker: () => initChat(setProfiles, setAllNodes, setGossip, false, handleInitChatLine),
			awaitHistoryTail: () => awaitWorkerHistoryTail(),
		})

		
		//the read is retried on a capped ladder (30 s, 2 min, 10 min). A failed read is not "no account", and after the
		// last retry the init gives up: the claim is released (the user's retry runs the init again) and the notice shows.
		const epochAtStart = accountInfoEpochRef.current
		const loaded = await loadUserInfoWithBackoff(
			() => getUserInfoLookup(profiles[0].keyID),
			{
				wait: (ms) => new Promise<void>((resolve) => { window.setTimeout(resolve, ms) }),
				stopped: () => accountInfoEpochRef.current !== epochAtStart,
			},
		)
		if (loaded.status === 'stopped') {
			publishNativePwaLog('info', '[AppShell] account info read stopped (vault lock or sign-out)')
			return
		}
		if (loaded.status === 'unavailable') {
			publishNativePwaLog('warn', `[AppShell] account info unavailable (${loaded.reason}) after ${loaded.reads} reads; the user can retry`)
			if (isShellContext()) shellEnteredAccountRef.current = null
			setAccountInfoUnavailable(loaded.reason)
			return
		}
		setAccountInfoUnavailable(null)
		const userInfo = loaded.info
		if (!userInfo) return
		
		let bo: beamio = mergeLocalLocaleLanguageOntoChainProfile(userInfo, temp.beamio)
		const pk = profiles[0]?.privateKeyArmor
		if (pk) {
			// a stalled save of the locale never holds the chat start and the profile (both come after this line).
			bo = await withBootTimeout(bootstrapProfileLocaleCurrencyIfUnset(bo), BOOT_LOCALE_SYNC_TIMEOUT_MS, bo)
		} else {
			const { applyBeamioUiLanguageFromProfile } = await import('@/locale/i18n')
			await applyBeamioUiLanguageFromProfile(bo.language)
		}

		if (unlockOwnsChatStart) {
			publishNativePwaLog('info', `[AppShell] init skip initChat (${source}): the unlock restart owns the chat start`)
		} else {
			await initChat(setProfiles,setAllNodes, setGossip, gossipActiveRef.current, handleInitChatLine)
		}

		ensurePushDeviceTokenListener()
		ensureNativePushBoundForWallet(profiles[0])
		
		
		bo.initialLoading = true
		
		
		
		setBeamio (bo)
		temp.beamio = bo
		
		setCoNET_Data(temp)
		await storeSystemData()
		const eoa = profiles[0]?.keyID?.trim()
		if (eoa && ethers.isAddress(eoa)) {
			setMyAddress(eoa)
			// the account effect (useAccountBindEffects) is the single AA ensure of an init; no second call here.
		}
		setIsInitialLoading(false)

  	}

	/** a run that fails after it claimed the account releases the claim, so a later wake-up can enter again. */
	const runInit = async (source = 'mount', temp?: encrypt_keys_object) => {
		const claimedBefore = shellEnteredAccountRef.current
		try {
			await initProceed(source, temp)
		} catch (err) {
			shellEnteredAccountRef.current = claimedBefore
			publishNativePwaLog('error', `[AppShell] init failed (${source}): ${err instanceof Error ? err.message : String(err)}; the account claim is released`)
		}
	}

	// The browser start runs one init at a time. A call that arrives while a run is in flight (the mount init and the loading
	// page's wallet-ready run together at start) is queued and runs once after it; the gossip guard in the run skips the chat restart.
	// The shell keeps its own once-per-account guard.
	const browserInitFlightRef = useRef({ running: false, queued: false })
	const init = async (source = 'mount', temp?: encrypt_keys_object): Promise<void> => {
		if (isShellContext()) return runInit(source, temp)
		const flight = browserInitFlightRef.current
		if (flight.running) {
			flight.queued = true
			publishNativePwaLog('info', `[AppShell] init queued behind the browser init in flight (${source})`)
			return
		}
		flight.running = true
		try {
			await runInit(source, temp)
		} finally {
			flight.running = false
			if (flight.queued) {
				flight.queued = false
				// the queued run takes no temp: no current call site passes one to a queued init (the mount and wallet-ready calls pass none), so a temp
				// argument that arrived during the flight would be dropped here. Keep it that way, or pass the temp through the queue.
				void init('queued-after-flight')
			}
		}
	}

	// a vault lock or a sign-out forgets the entered account (the next wake-up runs the init again).
	useEffect(() => {
		//a lock or a sign-out also stops a pending account read (its epoch changes) and clears the notice.
		const forget = () => {
			shellEnteredAccountRef.current = null
			accountInfoEpochRef.current += 1
			setAccountInfoUnavailable(null)
		}
		window.addEventListener(VAULT_LOCKED_EVENT, forget)
		window.addEventListener(SHELL_ENTRY_RESET_EVENT, forget)
		return () => {
			window.removeEventListener(VAULT_LOCKED_EVENT, forget)
			window.removeEventListener(SHELL_ENTRY_RESET_EVENT, forget)
		}
	}, [])

	// lock → unlock: the chat start runs once here, explicitly, with gossip off (the same reload as the foreground resume).
	// The unlock callback claims it before init(); init then skips its own initChat (src/services/unlockChatRestart.ts).
	useEffect(() => {
		// the branch choice lives in unlockChatRestart.ts (injected deps, unit-tested): a shell with a native listen never tears it down.
		registerUnlockChatRestart(() => runUnlockChatStart({
			isShell: isShellContext(),
			resumeNativeListen: resumeNativeChatListen,
			reloadHistory: () => { void loadWorkerHistory(undefined, 'historyEoa_change') },
			setGossip,
			prepareListenResume: prepareGossipListenResume,
			initChat: (gossip) => initChat(setProfiles, setAllNodes, setGossip, gossip, handleInitChatLine),
			log: (msg) => publishNativePwaLog('info', `[AppShell] ${msg}`),
		}).catch((err) => {
			publishNativePwaLog('error', `[AppShell] chat restart after unlock failed: ${err instanceof Error ? err.message : String(err)}`)
		}))
		return () => registerUnlockChatRestart(null)
	}, [handleInitChatLine, setGossip])

	//the notice's "Try again" runs the init again (its claim was released when the init gave up).
	useEffect(() => {
		const onAccountInfoRetry = () => { void init('account-info-retry') }
		window.addEventListener(ACCOUNT_INFO_RETRY_EVENT, onAccountInfoRetry)
		return () => {
			window.removeEventListener(ACCOUNT_INFO_RETRY_EVENT, onAccountInfoRetry)
		}
	}, [])

	// 首次进入 + 钱包恢复后重试 gossip（冷启动时 AppShell 往往早于 recover 完成）
	useEffect(() => {
		void init('mount')
    const removePwaLifecycleRecovery = installPwaLifecycleRecovery()

		const onWalletReady = () => {
			void init('wallet-ready')
		}
		window.addEventListener(BEAMIO_WALLET_READY_EVENT, onWalletReady)

		// Home / app-switcher: keep gossip listen alive so the still-running PWA can receive
		// chat into UI. System push is SI mailbox → APNs/FCM (do not also bridge local notify).
		// Only tear down listen on pagehide / bfcache (true unload) so offline saveLocal works.
		let mailboxWakeResumeInFlight = false
		const onForegroundResume = (force = false) => {
			if (force && mailboxWakeResumeInFlight) {
				publishNativePwaLog('info', '[AppShell] native mailbox wake already resuming gossip listen')
				return
			}
			if (force) mailboxWakeResumeInFlight = true
			void resumeGossipListenOnForeground(
				setProfiles,
				setAllNodes,
				setGossip,
				message => {
					noteVoiceCallsEnded(voiceCallHandlesEndedInBatch([message], recoverChatSigner))
					applyNativeIncomingVoiceOfferFromLine(message)
					setChartsRef.current((prev: string[]) => [...prev, message])
				},
				45_000,
				force,
			)
				.catch(err => {
					publishNativePwaLog(
						'warn',
						`[AppShell] gossip foreground resume failed: ${(err as Error)?.message ?? String(err)}`,
					)
				})
				.finally(() => {
					if (force) mailboxWakeResumeInFlight = false
				})
		}
		const onNativeMailboxWake = (event: Event) => {
			const detail = (event as CustomEvent<{ action?: string }>).detail
			if (detail?.action !== 'mailboxWake') return
			// Android's live SSE is the path that delivers the callee user-PGP
			// offer. Forcing a reconnect aborts that stream after the mailbox
			// has already counted the write as delivered, so the system banner
			// never receives the recovered wallet or BeamioTag. Resume only when
			// the listen is actually down. iOS WKWebView can freeze a fetch that
			// still looks open, so that shell still forces a new listen.
			if (getCashTreesNativeNfcHost() === 'android') {
				publishNativePwaLog('info', '[AppShell] native mailbox wake — keeping live Android gossip listen')
				onForegroundResume(false)
				return
			}
			publishNativePwaLog('info', '[AppShell] native mailbox wake — forcing gossip listen resume')
			onForegroundResume(true)
		}
		window.addEventListener('cashtreesandroid', onNativeMailboxWake)
		const onVisibility = () => {
			if (document.visibilityState === 'visible') {
				onForegroundResume()
			}
		}
		const onPageShow = (ev: PageTransitionEvent) => {
			// bfcache restore or shell bring-to-front — do not abort a connecting stream
			if (ev.persisted || document.visibilityState === 'visible') onForegroundResume()
		}
		document.addEventListener('visibilitychange', onVisibility)
		window.addEventListener('pageshow', onPageShow)
		const onPageHide = () => {
			// True unload / bfcache — drop listen so mailbox can saveLocal + APNs for killed app.
			pauseGossipListenOnBackground(setGossip)
		}
		window.addEventListener('pagehide', onPageHide)

		return () => {
			window.removeEventListener(BEAMIO_WALLET_READY_EVENT, onWalletReady)
			document.removeEventListener('visibilitychange', onVisibility)
			window.removeEventListener('pageshow', onPageShow)
			window.removeEventListener('pagehide', onPageHide)
			window.removeEventListener('cashtreesandroid', onNativeMailboxWake)
			removePwaLifecycleRecovery()
			// Do NOT abort gossip / setGossip(false) here.
			// React StrictMode remount + LoadingPage/AppShell dual init previously killed the
			// SSE, which made mailbox B call setUserOnlineOnMe true/false in a tight loop.
			// Gossip is process-lifetime; only replace via connectToGossipNode when dead.
		}
	}, [])

	const profilesForVoiceDeclineRef = useRef(profiles)
	const allNodesForVoiceDeclineRef = useRef(allNodes)
	const setProfilesForVoiceRef = useRef(setProfiles)
	profilesForVoiceDeclineRef.current = profiles
	// Seed recipient → mailbox routes from saved chats so sendMessage can keep
	// each recipient's mailbox out of the entry pool.
	useEffect(() => {
		const chats = profiles?.[0]?.chats
		if (!Array.isArray(chats)) return
		for (const chat of chats) {
			rememberRecipientRoute(chat?.chatData?.publicArmored, chat?.chatData?.routersArmoreds)
		}
	}, [profiles])
	allNodesForVoiceDeclineRef.current = allNodes
	setProfilesForVoiceRef.current = setProfiles
	/**
	 * CallKit Decline / Telecom Decline can fire before gossip decrypt has
	 * remembered the offer, or before chats[] has the caller's route/PGP.
	 * Retry like Answer until we can send voice_call_reject_v1 to offer.from —
	 * never the currently open Chat peer — so the dialer stops "Ringing".
	 */
	useEffect(() => {
		let retryTimer: number | undefined
		let cancelled = false
		let attempts = 0
		let inFlightKey: string | null = null

		const onNativeDecline = (event: Event) => {
			const detail = (event as CustomEvent<{
				action?: string
				callId?: string
				sessionId?: string
			}>).detail
			// callTimedOutNative: the iOS shell already told the caller; record only.
			// callUnreachable: our dial got no ringing receipt; the shell sent the cancel; record only.
			if (
				detail?.action !== 'callRejected'
				&& detail?.action !== 'callTimedOut'
				&& detail?.action !== 'callTimedOutNative'
				&& detail?.action !== 'callUnreachable'
			) return
			const terminalStatus = detail.action === 'callRejected'
				? 'declined'
				: detail.action === 'callUnreachable' ? 'unreachable' : 'timed_out'
			const sessionId = String(detail.sessionId || '').trim()
			const callId = String(detail.callId || '').trim()
			// the row keeps the ids as the shell sent them. Matching below uses the trimmed ids; a row never takes the other field's value.
			const rowCallId = String(detail.callId ?? '')
			const rowSessionId = String(detail.sessionId ?? '')
			if (!sessionId && !callId) return
			const flightKey = `${callId}:${sessionId}:${detail.action}`
			if (inFlightKey === flightKey) return
			inFlightKey = flightKey
			attempts = 0

			// Snapshot before chat.tsx / other handlers can clear the registry.
			const offerAtEvent = lookupIncomingVoiceOffer(callId, sessionId)

			let dialerSide = false
			// Prefer CoNET_Data — React profiles / ref can lag Chat's upsert in the same tick.
			const dataProfiles = CoNET_Data?.profiles
			const currentProfiles = Array.isArray(dataProfiles) && dataProfiles.length
				? dataProfiles
				: profilesForVoiceDeclineRef.current
			if (Array.isArray(currentProfiles) && currentProfiles[0] && (sessionId || callId)) {
				const rows: PhoneCallRecord[] = Array.isArray(currentProfiles[0].phoneCalls) ? currentProfiles[0].phoneCalls : []
				const existing = findPhoneCallByIds(rows, { callId, sessionId })
					|| [...rows]
						.filter(item =>
							item.direction === 'outgoing'
							&& (item.status === 'ringing' || item.status === 'answered'))
						.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))[0]
				// Callee Decline has an incoming offer → keep incoming. Only invent
				// outgoing when this device is the dialer (no offer in registry).
				const preferOutgoing = Boolean(
					existing?.direction === 'outgoing'
					|| (!existing && !offerAtEvent),
				)
				const direction = preferOutgoing
					? 'outgoing'
					: (existing?.direction || (offerAtEvent ? 'incoming' : 'outgoing'))
				dialerSide = direction === 'outgoing'
				const merged = mergePhoneCallRecord(existing, {
					callId: rowCallId || existing?.callId || offerAtEvent?.callId || '',
					sessionId: rowSessionId || existing?.sessionId || offerAtEvent?.sessionId || '',
					peerAddress: existing?.peerAddress || offerAtEvent?.from || '',
					direction,
					status: terminalStatus,
					createdAt: existing?.createdAt || Number(offerAtEvent?.createdAt) || Date.now(),
					endedAt: Date.now(),
				})
				if (merged && (!existing || existing.status !== merged.status)) {
					const next = currentProfiles.slice()
					next[0] = {
						...currentProfiles[0],
						phoneCalls: replacePhoneCallInRows(rows, merged)
							.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))
							.slice(0, 200),
					}
					profilesForVoiceDeclineRef.current = next
					setProfilesForVoiceRef.current(next)
					if (CoNET_Data) CoNET_Data.profiles = next
					void storeSystemData()
				}
			}

			// Our own dial: the shell's dialer already handled it (the callee's reject
			// or timeout came in, or the shell sent our timeout). Telling the "peer"
			// again gave the callee a second timeout.
			if (detail.action === 'callTimedOutNative' || detail.action === 'callUnreachable' || dialerSide) {
				inFlightKey = null
				return
			}

			const tryNotifyPeer = async () => {
				if (cancelled) return
				const offer = offerAtEvent || lookupIncomingVoiceOffer(callId, sessionId)
				const privateKey = resolveSigningPrivateKeyArmor(profilesForVoiceDeclineRef.current?.[0])
				if (!offer || !privateKey) {
					attempts += 1
					if (attempts < 24) {
						retryTimer = window.setTimeout(() => { void tryNotifyPeer() }, 500)
					} else {
						inFlightKey = null
					}
					return
				}
				const caller = String(offer.from || '').trim()
				if (!ethers.isAddress(caller)) {
					inFlightKey = null
					return
				}
				const chats = profilesForVoiceDeclineRef.current?.[0]?.chats as
					| Array<{ address?: string; chatData?: { publicArmored?: string; routersArmoreds?: string } }>
					| undefined
				const { peerPgp, peerRoute } = await resolvePeerVoiceMaterialAsync(chats, caller, privateKey)
				if (!peerPgp && !peerRoute) {
					attempts += 1
					if (attempts < 24) {
						retryTimer = window.setTimeout(() => { void tryNotifyPeer() }, 500)
					} else {
						inFlightKey = null
					}
					return
				}
				const localWallet = new ethers.Wallet(privateKey).address
				const notify = detail.action === 'callTimedOut'
					? timeoutIncomingVoiceOffer
					: declineIncomingVoiceOffer
				try {
					await notify({
						privateKey,
						localCallId: localWallet,
						peerEoa: caller,
						peerPgp,
						peerRoute,
						allNodes: allNodesForVoiceDeclineRef.current || [],
					}, offer)
				} finally {
					inFlightKey = null
				}
			}

			void tryNotifyPeer()
		}
		window.addEventListener('cashtreesandroid', onNativeDecline)
		window.addEventListener('cashtreesios', onNativeDecline)
		return () => {
			cancelled = true
			if (retryTimer !== undefined) window.clearTimeout(retryTimer)
			window.removeEventListener('cashtreesandroid', onNativeDecline)
			window.removeEventListener('cashtreesios', onNativeDecline)
		}
	}, [])

	/**
	 * Android can answer the native call window while this Chat instance is
	 * unmounted (cold start, Chat list, or another PWA page). In that case
	 * chat.tsx cannot observe `callAnswered`, so the native event used to be
	 * consumed without opening the peer thread or sending the accept signal.
	 *
	 * Keep the action local and retry briefly until the decrypted offer has
	 * reached the PWA's voice-session registry. The offer remains the only
	 * source of caller identity; native code supplies handles only.
	 *
	 * Hang-up / reject / timeout must cancel any in-flight late-accept retry —
	 * otherwise a late offer hydrate can navigate with autoVoiceCallAction and
	 * leave the PWA stuck in the full-screen call UI after End Call.
	 */
	useEffect(() => {
		let retryTimer: number | undefined
		let cancelled = false
		let attempts = 0
		let pendingAnswerKey: string | null = null

		const clearLateAccept = () => {
			if (retryTimer !== undefined) {
				window.clearTimeout(retryTimer)
				retryTimer = undefined
			}
			attempts = 0
			pendingAnswerKey = null
			nativeVoiceAnswerKeyRef.current = null
		}

		// Store a change to the call rows (null from `change` = nothing to store).
		const commitCallRows = (change: (rows: PhoneCallRecord[]) => PhoneCallRecord[] | null) => {
			const dataProfiles = CoNET_Data?.profiles
			const currentProfiles = Array.isArray(dataProfiles) && dataProfiles.length
				? dataProfiles
				: profilesForVoiceDeclineRef.current
			if (!currentProfiles?.[0]) return
			const rows: PhoneCallRecord[] = Array.isArray(currentProfiles[0].phoneCalls)
				? currentProfiles[0].phoneCalls
				: []
			const changed = change(rows)
			if (!changed) return
			const next = currentProfiles.slice()
			next[0] = {
				...currentProfiles[0],
				phoneCalls: changed
					.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))
					.slice(0, 200),
			}
			profilesForVoiceDeclineRef.current = next
			setProfilesForVoiceRef.current(next)
			if (CoNET_Data) CoNET_Data.profiles = next
			void storeSystemData()
			askShellWhichIncomingCallsRang(next[0].phoneCalls)
		}

		// Close still-ringing incoming rows the shell already ended (see noteIncomingCallSettled).
		const closeSettledIncomingRowsNow = () => commitCallRows(closeSettledIncomingCalls)

		// The shell answers whether a cancelled incoming call rang here; never rang = missed.
		const onIncomingCallOutcome = (event: Event) => {
			const detail = (event as CustomEvent<{
				action?: string
				callId?: string
				sessionId?: string
				rang?: boolean
			}>).detail
			if (detail?.action !== 'incomingCallOutcome' || detail.rang !== false) return
			const ids = { callId: String(detail.callId || ''), sessionId: String(detail.sessionId || '') }
			commitCallRows(rows => {
				const next = markIncomingCallNeverRang(rows, ids)
				if (next) publishNativePwaLog('info', '[voice] incoming call never rang here; recorded as missed')
				return next
			})
		}

		const onNativeHangupCancelsLateAccept = (event: Event) => {
			const detail = (event as CustomEvent<{
				action?: string
				callId?: string
				sessionId?: string
				settledAs?: string
			}>).detail
			if (detail?.action === 'callBusyRejected') {
				// The shell rejected this incoming call as busy (we were in another
				// call) and already told the caller. Record only:
				// "Missed call · While on another call".
				const callId = String(detail.callId || '').trim()
				const sessionId = String(detail.sessionId || '').trim()
				if (!callId && !sessionId) return
				publishNativePwaLog('info', '[voice] shell rejected an incoming call as busy')
				// No terminal mark here: a replayed offer must still create its row,
				// which the settled outcome then turns into "busy".
				noteVoiceCallsEnded([callId, sessionId])
				noteIncomingCallSettled(callId, sessionId, 'busy')
				forgetIncomingVoiceOffer(callId || sessionId, sessionId || callId)
				setGlobalIncomingVoiceCall(current =>
					(sessionId && sameCallId(current?.signal?.sessionId, sessionId)) || (callId && sameCallId(current?.signal?.callId, callId))
						? null
						: current,
				)
				closeSettledIncomingRowsNow()
				return
			}
			if (detail?.action === 'incomingCallSettled') {
				// The page re-reported an offer the shell had already ended (a cold
				// start replays it). Record only: no banner change, nothing to the caller.
				const callId = String(detail.callId || '').trim()
				const sessionId = String(detail.sessionId || '').trim()
				const status = incomingSettledStatusForAction(detail.settledAs)
				if (!status || (!callId && !sessionId)) return
				publishNativePwaLog('info', `[voice] shell says incoming call already ended as ${status}`)
				noteVoiceCallsEnded([callId, sessionId])
				noteIncomingCallSettled(callId, sessionId, status)
				forgetIncomingVoiceOffer(callId || sessionId, sessionId || callId)
				setGlobalIncomingVoiceCall(current =>
					(sessionId && sameCallId(current?.signal?.sessionId, sessionId)) || (callId && sameCallId(current?.signal?.callId, callId))
						? null
						: current,
				)
				closeSettledIncomingRowsNow()
				return
			}
			if (
				detail?.action !== 'callEnded'
				&& detail?.action !== 'callRejected'
				&& detail?.action !== 'callTimedOut'
			) {
				return
			}
			const callId = String(detail.callId || '').trim()
			const sessionId = String(detail.sessionId || '').trim()
			if (callId || sessionId) {
				forgetIncomingVoiceOffer(callId || sessionId, sessionId || callId)
			}
			if (detail.action === 'callEnded' && (callId || sessionId)) {
				// The shell ends an unanswered incoming call only when its caller stopped
				// (cancel, or the same caller ringing again while it still rang). With no
				// voice_end_v1 for it, the row would stay "Incoming call": close it here.
				// No row yet (cold start: this arrives before the inbox replays the offer):
				// the page reports the replayed offer and the shell answers incomingCallSettled,
				// which knows whether the call was answered.
				noteVoiceCallsEnded([callId, sessionId])
				const dataProfiles = CoNET_Data?.profiles
				const currentProfiles = Array.isArray(dataProfiles) && dataProfiles.length
					? dataProfiles
					: profilesForVoiceDeclineRef.current
				const existing = findPhoneCallByIds(currentProfiles?.[0]?.phoneCalls, { callId, sessionId })
				if (existing?.direction === 'incoming' && existing.status === 'ringing') {
					noteIncomingCallSettled(callId, sessionId, 'cancelled')
					closeSettledIncomingRowsNow()
				}
			}
			setGlobalIncomingVoiceCall(null)
			clearLateAccept()
		}

		const onNativeAnswer = (event: Event) => {
			const detail = (event as CustomEvent<{
				action?: string
				callId?: string
				sessionId?: string
			}>).detail
			if (detail?.action !== 'callAnswered') return

			const callId = String(detail.callId || '').trim()
			const sessionId = String(detail.sessionId || '').trim()
			const key = `${callId}:${sessionId}`
			if (!callId && !sessionId) return
			// The shell may answer before this page has the offer; remember it so
			// the call record ends as "Call ended", not "Call cancelled".
			noteNativeCallAnswered(callId, sessionId)
			if (nativeVoiceAnswerKeyRef.current === key) return
			nativeVoiceAnswerKeyRef.current = key
			pendingAnswerKey = key
			attempts = 0

			const openChatAndAccept = () => {
				if (cancelled) return
				if (pendingAnswerKey !== key) return
				const offer = lookupIncomingVoiceOffer(callId, sessionId)
				if (!offer) {
					attempts += 1
					if (attempts < 24) {
						retryTimer = window.setTimeout(openChatAndAccept, 500)
					} else {
						clearLateAccept()
					}
					return
				}

				const caller = String(offer.from || '').trim()
				if (!ethers.isAddress(caller)) {
					clearLateAccept()
					return
				}
				const existingChat = (profilesForVoiceDeclineRef.current?.[0]?.chats || [])
					.find((item: chatData) => item.address?.toLowerCase() === caller.toLowerCase())
				const resolved = resolvePeerSearchResult(caller)
				const contact: searchResult = existingChat?.beamio || resolved || {
					address: caller,
					created_at: 0,
					first_name: '',
					last_name: '',
					username: '',
					follow_count: '',
					follower_count: '',
					image: '',
				}

				setGlobalIncomingVoiceCall(null)
				setChatHomeItem(contact)
				navigate('/chat', {
					state: { autoVoiceCallAction: 'accept' },
				})
			}

			openChatAndAccept()
		}

		// Shell answered an incoming call itself: record only, no page accept.
		const onNativeConnected = (event: Event) => {
			const detail = (event as CustomEvent<{ action?: string; callId?: string; sessionId?: string }>).detail
			if (detail?.action !== 'callConnected') return
			noteNativeCallAnswered(String(detail.callId || ''), String(detail.sessionId || ''))
		}

		window.addEventListener('cashtreesandroid', onNativeConnected)
		window.addEventListener('cashtreesios', onNativeConnected)
		window.addEventListener('cashtreesandroid', onNativeAnswer)
		window.addEventListener('cashtreesios', onNativeAnswer)
		window.addEventListener('cashtreesandroid', onNativeHangupCancelsLateAccept)
		window.addEventListener('cashtreesios', onNativeHangupCancelsLateAccept)
		window.addEventListener('cashtreesandroid', onIncomingCallOutcome)
		// A ring revoked by a late tag lookup (v45 §50): recorded as declined, the same store as the other call rows.
		const onRingRevoked = (event: Event) => {
			const detail = (event as CustomEvent<{ callId?: string; sessionId?: string }>).detail
			const ids = { callId: String(detail?.callId || ''), sessionId: String(detail?.sessionId || '') }
			commitCallRows(rows => {
				const row = findPhoneCallByIds(rows, ids)
				return row && row.direction === 'incoming' ? replacePhoneCallInRows(rows, { ...row, status: 'declined' }) : null
			})
		}
		window.addEventListener('beamio-incoming-ring-revoked', onRingRevoked)
		return () => {
			window.removeEventListener('beamio-incoming-ring-revoked', onRingRevoked)
			window.removeEventListener('cashtreesandroid', onIncomingCallOutcome)
			cancelled = true
			clearLateAccept()
			window.removeEventListener('cashtreesandroid', onNativeConnected)
			window.removeEventListener('cashtreesios', onNativeConnected)
			window.removeEventListener('cashtreesandroid', onNativeAnswer)
			window.removeEventListener('cashtreesios', onNativeAnswer)
			window.removeEventListener('cashtreesandroid', onNativeHangupCancelsLateAccept)
			window.removeEventListener('cashtreesios', onNativeHangupCancelsLateAccept)
		}
	}, [navigate, resolvePeerSearchResult, setChatHomeItem])

	const resolvePeerSearchResultRef = useRef(resolvePeerSearchResult)
	const ensureProfilesForAddressesRef = useRef(ensureProfilesForAddresses)
	resolvePeerSearchResultRef.current = resolvePeerSearchResult
	ensureProfilesForAddressesRef.current = ensureProfilesForAddresses
	/** entries already merged in this session (see historyRestoreSeen.ts). */
	const restoredHistoryKeysRef = useRef<Set<string>>(new Set())
	// one source for the account of the history: accountEoaFor of the signing key.
	// The worker client is bound to the account it was created for (boundAccountOfActiveClient); a batch or a read is used only when they match.
	// Stable identities (no state in them), so the effects that use them do not re-run on each render.
	const historyAccountOf = useCallback(
		(profile: { privateKeyArmor?: string | null; keyID?: unknown } | null | undefined): string =>
			(accountEoaFor(resolveSigningPrivateKeyArmor(profile)) || '').toLowerCase(),
		[],
	)
	/**
	 * The account of the full history read and its merge. Browser: as historyAccountOf (the page key's account). Shell: the page holds no signing
	 * key, so it is the public EOA of the native identity (identityPublic), and only while the page's profile is that same account; a profile of
	 * another account never matches the native EOA, so nothing is merged into it.
	 */
	const corpusAccountOf = useCallback(
		(profile: { privateKeyArmor?: string | null; keyID?: unknown } | null | undefined): string => {
			if (isShellContext()) {
				const native = shellPublicEoaOrEmpty().toLowerCase()
				const keyId = typeof profile?.keyID === 'string' ? profile.keyID.trim().toLowerCase() : ''
				// not the native account (or the native identity is not known yet): the page-key account, as before; the merge then drops it
				// unless it equals the native EOA (shellAccountCheck)
				return native && keyId === native ? native : historyAccountOf(profile)
			}
			return historyAccountOf(profile)
		},
		[historyAccountOf],
	)
	const historyAccountNow = useCallback((): string => corpusAccountOf(CoNET_Data?.profiles?.[0]), [corpusAccountOf])
	// the merge of the history restore, for the corpus read scheduler (set by the restore effect while it is mounted).
	const applyEntriesRef = useRef<((entries: HistoryEntry[]) => void) | null>(null)

	// Restore encrypted chat history on a fresh device (post account delete/restore):
	// decrypt (worker) → create missing peer sessions → dedup-merge into `profile.chats[].messages`.
	// Recover wipes local chats[]; history must be allowed to CREATE sessions (not only merge).
	//
	// Critical: do NOT await AddressPGP / searchUsername for every peer on the main thread —
	// that froze the whole UI for seconds after launch (jitter + dead buttons until done).
	// Tag-db callbacks must stay in refs: an online/tag refresh must not re-read the corpus.
	useEffect(() => {
		let cancelled = false
		// Batches are serialized by the applier below (createHistoryApplier), so tail + backfill cannot stack concurrent merges.
		const yieldToUi = () => new Promise<void>((r) => window.setTimeout(r, 0))

		// (reviewer blocker A): the applier fixes the account of a batch when it is queued and runs it only while that account is current
		// (historyRestoreApply.ts, createHistoryApplier). The state write and the logs are here; the rules are in the module.
		const applier = createHistoryApplier({
			accountNow: () => historyAccountNow(),
			keyNow: () => {
				const p0 = CoNET_Data?.profiles?.[0]
				return resolveSigningPrivateKeyArmor(p0) || (typeof p0?.privateKeyArmor === 'string' ? p0.privateKeyArmor : '')
			},
			accountOfKey: (pk) => accountEoaFor(pk) || '',
			// shell: no page key; the batch account must be the native identity's EOA
			shellAccountCheck: isShellContext() ? (account: string) => shellPublicEoaOrEmpty().toLowerCase() === account : undefined,
			seen: restoredHistoryKeysRef.current,
			isCancelled: () => cancelled,
			existingPeersNow: () => {
				const chats = CoNET_Data?.profiles?.[0]?.chats
				return new Set((Array.isArray(chats) ? chats : []).map((c) => (c?.address || '').toLowerCase()))
			},
			createStubFor: async (pk, peer) => {
				// Local tag DB only — never block restore on remote searchUsername.
				const acc: searchResult | null = resolvePeerSearchResultRef.current(peer)
				try {
					return await createInboundChatSession(peer, pk, acc, { skipKeyFetch: true })
				} catch (ex) {
					console.warn('[historyRestore] createInboundChatSession failed', peer, ex)
					throw ex
				}
			},
			commit: (plan) => {
				const handle = { changed: false }
				startTransition(() => {
					setProfiles((prev) => {
						const list = Array.isArray(prev) ? prev : []
						// merged AND marked only while the page's account is still the plan's account (commitRestorePlan).
						const result = commitRestorePlan(list, plan, historyAccountNow(), restoredHistoryKeysRef.current)
						for (const line of result.logs) publishNativePwaLog(line.level, line.message)
						if (!result.changed) return prev
						handle.changed = true
						if (CoNET_Data?.profiles?.length) {
							CoNET_Data.profiles[0].chats = result.list[0].chats ?? []
							CoNET_Data.profiles[0].phoneCalls = result.list[0].phoneCalls ?? []
						}
						return result.list
					})
				})
				return handle
			},
			afterCommit: async (plan, handle) => {
				// Let React paint before scheduling IndexedDB stringify.
				await yieldToUi()
				if (handle.changed && !cancelled) void storeSystemData()
				const byPeer = plan.byPeer
				// Hydrate @beamioTag for peers restored as address-only stubs (local DB empty after recover).
				const peersNeedingTag = [...byPeer.keys()].filter((peer) => {
					const hit = resolvePeerSearchResultRef.current(peer)
					return !hit?.username?.trim()
				})
				if (peersNeedingTag.length && !cancelled) {
					void ensureProfilesForAddressesRef.current(peersNeedingTag, { maxPerTick: 28 })
						.then((map) => {
							if (cancelled || !map) return
							startTransition(() => {
								setProfiles((prev) => {
									const list = Array.isArray(prev) ? prev : []
									const profile = list[0]
									if (!profile) return prev
									const chats = Array.isArray(profile.chats) ? [...profile.chats] : []
									let localChanged = false
									for (const peer of peersNeedingTag) {
										const key = peer.toLowerCase()
										const rec = map[key]
										if (!rec) continue
										const enriched = searchResultFromProfileRecord(rec)
										const username = (enriched.username || '').trim()
										if (!username || username === '未知') continue
										const idx = chats.findIndex(
											(c) => (c?.address || '').toLowerCase() === key,
										)
										if (idx < 0) continue
										const curU = (chats[idx].beamio?.username || '').trim()
										if (curU === username) continue
										chats[idx] = {
											...chats[idx],
											beamio: {
												...(chats[idx].beamio || {}),
												...enriched,
												address: chats[idx].address || peer,
												username,
											},
										}
										localChanged = true
									}
									if (!localChanged) return prev
									const nextProfile = { ...profile, chats }
									const nextList = [...list]
									nextList[0] = nextProfile
									if (CoNET_Data?.profiles?.length) CoNET_Data.profiles[0].chats = chats
									void storeSystemData()
									return nextList
								})
							})
						})
						.catch(() => {})
				}
			},
			yieldToUi,
			onBatch: (peers, count) => publishNativePwaLog('info', `[historyRestore] batch peers=${peers} entries=${count}`),
			log: (line) => console.info(line),
		})
		const applyEntries = (entries: HistoryEntry[]) => applier.enqueue(entries)
		// the inbound lines of a client bound to another account are not delivered while this account is current.
		setCurrentAccountGetter(() => historyAccountNow())
		const unsub = onHistoryBuffer((batch, boundEoa) => {
			// a batch from a client bound to another account (an old client that was not stopped) is dropped.
			if (!shouldApplyBufferBatch(boundEoa, historyAccountNow())) return
			applyEntries(batch?.entries || [])
		})
		// the full corpus read is made by the scheduler below (once per account and key, and once the worker is ready).
		applyEntriesRef.current = applyEntries
		return () => {
			cancelled = true
			unsub()
			setCurrentAccountGetter(null)
			if (applyEntriesRef.current === applyEntries) applyEntriesRef.current = null
		}
	}, [setProfiles, historyAccountNow])

	// the history load follows the account (historyEoa) only. A gossip flip no longer loads (the listen start loads once). If the
	// worker is not ready yet, the bridge queues the request and runs it when it is.
	// the account of the history is the same source as the owner (accountEoaFor), not the keyID.
	const historyEoa = historyAccountOf(profiles?.[0])
	const prevHistoryEoaRef = useRef('')
	useEffect(() => {
		if (!historyEoa) return
		void loadWorkerHistory(undefined, 'historyEoa_change')
	}, [historyEoa])
	// (reviewer, conditional blocker B): an account change while a live client of the OLD account is running. Nothing else starts the
	// client of the new account (App init runs at mount and at wallet-ready only), so the change itself starts it. The decision is the same
	// as in initChat: a live browser client bound to another account is stopped and the start goes on. Shells keep their own listen.
	useEffect(() => {
		const previousAccount = prevHistoryEoaRef.current
		prevHistoryEoaRef.current = historyEoa
		const action = accountChangeAction({
			previousAccount,
			account: historyEoa,
			gossip: gossipActiveRef.current,
			bound: boundAccountOfActiveClient(),
			shell: isShellContext(),
		})
		if (action !== 'restart') return
		publishNativePwaLog('warn', '[AppShell] account changed while the listen of another account is live: restarting the listen')
		void initChat(setProfiles, setAllNodes, setGossip, false, handleInitChatLine)
	}, [historyEoa, setProfiles, setAllNodes, setGossip, handleInitChatLine])
	// the full corpus read (historyCorpusRead.ts). It runs once per account, key and worker client: at mount with a key, when the key
	// arrives later, after a restore or a re-import, and when the worker is ready. A load or a buffer batch does not run it.
	const [workerEpoch, setWorkerEpoch] = useState(0)
	useEffect(() => onWorkerReady(() => setWorkerEpoch((n) => n + 1)), [])
	const corpusReadRef = useRef<CorpusReadScheduler | null>(null)
	if (!corpusReadRef.current) {
		corpusReadRef.current = createCorpusReadScheduler({
			read: () => readDecryptedChatHistory(),
			// a result is applied only while its account is still the page's account.
			apply: (entries, account) => {
				if (historyAccountNow() === account) applyEntriesRef.current?.(entries)
			},
			isCurrent: (account) => historyAccountNow() === account,
			boundAccount: () => boundAccountOfActiveClient(),
			// The seen set is cleared only when the account goes empty or changes; a key that is briefly missing does not clear it.
			onReset: () => restoredHistoryKeysRef.current.clear(),
			// shell: a failed or empty read is retried on the cold-start backoff (a 60 s window, no attempt-count stop), and the chat list says
			// "loading" until the read settles. The browser keeps its rules.
			backoff: isShellContext() ? createColdStartBackoff() : undefined,
			onStatus: isShellContext() ? setHistoryListStatus : undefined,
			log: (line) => console.info(line),
		})
	}
	const historyKeyPresent = !!(profiles?.[0]?.privateKeyArmor || '').trim()
	// shell: the read runs again when the chat start succeeds (identity ready, listen started)
	const [shellStartedTick, setShellStartedTick] = useState(0)
	const lastHistoryGateLogRef = useRef('')
	// shell: the native public EOA becoming known changes the account of the history read, so the read gate is evaluated again at that moment
	const [nativeEoaTick, setNativeEoaTick] = useState(0)
	useEffect(() => onShellPublicEoaChange(() => setNativeEoaTick((n) => n + 1)), [])
	useEffect(() => onShellChatStarted(() => setShellStartedTick((n) => n + 1)), [])
	useEffect(() => {
		// The account is the same source as the owner of a merge (accountEoaFor), not the keyID.
		const account = corpusAccountOf(profiles?.[0])
		// Shell: ready means the account exists and the native chat client is ready and bound to it (the page holds no key). Browser: the page key.
		const keyReady = isShellContext() ? !!account && boundAccountOfActiveClient() === account : !!resolveSigningPrivateKeyArmor(profiles?.[0])
		if (isShellContext() && process.env.REACT_APP_QA_BRIDGE_COUNTER === 'true') {
			// QA only, booleans and integers: why the full history read has no account or no ready client (once per distinct state)
			const nativeKnown = !!shellPublicEoaOrEmpty()
			const keyIdOk = typeof profiles?.[0]?.keyID === 'string' && profiles[0].keyID.trim() !== ''
			const line = `history gate account=${account ? 1 : 0} native=${nativeKnown ? 1 : 0} keyid=${keyIdOk ? 1 : 0} bound=${boundAccountOfActiveClient() === account && account ? 1 : 0} epoch=${workerEpoch + shellStartedTick}`
			if (line !== lastHistoryGateLogRef.current) {
				lastHistoryGateLogRef.current = line
				if (process.env.REACT_APP_QA_BRIDGE_COUNTER === 'true') qaLine('[persist]', line)
			}
		}
		corpusReadRef.current?.sync({
			account,
			keyReady,
			epoch: workerEpoch + shellStartedTick,
		})
	}, [historyKeyPresent, workerEpoch, shellStartedTick, nativeEoaTick, profiles, corpusAccountOf])
	// shell: when the native chat has started its route table is empty, so the page's table is sent again and the routes of the recent conversations (at most 64)
	// are fetched in the background, one at a time (a contact's route is offered to the native module for the delivered receipt)
	useEffect(() => {
		if (!nativeReceiptPath() || shellStartedTick === 0) return
		nativeRoutes.resend()
		let cancelled = false
		const chats = CoNET_Data?.profiles?.[0]?.chats
		const recent = (Array.isArray(chats) ? [...chats] : [])
			.sort((a, b) => lastMessageTsOf(b) - lastMessageTsOf(a))
			.slice(0, 64)
			.map((c) => String(c?.address ?? '').toLowerCase())
			.filter(Boolean)
		void (async () => {
			for (const address of recent) {
				if (cancelled) return
				await offerContactRoute(address)
				await new Promise<void>((resolve) => setTimeout(resolve, 150))
			}
		})()
		return () => {
			cancelled = true
		}
	}, [shellStartedTick])
	// D8 / spec: import the plaintext copies into the encrypted library, then purge them after read-back.
	useEffect(() => {
		if (!gossip || !historyEoa) return
		const run = () => {
			// The wallet layer derives the subkeys and hands them to the worker; the migration needs them.
			void unlockChatLocalWallet(resolveSigningPrivateKeyArmor(profiles?.[0]), historyEoa)
				.then((unlocked) => (unlocked ? runChatLocalMigration() : 'locked'))
				.then(
					(outcome) => console.info('[chatLocal] migration', outcome),
					() => console.warn('[chatLocal] migration failed'),
				)
		}
		run()
		// The worker client may be created after this effect (gossip flag first); run again once it is ready.
		window.addEventListener('beamio:chat-worker-ready', run)
		return () => window.removeEventListener('beamio:chat-worker-ready', run)
	}, [gossip, historyEoa])

	const autoReplayMessage = async (text: string, chatData: chatData) => {
		const profile = profiles?.[0]
		if (!profile?.chats) return

		const now = Date.now()
		const nextMessages = makeMessage(chatData.messages || [], text, now, "me", "sent")
		// the recipient key is resolved first. A missing or invalid key is stored on the reply itself (failed, with the fixed code), not dropped.
		const recipient = allNodes?.length ? await resolveRecipientForSend(chatData, lookupRecipientRecord) : null
		const failedCode = recipient && !recipient.ok ? recipient.code : null
		const storedMessages = failedCode
			? nextMessages.map((m, i) => (i === nextMessages.length - 1 ? { ...m, status: 'failed' as const, sendError: failedCode } : m))
			: nextMessages

		// 更新该会话的 messages，并写回 profile.chats
		const chats = [...profile.chats]
		const idx = chats.findIndex((c) => c.address.toLowerCase() === chatData.address.toLowerCase())
		if (idx < 0) return
		chats[idx] = { ...chatData, messages: storedMessages }
		profile.chats = chats

		const temp = CoNET_Data
		if (temp?.profiles?.length) temp.profiles[0].chats = chats
		setCoNET_Data(temp)
		setProfiles([...profiles])
		await storeSystemData()

		// 送出 message 到对方（sendMessage 内部挑选健康 entry 并重试）
		if (recipient?.ok) {
			// a relay that does not accept the reply is shown on the reply (failed, with a code), not dropped.
			const sent = await sendMessage(recipient.publicArmored, text, profile.privateKeyArmor, allNodes)
			if (!sent) {
				const latest = [...(profile.chats || [])]
				const at = latest.findIndex((c) => c.address.toLowerCase() === chatData.address.toLowerCase())
				const msgs: ChatMessage[] = at >= 0 ? latest[at].messages || [] : []
				if (at >= 0 && msgs.length) {
					const last = msgs.length - 1
					latest[at] = { ...latest[at], messages: msgs.map((mm, i) => (i === last ? { ...mm, status: 'failed' as const, sendError: 'send_failed' } : mm)) }
					profile.chats = latest
					const temp2 = CoNET_Data
					if (temp2?.profiles?.length) temp2.profiles[0].chats = latest
					setCoNET_Data(temp2)
					setProfiles([...profiles])
					await storeSystemData()
				}
				publishNativePwaLog('warn', '[AppShell] auto reply not delivered: send_failed')
			}
		} else if (recipient) {
			// the failure is on the stored reply (failed, with the code), and in the shell log.
			publishNativePwaLog('warn', `[AppShell] auto reply not sent: ${recipient.code}`)
		}
	}



	const AUTO_REPLY_TEXT = "这是自动回复测试"
	const AUTO_REPLY_TEXT_WITH_HASH = "这是自动回复测试，已确认 on-chain"
	const AUTO_REPLY_TEXT_WITHOUT_HASH = "这是自动回复测试，未确认 on-chain"

	/** 在 Base 链上根据 tx hash 查该笔记录：只要存在 USDC 转账且金额 > 0 即承认该记录（contractCallSuccess）；或返回 USDC 转账的受益人 */
	const getUsdcTransferRecipientOnBase = async (
		txHash: string
	): Promise<{
		isUsdcTransfer: boolean
		recipient: string | null
		/** 该 tx 中存在 USDC 转账且金额 > 0 时为 true，承认这条记录 */
		contractCallSuccess?: boolean
	}> => {
		const logPrefix = "[getUsdcTransferRecipientOnBase]"
		try {
			console.log(logPrefix, "start", { txHash })

			const receipt = await baseEndpoint.getTransactionReceipt(txHash)
			console.log(logPrefix, "fetched receipt", {
				hasReceipt: !!receipt,
				receiptStatus: receipt?.status,
				logsLength: receipt?.logs?.length,
			})

			if (!receipt?.logs?.length) {
				console.log(logPrefix, "result: no logs", { isUsdcTransfer: false, recipient: null })
				return { isUsdcTransfer: false, recipient: null }
			}
			if (receipt.status !== 1) {
				console.log(logPrefix, "result: tx failed", { receiptStatus: receipt.status })
				return { isUsdcTransfer: false, recipient: null }
			}

			const usdcAddr = USDCContract_BASE.toLowerCase()
			const transferTopic = ethers.id("Transfer(address,address,uint256)")
			const transferIface = new ethers.Interface([
				"event Transfer(address indexed from, address indexed to, uint256 value)",
			])
			for (const log of receipt.logs) {
				if (log.address.toLowerCase() !== usdcAddr || log.topics[0] !== transferTopic)
					continue
				const parsed = transferIface.parseLog({ topics: log.topics, data: log.data })
				if (parsed?.name === "Transfer") {
					const value = BigInt(parsed.args[2])
					const recipient = parsed.args[1] as string
					console.log(logPrefix, "USDC Transfer found", {
						value: value.toString(),
						valueGt0: value > 0n,
						recipient,
					})
					if (value > 0n) {
						console.log(logPrefix, "result: contractCallSuccess=true (USDC > 0)")
						return { isUsdcTransfer: false, recipient: null, contractCallSuccess: true }
					}
					console.log(logPrefix, "result: USDC Transfer (value=0)", { isUsdcTransfer: true, recipient })
					return { isUsdcTransfer: true, recipient }
				}
			}
			console.log(logPrefix, "result: no USDC Transfer in logs", { isUsdcTransfer: false, recipient: null })
			return { isUsdcTransfer: false, recipient: null }
		} catch (err) {
			console.warn(logPrefix, "error", err)
			return { isUsdcTransfer: false, recipient: null }
		}
	}

	/** 进入的 message 是否为附带 Membership Activated 卡片且带 hash 字段（才触发自动回复） */
	const isMembershipActivatedWithHash = (text: string): boolean => {
		try {
			const obj = JSON.parse(text) as { paymentCard?: { cardType?: string; hash?: string } }
			return !!(obj?.paymentCard?.cardType === "membershipActivated" && obj?.paymentCard?.hash)
		} catch {
			return false
		}
	}

	const addNewMessage = async (
		lines: string[],
		profiles: profile[],
		temp: encrypt_keys_object,
		setProfiles: React.Dispatch<React.SetStateAction<profile[]>>,
		onAutoReply?: (chatData: chatData) => Promise<void>
	) => {
		// profile 为空说明 init 还未完成
		if (!profiles?.length || !profiles[0]) return
		// ✅ 去重：double post 时同一消息可能从不同节点到达两次
		const seenRaw = new Set<string>()
		// Lines this batch consumes without storing a bubble: their armor hashes get dedupe markers before the commit.
		// Each line of this batch goes to exactly one list (see InboundLists in inboundRowRecord.ts).
		const inboundLists = newInboundLists()
				const uniqLines: string[] = []
		for (const raw of lines) {
			const key = raw.trim()
			// A repeated copy in this batch has the same armor hash as its first copy, which decides the ACK.
			if (!key || seenRaw.has(key)) continue
			seenRaw.add(key)
			uniqLines.push(raw)
		}

		const profile = profiles[0]
		const chats: chatData[] = Array.isArray(profile.chats) ? [...profile.chats] : []
		const chatsToAutoReply: chatData[] = []
		// Calls whose end is in this same batch (a cold start replays the whole
		// native inbox at once): their offer must not ring the shell again.
		const voiceCallsEndedInBatch = voiceCallHandlesEndedInBatch(uniqLines, recoverChatSigner)
		noteVoiceCallsEnded(voiceCallsEndedInBatch)

		for (const raw of uniqLines) {
			try {
			// The first decision, before any signature check: text that is not JSON is dropped (marker, then ACK);
			// JSON that cannot be a signed chat line is rejected (no marker, no ACK).
			const line = classifyInboundLine(raw)
			if (line.kind === 'unparseable') { recordDroppedLine(inboundLists, raw); continue }
			if (line.kind === 'rejected') {
				recordRejectedLine(inboundLists, raw)
				const rejectedKey = getMsgKey(raw)
				if (rejectedKey) processedIdsRef.current.delete(rejectedKey)
				continue
			}
			const msg = line.message as unknown as message

			// The sender is the wallet recovered from the signature over the
			// content. The envelope's `from` is only a claim: when it differs,
			// keep the message under the signer and flag the false claim so the
			// bubble shows a warning. Legacy clients sign the nested inner.text.
			const claimedFrom = String(msg.from || '').trim().toLowerCase()
			let displayText = msg.text
			let sign = recoverChatSigner(msg.text, msg.signMessage)
			if (sign !== claimedFrom && typeof msg.text === 'string') {
				try {
					const inner = JSON.parse(msg.text) as { text?: string }
					if (typeof inner?.text === 'string') {
						const innerSigner = recoverChatSigner(inner.text, msg.signMessage)
						if (innerSigner && innerSigner === claimedFrom) {
							sign = innerSigner
							displayText = inner.text
						}
					}
				} catch {}
			}
			if (!sign || !ethers.isAddress(sign)) {
				console.warn('[addNewMessage] skip: signature invalid', { claimed: msg.from })
				recordRejectedLine(inboundLists, raw)
				// Not delivered: forget the key so a genuine copy with the same key is processed.
				const rejectedKey = getMsgKey(raw)
				if (rejectedKey) processedIdsRef.current.delete(rejectedKey)
				continue
			}
			const signAddr = sign
			const falseClaim = claimedFrom && claimedFrom !== signAddr ? claimedFrom : ''
			if (falseClaim) {
				console.warn('[addNewMessage] claimed sender differs from the signer', {
					claimed: falseClaim,
					signer: signAddr,
				})
			}
			// Voice signals (offer, ringing, end, reject, timeout, accept) are admitted only inside a verified chat envelope
			// (draft-v55 §62, v54 §61): the outer signer must equal envelope.from and the inner from. A voice text that fails this is
			// dropped here, before any ring, page layer, row or ack, and the stored text is never a voice signal the page did not verify.
			// Detected on the unwrapped content (nested and escaped voice texts too), not by a text pattern.
			const looksLikeVoiceSignal = typeof displayText === 'string' && Boolean(parseVoiceCallSignal(displayText))
			const verifiedVoice = looksLikeVoiceSignal
				? verifiedVoiceSignalFromLine(JSON.stringify({ text: msg.text, signMessage: msg.signMessage, from: msg.from }))
				: null
			if (looksLikeVoiceSignal && !verifiedVoice) {
				console.warn('[addNewMessage] voice signal dropped: no verified chat envelope')
				recordRejectedLine(inboundLists, raw)
				const droppedKey = getMsgKey(raw)
				if (droppedKey) processedIdsRef.current.delete(droppedKey)
				continue
			}
			let voiceControlConsumed = false

			// Voice offers can arrive while the user is on the Chat list (or another
			// page). Report them globally so Android Telecom is not dependent on
			// mounting the conversation page first.
			try {
				const signal = verifiedVoice
				const callerEoa = signal?.type === 'voice_call_offer_v1'
					? recoverVoiceCallOfferSigner(signal)
					: null
				// Both contexts: a ringing offer is admitted once (verification, late window, from, dedup). A refused offer is
				// neither rung nor recorded as missed. The shell's native ring below is reported only after this admission.
				const offerRinging = signal?.type === 'voice_call_offer_v1' && isVoiceCallOfferRinging(signal)
				// The @tag this signed address is known by (local lookup); a declared tag that differs is refused before admission.
				const knownTag = offerRinging && callerEoa ? formatLookedUpBeamioTag(resolvePeerSearchResult(callerEoa)?.username) : ''
				const offerAdmission = offerRinging && signal ? admitIncomingVoiceOffer(signal, Date.now(), knownTag) : null
				const offerRefused = offerRinging && !offerAdmission?.ok
				// Admitted by another path first (the shell's native report, or the App's earlier pass): the ringing row this path
				// would have written is kept, so the call is recorded whichever path admitted it.
				if (offerRinging && signal && offerAdmission && !offerAdmission.ok && offerAdmission.reason === 'duplicate') {
					const callRowsDup = Array.isArray(profile.phoneCalls) ? profile.phoneCalls : []
					if (!findPhoneCallByIds(callRowsDup, { callId: signal.callId, sessionId: signal.sessionId })) {
						profile.phoneCalls = [
							...callRowsDup,
							{
								callId: signal.callId,
								sessionId: signal.sessionId,
								peerAddress: callerEoa || claimedVoiceCallerAddress(signal),
								direction: 'incoming',
								status: 'ringing',
								createdAt: Number(signal.createdAt) || msg.timestamp,
								answeredAt: undefined,
								endedAt: undefined,
							},
						]
					}
				}
				if (
					signal?.type === 'voice_call_offer_v1' &&
					offerAdmission?.ok &&
					typeof signal.callId === 'string' && signal.callId.length > 0 &&
					typeof signal.sessionId === 'string' && signal.sessionId.length > 0 &&
					isVoiceCallOfferRinging(signal)
				) {
					const previousCall = findPhoneCallByIds(profile.phoneCalls, {
						callId: signal.callId,
						sessionId: signal.sessionId,
					})
					// A stored record already answered or ended (cancelled included) means
					// this offer is a replay: no report, no new row.
					const settledBefore = Boolean(previousCall && (
						isPhoneCallTerminalStatus(previousCall.status) || previousCall.status === 'answered'
					))
					const endsInBatch = voiceCallsEndedInBatch.has(signal.callId.trim())
						|| voiceCallsEndedInBatch.has(signal.sessionId.trim())
					// Browser in another call: answer "busy" (the caller hears a busy tone)
					// and record "Missed call · While on another call". No ring, no push.
					const busyHere = !settledBefore && !endsInBatch && !!callerEoa
						&& !isCashTreesNativeWebView() && browserVoiceCallBusyFor(signal)
					if (busyHere) {
						publishNativePwaLog('info', '[voice] offer while in another call; answered busy')
						markVoiceCallTerminal(signal.callId, signal.sessionId)
						const callRows = Array.isArray(profile.phoneCalls) ? profile.phoneCalls : []
						if (!findPhoneCallByIds(callRows, { callId: signal.callId, sessionId: signal.sessionId })) {
							profile.phoneCalls = [
								...callRows,
								{
									callId: signal.callId,
									sessionId: signal.sessionId,
									peerAddress: callerEoa,
									direction: 'incoming',
									status: 'busy',
									createdAt: Number(signal.createdAt) || msg.timestamp,
									answeredAt: undefined,
									endedAt: Date.now(),
								},
							]
						}
						const busyKey = resolveSigningPrivateKeyArmor(profile)
						if (busyKey) {
							// the busy reply goes to the caller's verified key and route only (resolved here, not from the offer).
							void resolvePeerVoiceMaterialAsync(profile.chats, callerEoa, busyKey).then((peer) => declineIncomingVoiceOffer({
								privateKey: busyKey,
								localCallId: new ethers.Wallet(busyKey).address,
								peerEoa: callerEoa,
								peerPgp: peer.peerPgp,
								peerRoute: peer.peerRoute,
								allNodes: allNodesForVoiceDeclineRef.current || [],
							}, signal, 'busy'))
						}
					} else if (!settledBefore && endsInBatch) {
						// Keep the offer's row (its start time and caller) so the end in
						// this batch turns it into "cancelled"; do not ring the shell.
						publishNativePwaLog('info', '[voice] offer ends in the same batch; not reported to the shell')
						if (claimIncomingVoiceCallReport(signal.callId, signal.sessionId)) {
							const callRows = Array.isArray(profile.phoneCalls) ? profile.phoneCalls : []
							if (!findPhoneCallByIds(callRows, { callId: signal.callId, sessionId: signal.sessionId })) {
								profile.phoneCalls = [
									...callRows,
									{
										callId: signal.callId,
										sessionId: signal.sessionId,
										peerAddress: callerEoa || claimedVoiceCallerAddress(signal),
										direction: 'incoming',
										status: 'ringing',
										createdAt: Number(signal.createdAt) || msg.timestamp,
										answeredAt: undefined,
										endedAt: undefined,
									},
								]
							}
						}
					} else if (!settledBefore) {
						rememberIncomingVoiceOffer(signal)
						const provenAddress = callerEoa || ''
						const localTag = provenAddress
							? formatLookedUpBeamioTag(resolvePeerSearchResult(provenAddress)?.username)
							: ''
						const mismatch = voiceCallClaimMismatchesKey(signal, provenAddress || null, localTag)
						const claim = {
							claimedTag: mismatch ? claimedVoiceCallerTag(signal) : '',
							claimedAddress: mismatch ? claimedVoiceCallerAddress(signal) : '',
							identityWarning: mismatch ? VOICE_CALL_IDENTITY_WARNING : '',
						}
						// Admitted above (offerAdmission): the one native report for this offer. The shell's
						// applyNative path is not called here, so the offer is not admitted twice.
						reportNativeIncomingSystemCall(
							nativeIncomingSystemCallPayload({
								callId: signal.callId,
								sessionId: signal.sessionId,
								peerAddress: provenAddress,
								// Never send EOA as CallKit title — dual EOA/@tag collapses bottom chrome.
								displayName: localTag || 'Beamio',
								...claim,
								signal,
							}),
						)
						void (async () => {
							if (!provenAddress) return
							await ensureProfilesForAddresses([provenAddress])
							let username = resolvePeerSearchResult(provenAddress)?.username
							if (!username) {
								const res = await searchRemoteAndIngest(provenAddress)
								const rows = res && typeof res === 'object' && Array.isArray((res as { results?: unknown }).results)
									? (res as { results: { address?: string; username?: string }[] }).results
									: []
								username = rows.find((row) => (row.address || '').toLowerCase() === provenAddress)?.username
							}
							const tag = formatLookedUpBeamioTag(username)
							// Lookup finished after ringing and the looked-up tag differs from the declared one: revoke the ring
							// fail closed). No ring, no answer, no signature; handled as a decline (v45 §50) and cannot ring again.
							const revoked = revokeRingForLateTag(signal, tag, {
								dismissNative: (callId, sessionId) => dismissRevokedIncomingCall(callId, sessionId),
								forget: (callId, sessionId) => forgetIncomingVoiceOffer(callId, sessionId),
								markTerminal: (callId, sessionId) => markVoiceCallTerminal(callId, sessionId),
								clearLayer: (callId, sessionId) => setGlobalIncomingVoiceCall(current =>
									sameCallId(current?.signal?.callId, callId) && sameCallId(current?.signal?.sessionId, sessionId) ? null : current,
								),
								recordDeclined: (callId, sessionId) => window.dispatchEvent(new CustomEvent('beamio-incoming-ring-revoked', {
									detail: { callId, sessionId },
								})),
							})
							if (revoked) {
								publishNativePwaLog('warn', '[voice] looked-up tag differs from the declared tag after ring: ring revoked (declined)')
								return
							}
							const nextMismatch = voiceCallClaimMismatchesKey(signal, provenAddress, tag, true)
							const nextClaim = {
								claimedTag: nextMismatch ? claimedVoiceCallerTag(signal) : '',
								claimedAddress: nextMismatch ? claimedVoiceCallerAddress(signal) : '',
								identityWarning: nextMismatch ? VOICE_CALL_IDENTITY_WARNING : '',
							}
							setGlobalIncomingVoiceCall((current) =>
								current !== null && sameCallId(current.signal?.callId, signal.callId)
									? { ...current, from: provenAddress, displayTag: tag, ...nextClaim }
									: current,
							)
							reportNativeIncomingSystemCall(
							nativeIncomingSystemCallPayload({
									callId: signal.callId,
									sessionId: signal.sessionId,
									peerAddress: provenAddress,
									displayName: tag || 'Beamio',
									...nextClaim,
									signal,
								}),
							)
						})()
						if (claimIncomingVoiceCallReport(signal.callId, signal.sessionId)) {
							if (!isCashTreesNativeWebView()) {
								setGlobalIncomingVoiceCall({
									signal,
									from: provenAddress,
									displayTag: localTag,
									...claim,
								})
								setGlobalIncomingVoiceMuted(false)
								// Wake receipt: this browser is ringing (the shells send their own).
								const ringKey = resolveSigningPrivateKeyArmor(profile)
								if (ringKey && provenAddress) {
									// the ringing receipt goes to the caller's verified key and route only.
									void resolvePeerVoiceMaterialAsync(profile.chats, provenAddress, ringKey).then((peer) => notifyIncomingVoiceRinging({
										privateKey: ringKey,
										localCallId: new ethers.Wallet(ringKey).address,
										peerEoa: provenAddress,
										peerPgp: peer.peerPgp,
										peerRoute: peer.peerRoute,
										allNodes: allNodesForVoiceDeclineRef.current || [],
									}, signal))
								}
							}
							const callRows = Array.isArray(profile.phoneCalls) ? profile.phoneCalls : []
							if (!callRows.some((item: PhoneCallRecord) => sameCallId(item.sessionId, signal.sessionId))) {
								profile.phoneCalls = [
									...callRows,
									{
										callId: signal.callId,
										sessionId: signal.sessionId,
										peerAddress: provenAddress || claimedVoiceCallerAddress(signal),
										direction: 'incoming',
										status: 'ringing',
										createdAt: Number(signal.createdAt) || msg.timestamp,
										answeredAt: undefined,
										endedAt: undefined,
									},
								]
							}
						}
					}
				} else if (signal?.type === 'voice_call_offer_v1' && !offerRefused && (callerEoa || claimedVoiceCallerAddress(signal))) {
					// Past its ring window (the call push came too late or never; the
					// shell did not ring it): record a missed call, never a ring.
					const callRows = Array.isArray(profile.phoneCalls) ? profile.phoneCalls : []
					const missed = missedIncomingCallRow(callRows, signal, callerEoa || claimedVoiceCallerAddress(signal), msg.timestamp)
					if (missed) {
						publishNativePwaLog('info', '[voice] offer past its ring window; recorded as missed')
						profile.phoneCalls = [...callRows, missed]
					}
				} else if (signal?.type === 'voice_call_ringing_v1' && (signal.callId || signal.sessionId)) {
					// Wake receipt from the callee's device: the dialer shows "Ringing".
					// Never a chat bubble. The secret callId ties it to our dial.
					// Remembered too: the dial screen may subscribe after it arrives.
					noteVoicePeerRinging(signal.callId, signal.sessionId)
					window.dispatchEvent(new CustomEvent('beamio-voice-peer-ringing', {
						detail: { callId: signal.callId, sessionId: signal.sessionId },
					}))
					voiceControlConsumed = true
				} else if (
					(signal?.type === 'voice_call_reject_v1' || signal?.type === 'voice_call_timeout_v1') &&
					signal.callId &&
					signal.sessionId
				) {
					markVoiceCallTerminal(signal.callId, signal.sessionId)
					forgetIncomingVoiceOffer(signal.callId, signal.sessionId)
					setGlobalIncomingVoiceCall(current =>
						sameCallId(current?.signal?.sessionId, signal.sessionId) || sameCallId(current?.signal?.callId, signal.callId)
							? null
							: current,
					)
					// reason "busy": the callee was in another call (the caller hears a busy tone).
					const peerBusy = signal.type === 'voice_call_reject_v1' && (signal as { reason?: unknown }).reason === 'busy'
					const terminalStatus = signal.type === 'voice_call_timeout_v1' ? 'timed_out' : peerBusy ? 'busy' : 'declined'
					const callRows = Array.isArray(profile.phoneCalls) ? profile.phoneCalls : []
					const existing = findPhoneCallByIds(callRows, {
						callId: signal.callId,
						sessionId: signal.sessionId,
					})
					const merged = mergePhoneCallRecord(existing, {
						callId: signal.callId,
						sessionId: signal.sessionId,
						peerAddress: existing?.peerAddress || signAddr,
						// Peer reject of our outbound ring is outgoing for us.
						direction: existing?.direction || 'outgoing',
						status: terminalStatus,
						createdAt: existing?.createdAt ?? msg.timestamp,
						endedAt: Number(signal.timestamp) || msg.timestamp,
					})
					if (merged) {
						profile.phoneCalls = replacePhoneCallInRows(callRows, merged)
					}
					window.dispatchEvent(new CustomEvent(
						signal.type === 'voice_call_timeout_v1' ? 'beamio-voice-peer-timed-out' : 'beamio-voice-peer-declined',
						{ detail: { callId: signal.callId, sessionId: signal.sessionId, ...(peerBusy ? { reason: 'busy' } : {}) } },
					))
					voiceControlConsumed = true
				} else if (
					signal?.type === 'voice_end_v1' &&
					signal.sessionId
				) {
					// The peer ended the call: a later native hang-up for these handles is a no-op (v66 §73).
					clearConnectedCallIfMatches(signal.callId, signal.sessionId)
					markVoiceCallTerminal(signal.callId, signal.sessionId)
					// Inbound end. An unanswered ring is dismissed locally (dismissIncomingSystemCall, no uplink). A connected call keeps its
					// existing hang-up path (2026-11-20: unchanged), so only the unanswered branch below changes.
					const endedRow = findPhoneCallByIds(Array.isArray(profile.phoneCalls) ? profile.phoneCalls : [], {
						callId: signal.callId,
						sessionId: signal.sessionId,
					})
					const connectedCall = endedRow?.status === 'answered' || Boolean(endedRow?.answeredAt)
					if (connectedCall) dismissNativeIncomingVoiceCall(String(signal.callId || ''), signal.sessionId)
					else dismissRevokedIncomingCall(String(signal.callId || ''), signal.sessionId)
					setGlobalIncomingVoiceCall((current) =>
						sameCallId(current?.signal?.sessionId, signal.sessionId) ? null : current,
					)
					const callRows = Array.isArray(profile.phoneCalls) ? profile.phoneCalls : []
					// Match by callId too: the peer's hangup can carry its own session id.
					const existing = findPhoneCallByIds(callRows, {
						callId: signal.callId,
						sessionId: signal.sessionId,
					})
					const merged = mergePhoneCallRecord(existing, {
						callId: signal.callId || existing?.callId || '',
						sessionId: existing?.sessionId || signal.sessionId,
						peerAddress: existing?.peerAddress || signAddr,
						direction: existing?.direction ?? 'incoming',
						// Hangup of a connected call is "ended"; only an unanswered ring is "cancelled".
						status: phoneCallStatusForPeerHangup(existing),
						createdAt: existing?.createdAt ?? msg.timestamp,
						endedAt: Number(signal.timestamp) || msg.timestamp,
					})
					if (merged) {
						profile.phoneCalls = replacePhoneCallInRows(callRows, merged)
					}
				}
			} catch {
				/* Ordinary chat text is not a voice offer. */
			}
			if (voiceControlConsumed) { recordDroppedLine(inboundLists, raw); continue }

			// Delivery receipt → mark sender bubble Delivered; never a chat bubble / unread.
			// Still mailbox-ACK this armor (cancels offline APNs); do NOT emit another sender receipt.
			const deliveryReceipt = parseChatDeliveryReceiptV1(displayText)
			if (deliveryReceipt) {
				recordDroppedLine(inboundLists, raw)
				const applied = markMessageDeliveredBySendId(chats, deliveryReceipt.sendId)
				if (applied.updated) {
					for (let i = 0; i < chats.length; i++) chats[i] = applied.chats[i]
				}
				const armorHashRaw =
					typeof (msg as { _beamioPgpArmorHash?: string })._beamioPgpArmorHash === 'string'
						? String((msg as { _beamioPgpArmorHash?: string })._beamioPgpArmorHash)
						: ''
				const ackCtx = getGossipDeliveryAckContext()
				const pk = profile.privateKeyArmor
				// Native: the mailbox ACK is sent here. Browser: the batch ACK follows the store commit.
				// A shell: the native module sends the mailbox ACK and the delivered receipt itself (setRoutes + ackInbound), so this page code does not run there.
				if (!nativeReceiptPath() && !inboundAckIsBrowser() && armorHashRaw && ackCtx?.routerArmoredPublicKey && pk) {
					void postMailboxDeliveryAck({
						armorHash: armorHashRaw,
						sendId: deliveryReceipt.sendId,
						routerArmoredPublicKey: ackCtx.routerArmoredPublicKey,
						privateKeyArmor: pk,
						entryNodes: ackCtx.entryNodes.length
							? ackCtx.entryNodes
							: allNodes?.length
								? allNodes
								: [],
						mailboxDomains: ackCtx.mailboxDomains,
					})
				}
				continue
			}

			const walletEoa = profile.keyID?.trim() ?? ''
			if (walletEoa) {
				try {
					ingestAaMultisigFromChat({ displayText, fromEoa: signAddr, walletEoa })
				} catch {
					/* multisig ingest must not break chat */
				}
			}

			let idx = chats.findIndex(n => n?.address?.toLowerCase() === signAddr.toLowerCase())
			let chat = idx >= 0 ? { ...chats[idx] } : null

			// ✅ 不存在：创建新 chat（无 profile / 无发件人 PGP 也保留会话，禁止静默丢弃）
			if (!chat) {
				let acc: searchResult | null = resolvePeerSearchResult(signAddr)
				if (!acc) {
					const res = await searchRemoteAndIngest(signAddr)
					let rows: searchResult[] = []
					if (res && typeof res === 'object' && Array.isArray((res as { results?: unknown }).results)) {
						rows = (res as { results: searchResult[] }).results
					}
					acc =
						rows.find((r) => (r?.address ?? '').toLowerCase() === signAddr.toLowerCase()) ??
						rows[0] ??
						null
				}

				chat = await createInboundChatSession(signAddr, profile.privateKeyArmor, acc)
				chats.unshift(chat)
				idx = 0
				console.log('[addNewMessage] verified inbound new session', {
					from: signAddr,
					hasProfile: !!acc?.username,
					hasPgp: !!chat.chatData?.publicArmored,
					textPreview: String(displayText).slice(0, 80),
				})
				Toast.show({
					content: acc?.username
						? `New message from @${acc.username}`
						: `New message from ${signAddr.slice(0, 6)}…${signAddr.slice(-4)}`,
					position: 'top',
				})
			}

			// ✅ 合并消息（去重 + 排序）；displayText 已归一化（嵌套格式时用 inner.text）
			const nextMessages = makeMessage(
				chat.messages || [],
				displayText,
				msg.timestamp,
				"them",
				"sent",
				{
					...(falseClaim ? { claimedFrom: falseClaim } : {}),
					// The voice gate passed for this text: the stored row may drive call state (voiceVerified marker, no key).
					voiceVerified: Boolean(verifiedVoice),
				},
			)

			// ✅ 未读 +1（仅当消息确实是新增的才加）
			
			
			const wasLen = (chat.messages || []).length
				const nowLen = nextMessages.length

				const lastReadTs = Number(chat.lastReadTs || 0)
				const isNew = nowLen > wasLen

				// ✅ 只有“对方发来的 & timestamp 比 lastReadTs 新” 才算未读
				const shouldIncUnread = isNew && msg.timestamp > lastReadTs

				const unreadNext = shouldIncUnread
				? (Number(chat.unreadCount || 0) + 1)
				: Number(chat.unreadCount || 0)

			const nextChat: chatData = {
				...chat,
				messages: nextMessages,
				unreadCount: unreadNext
			}

			if (isNew && isMembershipActivatedWithHash(displayText)) chatsToAutoReply.push(nextChat)

			// The line is recorded only after its row write has succeeded: a throw in the mirror or the write leaves it unrecorded.
			recordInboundLine(inboundLists, raw, isNew, {
				// Mirror the newly-ingested inbound message into encrypted history (fresh-device recovery).
				mirror: isNew
					? () => {
						const inboundSendIdForMirror = extractInboundSendId(displayText)
						const addedInbound =
							nextMessages.find(m =>
								inboundSendIdForMirror
									? m.sendId === inboundSendIdForMirror
									: String(m.createdAt) === String(msg.timestamp),
							) || null
						mirrorChatMessageToHistory(nextChat.address, addedInbound || undefined, 'in')
					}
					: undefined,
				// ✅ 放回 chats（不可变）
				write: () => {
					if (idx === 0 && chats[0].address.toLowerCase() === nextChat.address.toLowerCase()) {
						chats[0] = nextChat
					} else {
						const realIdx = chats.findIndex(n => n.address.toLowerCase() === nextChat.address.toLowerCase())
						if (realIdx >= 0) chats[realIdx] = nextChat
						else chats.unshift(nextChat)
					}
				},
			})
			const rowKey = getMsgKey(raw)
			if (rowKey) {
				storedRowKeysRef.current.add(rowKey)
				if (storedRowKeysRef.current.size > 5000) {
					const oldest = storedRowKeysRef.current.values().next().value
					if (oldest) storedRowKeysRef.current.delete(oldest)
				}
			}

			// After successful ingest: **must** dual-ack mailbox + sender (cancels SI 2-heartbeat APNs).
			if (isNew) {
				const armorHashRaw =
					typeof (msg as { _beamioPgpArmorHash?: string })._beamioPgpArmorHash === 'string'
						? String((msg as { _beamioPgpArmorHash?: string })._beamioPgpArmorHash)
						: ''
				const armorHash = armorHashRaw || undefined
				const inboundSendId = extractInboundSendId(displayText)
				const ackCtx = getGossipDeliveryAckContext()
				const pk = profile.privateKeyArmor
				// A shell: the native module sends the delivered receipt (it is given the sender's route by setRoutes); never from this page code, whatever key the profile holds.
				if (nativeReceiptPath() && isNew) {
					const sender = String(nextChat.address || '').toLowerCase()
					if (sender) void offerContactRoute(sender)
				}
				if (pk && !nativeReceiptPath()) {
					void (async () => {
						let senderPgp = nextChat.chatData?.publicArmored || ''
						let senderMailboxRoute = nextChat.chatData?.routersArmoreds || ''
						if (!senderPgp.trim() || !senderMailboxRoute.trim()) {
							try {
								const keys = await getKeysFromCoNETPGPSC(signAddr)
								senderPgp = senderPgp || keys?.publicArmored || ''
								senderMailboxRoute = senderMailboxRoute || keys?.routersArmoreds || ''
								if ((senderPgp || senderMailboxRoute) && nextChat.chatData) {
									const updatedChatData = {
										...nextChat.chatData,
										publicArmored: senderPgp || nextChat.chatData.publicArmored,
										routersArmoreds: senderMailboxRoute || nextChat.chatData.routersArmoreds,
									}
									// in a shell the peer PGP armor is not kept in the page copy (the read strips it).
									nextChat.chatData = isShellContext() ? withoutPeerPublicArmor(updatedChatData) : updatedChatData
									const realIdx = chats.findIndex(
										n => n.address.toLowerCase() === nextChat.address.toLowerCase(),
									)
									if (realIdx >= 0) chats[realIdx] = nextChat
								}
							} catch {
								/* sender receipt may skip if no PGP */
							}
						}
						// the sender receipt is encrypted to the sender's key, so it goes only to the sender's verified key and route. A held key is not sent to.
						const receiptSender = await resolveRecipientForSend({ address: nextChat.address, chatData: nextChat.chatData }, lookupRecipientRecord)
						if (!receiptSender.ok) publishNativePwaLog('info', `[AppShell] sender receipt not sent (${receiptSender.code})`)
						await emitDualChatDeliveryReceipts({
							// Browser: the mailbox ACK follows the store commit (batch ACK); the sender receipt is still sent here.
							skipMailboxAck: inboundAckIsBrowser(),
							armorHash,
							sendId: inboundSendId,
							privateKeyArmor: pk,
							entryNodes: allNodes?.length ? allNodes : ackCtx?.entryNodes || [],
							mailboxAck: ackCtx
								? {
										routerArmoredPublicKey: ackCtx.routerArmoredPublicKey,
										entryNodes: ackCtx.entryNodes,
										mailboxDomains: ackCtx.mailboxDomains,
									}
								: null,
							senderPublicArmored: receiptSender.ok ? receiptSender.publicArmored : null,
							senderMailboxRoutePublicKey: receiptSender.ok ? receiptSender.routersArmoreds : null,
							sendMessage,
						})
					})()
				}
			}
			} catch (ex) {
			// 建议至少打印一次，方便你排查脏数据
				console.log("addNewMessage line failed; not stored, not ACKed", ex)
				// The line has no row and must not be treated as handled: forget its key so the mailbox redelivery is processed again.
				const failedKey = getMsgKey(raw)
				if (failedKey) processedIdsRef.current.delete(failedKey)
			}
		}

		profile.chats = chats
		// A replayed offer above may have added a ringing row for a call the shell
		// already ended (its outcome can arrive while this batch is still running).
		const settledCallRows = closeSettledIncomingCalls(profile.phoneCalls)
		if (settledCallRows) profile.phoneCalls = settledCallRows

		// ✅ 关键：setProfiles 必须不可变更新（复制 profile + 复制 profiles 数组）
		setProfiles([...profiles])
		temp.profiles = profiles
		setCoNET_Data(temp)
		// storeSystemData() only schedules the write (200 ms debounce, and a frozen background WebView runs it even later).
		// The ACK waits for that commit: a failed commit sends no ACK and keeps the lines pending. Native: `ackInbound`only for lines
		// with a row in the store, sent on the next frame after the commit. A crash before that keeps the armor in the
		// native inbox, which replays it. An early return above leaves the lines unconfirmed too.
		// Store step: the ACK target is captured now; native ackInbound is sent only for rows, and only after the commit.
		const ackTarget = captureInboundAckTarget()
		void settleInboundBatch(settleInputOf(inboundLists), {
			target: {
				...ackTarget,
				// Next frame after the commit (display is approximated).
				ackDisplayed: (hashes) => requestAnimationFrame(() => ackTarget.ackDisplayed(hashes)),
			},
			hashesOf: inboundArmorHashesOf,
			markHashes: recordInboundDedupeMarkers,
			unmarkHashes: forgetInboundDedupeMarkers,
			commit: storeSystemDataAndWait,
			release: releaseInboundLines,
		})
		// Calls the caller ended in this batch: did they ring here? (missed vs cancelled)
		askShellWhichIncomingCallsRang(profile.phoneCalls)

		// ✅ 聆听进入的新 message 后自动回复
		if (onAutoReply && chatsToAutoReply.length > 0) {
			for (const chat of chatsToAutoReply) {
				try {
					await onAutoReply(chat)
				} catch (e) {
					console.warn("autoReplayMessage error", e)
				}
			}
		}
	}

	// ① 先统计（不要清 charts）— 排除 delivery receipt（不进 native icon badge）
	useEffect(() => {
		if (!Array.isArray(charts) || charts.length === 0) return

		let delta = 0
		const seen = seenMsgRef.current

		for (const raw of charts) {
			const key = getMsgKey(raw)
			if (!key) continue
			if (seen.has(key)) continue
			// Protocol delivery receipt must not bump Footer / native icon badge.
			try {
				const obj = typeof raw === 'string' ? JSON.parse(raw) : raw
				const text = obj?.text
				if (text != null && parseChatDeliveryReceiptV1(text)) {
					seen.add(key)
					continue
				}
			} catch {
				/* count as normal if unwrap fails */
			}
			seen.add(key)
			delta += 1
		}

		if (delta > 0) setMessageCount(prev => prev + delta)
	}, [charts, setMessageCount, seenMsgRef])

  /**
   * 检查字符串是否是 signOfflineTransferERC3009 产生的 JSON 结构
   * ERC3009 签名数据应包含：fromEOA, id, maxAmount, validAfter, validBefore, nonce, signature, digest
   */
  const isERC3009SignatureData = (str: string): boolean => {
    try {
      const parsed = JSON.parse(str)
      // 检查是否包含 ERC3009 签名数据的所有必需字段
	  
      return (
        typeof parsed === 'object' &&
        parsed !== null &&
        typeof parsed.fromEOA === 'string' &&
        typeof parsed.id === 'string' &&
        typeof parsed.maxAmount === 'string' &&
        typeof parsed.validAfter === 'string' &&
        typeof parsed.validBefore === 'string' &&
        typeof parsed.nonce === 'string' &&
        typeof parsed.signature === 'string' &&
        typeof parsed.digest === 'string'
      )
    } catch {
      return false
    }
  }

  /** BeamioUserCard redeem URL：beamiocard + redeemcode */
  const isRedeemUrl = (raw: string): boolean => isRedeemDeepLink(raw)

  const parseRedeemUrl = (raw: string): { cardAddress?: string; redeemCode: string } | null =>
    parseRedeemClaimFromParams(collectDeepLinkSearchParams(raw))

  /** 商家发行的 bill paymentUrl：Amount=、currency=、acceptTokens= 为必选项，缺一视为非法 bill 不处理；路径为 /Vouchers 或域名含 beamio */
  const isPaymentUrl = (raw: string): boolean => {
    try {
      if (!raw || typeof raw !== 'string') return false
      const u = raw.startsWith('http') ? new URL(raw) : new URL(raw, 'http://beamio.ca')
      const amount = u.searchParams.get('Amount') ?? u.searchParams.get('amount')
      const currency = u.searchParams.get('currency') ?? u.searchParams.get('Currency') ?? ''
      const acceptTokens = u.searchParams.get('acceptTokens') ?? u.searchParams.get('accepttokens') ?? ''
      if (!amount || Number(amount) <= 0) return false
      if (!currency || !acceptTokens) return false
      if (u.pathname === '/Vouchers' || isBeamioWebHostname(u.hostname)) return true
      return /\/Vouchers/i.test(u.pathname)
    } catch {
      return false
    }
  }

  const checkUrl = async (url: string) => {
    // 首先检查是否是 ERC3009 签名数据的 JSON 字符串
    if (isERC3009SignatureData(url)) {
		const parsed = JSON.parse(url) as { fromEOA: string, id: string, maxAmount: string, validAfter: string, validBefore: string, nonce: string, signature: string, digest: string }
		console.log("parsed", parsed)
		return
    }

    let searchParams: URLSearchParams
    try {
      searchParams = collectDeepLinkSearchParams(url)
    } catch {
      searchParams = new URLSearchParams(url)
    }

    let code = searchParams.get("code") || ""
    const _secureCode =
      searchParams.get("secureCode") || searchParams.get("securecode") || ""
    const cashcode = searchParams.get("cashcode") || ""
    const _beamio = searchParams.get("beamio") || ""
    const _beamiocard = searchParams.get("beamiocard") || searchParams.get("Beamiocard") || ""
    const _redeemcode = searchParams.get("redeemcode") || searchParams.get("Redeemcode") || ""
    const _couponId = decodeURIComponent((searchParams.get("couponId") || searchParams.get("couponid") || "").trim())
    const _claim = (searchParams.get("claim") || "").trim().toLowerCase()

	setScanData("")

    if (isRemovedNfcLinkUrl(url)) {
      Toast.show({ icon: 'fail', content: tu('nfc_link_removed_message') })
      return
    }

    // BeamioUserCard redeem URL → 打开 Redeem 确认页（与 coupon open-claim 相同流程）
    if (_redeemcode?.trim()) {
      const parsedRedeem = parseRedeemClaimFromParams(searchParams)
      if (!parsedRedeem) {
        Toast.show({ content: tu('redeem_link_is_invalid_or_wallet_is_not_ready'), position: 'top' })
        navigate('/History')
        return
      }
      setRedeemClaimIntent(parsedRedeem)
      setCouponClaimIntent(null)
      setShowFooter(false)
      navigate('/History')
      return
    }

    // Discover merchant URL → /discover detail panel
    const parsedDiscover = parseDiscoverMerchantFromParams(searchParams)
    if (parsedDiscover) {
      stashDiscoverShareReferrer(parsedDiscover.cardAddress, parsedDiscover.referrerEoa)
      setShowFooter(true)
      navigate('/discover', {
        state: {
          openDiscoverMerchantCard: parsedDiscover.cardAddress,
          discoverShareReferrerEoa: parsedDiscover.referrerEoa,
        },
      })
      stripDiscoverMerchantDeepLinkParams()
      return
    }

    // Coupon open-claim URL: beamiocard + couponId + claim=open/1/true
    if (_beamiocard?.trim() && _couponId && (!_claim || _claim === "open" || _claim === "1" || _claim === "true")) {
      const parsedCoupon = parseCouponOpenClaimFromParams(searchParams)
      if (!parsedCoupon) {
        Toast.show({ content: tu('coupon_link_is_invalid_or_wallet_is_not_ready'), position: "top" })
        navigate("/History")
        return
      }
      stashDiscoverShareReferrer(parsedCoupon.cardAddress, parsedCoupon.referrerEoa)
      setCouponClaimIntent(parsedCoupon)
      setRedeemClaimIntent(null)
      setShowFooter(false)
      navigate("/History", {
        state: { discoverShareReferrerEoa: parsedCoupon.referrerEoa },
      })
      return
    }

    if (_beamio) {
		// 扫码自己时：直接进入我的钱包
		if (beamio?.accountName && String(_beamio).trim().toLowerCase() === String(beamio.accountName).toLowerCase()) {
			setScanData("")
			navigate('/myWallet')
			return
		}
		const _wallet = searchParams.get("wallet") ?? searchParams.get(tu('wallet')) ?? ""
		const walletAddr = _wallet.trim() && ethers.isAddress(_wallet.trim()) ? ethers.getAddress(_wallet.trim()) : null
		if (walletAddr) {
			setPreferredPayeeWallet({ beamioAccount: _beamio.trim(), wallet: walletAddr })
		}
		const user = await searchRemoteAndIngest(_beamio)
		const results: searchResult[] = (user as { results?: searchResult[] } | null)?.results ?? []
		if (!results.length) return

		const filtered = results.filter(n => n.username === _beamio)
		if (!filtered.length) return

		setUserPreviewItem(filtered[0])
		setScanData("")
		setShowAlphaHowItWorks("BeamioContactProfilePreview")
		return
    }


    if (_secureCode) {

		setSecureCode (_secureCode)
		setRedeemCode(cashcode)
		navigate('/History')
		return
      
    }

    if (code) {
      if (!code.startsWith("0x")) {
        code = ethers.solidityPackedKeccak256(["string"], [code])
      }
      try {
        const fx = await getDeprecatedBeamioConetLinkMemo(code)
        if (fx.to !== ethers.ZeroAddress) {
          setPaymentLinkCode(code)
          navigate("/browser")
          return
        }
      } catch (ex) {
        console.log("await CoreContract.getLinkMemo(code) Error")
      }
    }
  }

  // scan QR / global search paste：isInitialLoading 时暂缓；loading 结束后须再跑（deps 含 isInitialLoading）
  useEffect(() => {
    if (!scanData || isInitialLoading) return

    const run = async () => {
      const link = normalizeDeepLinkInput(scanData)
      // Coupon / redeem deep links must win over stale voucherPay scanIntent (global search paste after bill scan).
      // Redeem deep links win when both redeemcode and couponId are present (redeem-required coupons).
      if (isRedeemUrl(link)) {
        const parsed = parseRedeemUrl(link)
        setScanData('')
        setScanIntent('')
        if (parsed) {
          setCouponClaimIntent(null)
          setRedeemClaimIntent(parsed)
          setShowFooter(false)
          navigate('/History')
        }
        return
      }
      if (isCouponOpenClaimDeepLink(link)) {
        const parsed = parseCouponOpenClaimFromParams(collectDeepLinkSearchParams(link))
        setScanData('')
        setScanIntent('')
        if (parsed) {
          stashDiscoverShareReferrer(parsed.cardAddress, parsed.referrerEoa)
          setRedeemClaimIntent(null)
          setCouponClaimIntent(parsed)
          setShowFooter(false)
          navigate('/History', {
            state: { discoverShareReferrerEoa: parsed.referrerEoa },
          })
        } else {
          Toast.show({ content: tu('coupon_link_is_invalid_or_wallet_is_not_ready'), position: 'top' })
        }
        return
      }

      // voucherPay / payBill 全流程由 TenKeyInputComponent 内的 Smart Routing Analysis 处理，此处不消费 scanData
      if (scanIntent === 'voucherPay' || scanIntent === 'payBill') return

      // 符合 paymentUrl 的扫码结果：navigate 到 /History，打开 TenKeyInput 向 request 人支付 request 金额
      if (isPaymentUrl(scanData)) {
        setScanIntent('voucherPay')
        setVoucherPayFromScan(true)
        navigate('/History')
        return
      }
      if (isRemovedNfcLinkUrl(scanData)) {
        setScanData('')
        Toast.show({ icon: 'fail', content: tu('nfc_link_removed_message') })
        return
      }
      if (/^0x/i.test(scanData)) {
        const addr = scanData
        setScanData("")
        try {
          let results: searchResult[] = []
          const localPeer = resolvePeerSearchResult(addr)
          if (localPeer) {
            results = [localPeer]
          } else {
            const user = await searchRemoteAndIngest(addr)
            results = ((user as { results?: searchResult[] } | null)?.results || [])
              .filter((item) => item?.address?.toLowerCase() === addr.toLowerCase())
          }
          const searchResultItem: searchResult = results[0] ?? {
            address: addr,
            created_at: 0,
            first_name: '',
            last_name: '',
            follow_count: '',
            follower_count: '',
            username: addr.slice(0, 6) + '…' + addr.slice(-4),
            image: '',
          }
          setUserPreviewItem(searchResultItem)
          setPayFocusAmountOnMount(true)
          setShowAlphaHowItWorks('支付')
          setShowFooter(false)
          navigate("/")
        } catch {
          setUserPreviewItem({
            address: addr,
            created_at: 0,
            first_name: '',
            last_name: '',
            follow_count: '',
            follower_count: '',
            username: addr.slice(0, 6) + '…' + addr.slice(-4),
            image: '',
          })
          setPayFocusAmountOnMount(true)
          setShowAlphaHowItWorks('支付')
          setShowFooter(false)
          navigate("/")
        }
        return
      }
	  navigate('/History')
      try {
        await checkUrl(scanData)
      } finally {
        setScanData("")
      }
    }

    run()
  }, [scanData, scanIntent, isInitialLoading])

  // ② 入站 chat 串行队列处理：避免并行 addNewMessage 导致同一消息被处理两次
	useEffect(() => {
		const temp = CoNET_Data
		if (!Array.isArray(charts) || charts.length === 0) return

		// profile 或 temp 未就绪时，延迟重试（防止 init 未完成时丢消息）
		if (!profiles?.length || !profiles[0] || !temp) {
			const t = setTimeout(() => {
				// 触发重新检查：通过 setCharts 保持引用不变但触发 effect 重跑
				setCharts((prev: string[]) => (prev.length ? [...prev] : prev))
			}, 500)
			return () => clearTimeout(t)
		}

		// 新消息入队
		pendingQueueRef.current.push(...charts)
		// Remove only the lines taken here; one that arrived after this render stays queued.
		const taken = charts
		setCharts((prev: string[]) => dropTakenInboundLines(prev, taken))

		const processQueue = async () => {
			if (runningRef.current) return
			runningRef.current = true
			try {
				const batch = pendingQueueRef.current.splice(0)
				if (batch.length === 0) {
					runningRef.current = false
					return
				}

				// 全局去重：按 sendId 或 from_timestamp 过滤已处理
				const toProcess: string[] = []
				// Already handled on this page (or not a chat line): nothing to store, but the
				// mailbox still holds the copy. Confirm once a write has landed so it is ACKed.
				const replayRows: string[] = []
				const replayDrops: string[] = []
				for (const raw of batch) {
					const key = getMsgKey(raw)
					if (isInboundLineMarked(raw) || !key || processedIdsRef.current.has(key)) {
						// A replay is verified again: a frame that is not an object, has no text or no signature, or fails its signature is
						// never ACKed, whatever its key. Text that is not JSON stays a dropped frame.
						const replayed = classifyInboundLine(raw)
						if (replayed.kind === 'rejected') continue
						if (replayed.kind === 'signed' && !inboundSignatureValid(replayed.message as unknown as message)) continue
						;(key && storedRowKeysRef.current.has(key) ? replayRows : replayDrops).push(raw)
						continue
					}
					processedIdsRef.current.add(key)
					toProcess.push(raw)
				}
				const confirmAlreadyHandled = () => {
					if (!replayRows.length && !replayDrops.length) return
					const ackTarget = captureInboundAckTarget()
					// Replays: a line with a row in this session gets its row ACK after the commit; any other line is dropped (no native ACK).
					void settleInboundBatch({ rowLines: replayRows, dropLines: replayDrops }, {
						target: {
							...ackTarget,
							ackDisplayed: (hashes) => requestAnimationFrame(() => ackTarget.ackDisplayed(hashes)),
						},
						hashesOf: inboundArmorHashesOf,
						markHashes: recordInboundDedupeMarkers,
						unmarkHashes: forgetInboundDedupeMarkers,
						commit: storeSystemDataAndWait,
						release: releaseInboundLines,
					})
				}
				if (toProcess.length === 0) {
					confirmAlreadyHandled()
					runningRef.current = false
					if (pendingQueueRef.current.length > 0) setTimeout(processQueue, 0)
					return
				}

				confirmAlreadyHandled() // handled copies in a mixed batch are ACKed too
				await addNewMessage(toProcess, profiles, temp, setProfiles, async (chatData) => {
					const p0 = profiles?.[0]
					if (!p0?.privateKeyArmor) return
					const lastMsg = chatData.messages[chatData.messages.length - 1]
					const msgText = (lastMsg as { text?: string })?.text
					let hash: string | undefined
					try {
						const obj = JSON.parse(msgText ?? "") as { paymentCard?: { hash?: string } }
						hash = obj?.paymentCard?.hash
					} catch {}
					let text: string
					if (!hash) {
						text = AUTO_REPLY_TEXT_WITHOUT_HASH
					} else {
						const result = await getUsdcTransferRecipientOnBase(hash)
						if (result.contractCallSuccess) {
							text = AUTO_REPLY_TEXT_WITH_HASH
						} else {
							const myAddress = new ethers.Wallet(p0.privateKeyArmor).address
							const isBeneficiaryMe = !!(
								result.isUsdcTransfer &&
								result.recipient &&
								myAddress &&
								result.recipient.toLowerCase() === myAddress.toLowerCase()
							)
							text = isBeneficiaryMe ? AUTO_REPLY_TEXT_WITH_HASH : AUTO_REPLY_TEXT_WITHOUT_HASH
						}
					}
					await autoReplayMessage(text, chatData)
				})
				// After this batch is stored, so a duplicate is never ACKed before its first copy.
				confirmAlreadyHandled()
			} finally {
				runningRef.current = false
				if (pendingQueueRef.current.length > 0) setTimeout(processQueue, 0)
			}
		}
		processQueue()
	}, [charts, profiles])

  return (
		<div
			className="overscroll-none flex min-h-[100dvh] flex-col"
			style={{ backgroundColor: '#000414' }}
		>
			<AccountInfoUnavailableNotice />
			<div ref={bodyRef} className="overscroll-none flex-1 min-h-0 flex flex-col">
				<div className="flex-1 min-h-0 flex flex-col">
				<Routes>
				<Route path="/Onboarding" element={<BeamioInstallOnboarding />} />
				{/* Stripe returns in a fresh tab and must be visible even before wallet boot. */}
				<Route path="/stripe-payment-return" element={<StripePaymentReturnPage />} />
				<Route element={<AppEntryGate />}>
					<Route path="/" element={<Home />} />
					<Route path="/home" element={<Home />} />
					<Route path="/wallet" element={<WalletOverview />} />
					<Route path="/wallet/business-start-ket-redeem" element={<BusinessStartKetRedeemAdminPage />} />
					<Route path="/wallet/aa-multisig" element={<AaMultisigPage />} />
					<Route path="/wallet/conet-nodes" element={<ValidatorNodeProfilePage />} />
					<Route path="/wallet/referral-registry" element={<ReferralRegistryDashboardPage />} />
					<Route path="/History" element={<History />} />
					<Route path="/Pay" element={<Pay />} />
					<Route path="/BountyBoard" element={<BountyBoard />} />
					<Route path="/BountyBoard/conet-mining" element={<CoNetMiningDetailPage />} />
					<Route path="/BountyBoard/genesis-referral" element={<GenesisNodeReferralPage />} />
					<Route path="/BountyBoard/genesis-referral/redeem" element={<GenesisL0RedeemManagePage />} />
					<Route path="/BountyBoard/genesis-referral/l1" element={<GenesisL1EvangelistManagePage />} />
					<Route path="/BountyBoard/across-the-network" element={<AcrossTheNetworkRoute />} />
					<Route path="/qr" element={<QrOperationPage />} />
					<Route path="/Chat" element={<ShellChatGate><Chat /></ShellChatGate>} />
					<Route path="/chat" element={<ShellChatGate><Chat /></ShellChatGate>} />
					<Route path="/chat/:id" element={<ChatAddressDeepLinkRedirect />} />
					<Route path="/phone" element={<PhoneHistoryPage />} />
					<Route path="/settings" element={<MyWallet />} />
					<Route path="/discover" element={<Market />} />
					<Route path="/reward-pt-merchants" element={<Navigate to="/discover" replace state={{ rewardPtUsdcOnly: true }} />} />
					<Route path="/browser" element={<Browser />} />
					<Route path="/myWallet" element={<MyWallet />} />
					<Route path="/myBrands" element={<MyBrandsPage />} />
					<Route path="/HistoryAll" element={<HistoryAll />} />
					<Route path="/vouchers-example" element={<VouchersExample />} />
					<Route path="/example-express" element={<ExampleExpress />} />
					<Route path="/ten-key-input" element={<TenKeyInput />} />
					<Route path="/example-card" element={<EmapmpleCard />} />
					<Route path="/example-new-card" element={<NewCardExample />} />
					<Route path="/transfertion" element={<BeamioTransactions />} />
					<Route path="/native-pos" element={<MobilePOS />} />
					<Route path="/render-action" element={<RenderActionPage />} />
				</Route>
				</Routes>
				</div>
			</div>

			<MinimizedVoiceCallWindow />
			{createPortal(
				<Footer visible={showFooter && !isInitialLoading} />,
				document.body
			)}
			<EoaUsdcStripeReturnHost />

			{globalIncomingVoiceCall && !location.pathname.startsWith('/chat') && !isCashTreesNativeWebView()
				? createPortal(
					(() => {
						const peer = resolvePeerSearchResult(globalIncomingVoiceCall.from)
						const fallback: searchResult = {
							address: globalIncomingVoiceCall.from,
							created_at: 0,
							first_name: '',
							last_name: '',
							username: '',
							follow_count: '',
							follower_count: '',
							image: '',
						}
						const contact = peer || fallback
						const tag = globalIncomingVoiceCall.displayTag || formatLookedUpBeamioTag(contact.username)
						const openChatWithAction = (action: 'accept' | 'reject') => {
							setGlobalIncomingVoiceCall(null)
							setChatHomeItem(contact)
							navigate('/chat', { state: { autoVoiceCallAction: action } })
						}
						// Decline here: record it and send the reject without opening the
						// caller's conversation (same steps as the shells' Decline above).
						const declineHere = async () => {
							const offer = globalIncomingVoiceCall.signal
							const caller = String(offer?.from || globalIncomingVoiceCall.from || '').trim()
							setGlobalIncomingVoiceCall(null)
							if (!offer?.callId || !offer.sessionId) return
							markVoiceCallTerminal(offer.callId, offer.sessionId)
							forgetIncomingVoiceOffer(offer.callId, offer.sessionId)
							const dataProfiles = CoNET_Data?.profiles
							const currentProfiles = Array.isArray(dataProfiles) && dataProfiles.length
								? dataProfiles
								: profilesForVoiceDeclineRef.current
							const p0 = currentProfiles?.[0]
							if (p0) {
								const rows: PhoneCallRecord[] = Array.isArray(p0.phoneCalls) ? p0.phoneCalls : []
								const existing = findPhoneCallByIds(rows, offer)
								const merged = mergePhoneCallRecord(existing, {
									callId: offer.callId,
									sessionId: offer.sessionId,
									peerAddress: existing?.peerAddress || caller,
									direction: 'incoming',
									status: 'declined',
									createdAt: existing?.createdAt || Number(offer.createdAt) || Date.now(),
									endedAt: Date.now(),
								})
								if (merged) {
									const next = currentProfiles.slice()
									next[0] = {
										...p0,
										phoneCalls: replacePhoneCallInRows(rows, merged)
											.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))
											.slice(0, 200),
									}
									profilesForVoiceDeclineRef.current = next
									setProfilesForVoiceRef.current(next)
									if (CoNET_Data) CoNET_Data.profiles = next
									void storeSystemData()
								}
							}
							const privateKey = resolveSigningPrivateKeyArmor(p0)
							if (!privateKey || !ethers.isAddress(caller)) return
							const chats = (p0?.chats || []) as Array<{
								address?: string
								chatData?: { publicArmored?: string; routersArmoreds?: string }
							}>
							const { peerPgp, peerRoute } = await resolvePeerVoiceMaterialAsync(chats, caller, privateKey)
							await declineIncomingVoiceOffer({
								privateKey,
								localCallId: new ethers.Wallet(privateKey).address,
								peerEoa: caller,
								peerPgp,
								peerRoute,
								allNodes: allNodesForVoiceDeclineRef.current || [],
							}, offer)
						}
						return (
							<div className="fixed inset-0 z-[250]">
								<div className="absolute inset-0 bg-[#808080]/50" aria-hidden />
								<div className="pointer-events-none absolute inset-x-4 top-[max(1rem,env(safe-area-inset-top,0px))] mx-auto max-w-lg">
								<div className="pointer-events-auto rounded-3xl border border-[#dce2f7] bg-white/95 p-4 shadow-[0_18px_50px_rgba(15,23,42,0.24)] backdrop-blur-xl">
									<div className="flex items-center gap-3">
										{/* Drawn locally from the verified tag; a call never fetches an avatar. */}
										<img
											src={localCallerAvatarDataUri(tag) || `${process.env.PUBLIC_URL}/beamio-call-mark.png`}
											alt=""
											className="h-12 w-12 shrink-0 rounded-full bg-[#e9edff] object-cover ring-2 ring-white"
										/>
										<div className="min-w-0 flex-1">
											<p className="truncate text-base font-bold text-slate-900">{tag || 'Incoming voice call'}</p>
											{globalIncomingVoiceCall.from ? (
												<div className="mt-1">
													<BeamioAddressCapsule address={globalIncomingVoiceCall.from} />
												</div>
											) : null}
											{globalIncomingVoiceCall.identityWarning ? (
												<div className="mt-2">
													<p className="truncate text-sm font-semibold text-red-600">{globalIncomingVoiceCall.claimedTag || 'Unknown tag'}</p>
													{globalIncomingVoiceCall.claimedAddress ? (
														<div className="mt-1">
															<BeamioAddressCapsule
																address={globalIncomingVoiceCall.claimedAddress}
																className="border-red-200 bg-red-50 text-red-700"
																iconClassName="text-red-400"
															/>
														</div>
													) : null}
													<p className="mt-1 text-xs font-semibold text-red-600">{globalIncomingVoiceCall.identityWarning}</p>
												</div>
											) : null}
										</div>
										<button
											type="button"
											onClick={() => setGlobalIncomingVoiceMuted(value => !value)}
											className="rounded-full bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-600"
											aria-pressed={globalIncomingVoiceMuted}
										>
											{globalIncomingVoiceMuted ? 'Unmute' : 'Mute'}
										</button>
									</div>
									{callCapState === 'old_shell' ? (
										<p className="mt-3 text-sm font-semibold text-amber-700">{tu('call.upgrade.incoming')}</p>
									) : null}
									<div className="mt-3 grid grid-cols-2 gap-2">
										<button
											type="button"
											onClick={() => { void declineHere() }}
											className="rounded-full bg-slate-100 px-4 py-2.5 text-sm font-semibold text-slate-700"
										>
											Decline
										</button>
										{callCapState === 'compatible' || callCapState === 'browser' || callCapState === 'loading' ? (
											<button
												type="button"
												disabled={callCapState === 'loading'}
												onClick={() => openChatWithAction('accept')}
												className="rounded-full bg-[#1562f0] px-4 py-2.5 text-sm font-semibold text-white disabled:cursor-wait disabled:opacity-60"
											>
												{callCapState === 'loading' ? tu('call.checking') : 'Accept'}
											</button>
										) : null}
									</div>
									{browserNotificationPermission !== 'granted' &&
									browserNotificationPermission !== 'unsupported' ? (
										<button
											type="button"
											onClick={() => void enableBrowserCallNotifications()}
											className="mt-2 w-full rounded-full bg-[#e9edff] px-4 py-2 text-xs font-semibold text-[#0051d1]"
										>
											Enable system call notifications
										</button>
									) : null}
								</div>
								</div>
							</div>
						)
					})(),
					document.body,
				)
				: null}

			{/* 全局 Search：任意页面点击 footer 的 search 图标后，直接显示/隐藏（无滑动动画）
				当 search 控件执行关闭（返回按钮/选择结果）后，父容器必须执行 setChatSearchOpen(false) 隐藏 search */}
			{chatSearchOpen && createPortal(
				<div className="fixed inset-0 z-[210]">
					{/* Full-screen dim — search bar sits above; avoids bright strip below the bar */}
					<div
						className="absolute inset-0 bg-black/45 backdrop-blur-[1px]"
						aria-hidden
						onClick={() => {
							setChatSearchOpen(false)
							setShowFooter(true)
						}}
					/>
					<div
						className="absolute inset-x-0 bottom-0 z-10 flex items-center px-4 pb-5"
						style={{ paddingBottom: 'calc(1.25rem + env(safe-area-inset-bottom))' }}
						onClick={(e) => e.stopPropagation()}
					>
						<SearchInputWithDropdown
							showHistory={false}
							showSideSlidePanel={false}
							closeWindow={item => {
								// 必须：search 关闭后父容器执行隐藏
								setChatSearchOpen(false)
								if (item && typeof item !== 'string') {
									setUserPreviewItem(item)
									setShowAlphaHowItWorks('BeamioContactProfilePreview')
									setShowFooter(false)
								} else if (typeof item === 'string' && item === '/discover') {
									setShowFooter(false)
								} else {
									setShowFooter(true)
								}
							}}
							showBackIcon={true}
							select={true}
							focus={true}
						/>
					</div>
				</div>,
				document.body
			)}

			{/**	全画面 	 */}
			{showAlphaHowItWorks === 'BeamioContactProfilePreview' && createPortal(
				<AnimatePresence>
					<motion.div
						key="modal-overlay"
						className="
							fixed inset-0 z-[9999] bg-white dark:bg-slate-900 flex flex-col
						"
						initial={{ x: "100%" }}
						animate={{ x: 0 }}
						exit={{ x: "100%" }}
						transition={{ duration: 0.2, ease: "easeOut" }}
						onTouchMove={(e) => e.stopPropagation()}
					>
					{/* 顶部 Header */}
					{/* <BeamioNavBack
						title=''
						onClose={() => {
							setShowAlphaHowItWorks('')
						}}
					/> */}

						{/* 内容区域 */}
						<div className="flex-1 overflow-y-auto min-h-0 overscroll-contain">
							
							{
								showAlphaHowItWorks === 'BeamioContactProfilePreview' && userPreviewItem &&
								
									
									<BeamioContactProfilePreview
										item={userPreviewItem}
										close={item => {
											if (typeof item === 'string') {
												setShowAlphaHowItWorks('')
												return
											}
											// 与扫码地址 workflow 一致：打开 Pay 底部栏，聚焦金额输入框
											setUserPreviewItem(item)
											setPayFocusAmountOnMount(true)
											setShowAlphaHowItWorks('支付')
											setShowFooter(false)
											navigate('/')
										}}
									/>
										
							}
							
						</div>
					</motion.div>
				</AnimatePresence>
				, document.body
			)}

			{/* 全画面 从底部上来 */}
			<div
				className={[
					"fixed inset-0 z-40",
					showAlphaHowItWorks ? "pointer-events-auto" : "pointer-events-none"
				].join(" ")}
			>
				{/* 灰色遮罩：父页面不可用。Closed children must also be pointer-events-none —
				    default `auto` on descendants re-enables hit-testing under a `none` parent. */}
				<div
					className={[
						"absolute inset-0",
						"bg-black/50 transition-opacity duration-300 ease-out",
						showAlphaHowItWorks ? "opacity-100" : "opacity-0 pointer-events-none"
					].join(" ")}
					onClick={() => {
						setShowFooter(true)
						setShowAlphaHowItWorks('')
					}}
				/>

				{/* Bottom Sheet：全宽，从底部上来 */}
				<div
					className={[
					"absolute inset-x-0 bottom-0",
					"transition-transform duration-300 ease-out",
					showAlphaHowItWorks ? "translate-y-0" : "translate-y-full pointer-events-none"
					].join(" ")}
					onTouchMove={(e) => e.stopPropagation()}
				>
					{/* Sheet 本体：h-auto 自适应内容高度。Closed: pe-none on body too —
					    default auto on descendants would steal taps from Home top capsules (z-30 < z-40). */}
					<div
					className={[
						"w-full",
						"bg-white dark:bg-slate-900",
						"rounded-t-[22px]",

						// ✅ 自适应高度，但最多不超过屏幕（避免顶到状态栏）
						// 你也可以改成 90dvh
						"max-h-[calc(100dvh-env(safe-area-inset-top)-12px)]",
						"h-auto",

						// ✅ 安全区：底部留出 Home indicator
						"pb-[env(safe-area-inset-bottom)]",
						showAlphaHowItWorks ? "" : "pointer-events-none",
					].join(" ")}
					>
						{/* 顶部拖拽条（可选） */}
						<div className="pt-2 pb-1 flex justify-center">
							<div className="h-1 w-10 rounded-full bg-slate-300/70 dark:bg-white/15" />
						</div>


						{/* 内容区：内容少就不滚动；内容多才滚动 */}
						<div className="px-4 pb-4 overflow-y-auto">
							{showAlphaHowItWorks === '支付' && userPreviewItem &&(
								<PayScreen 
									beamioer={userPreviewItem}
									preferredToAddress={
										preferredPayeeWallet &&
										preferredPayeeWallet.beamioAccount === userPreviewItem.username &&
										ethers.isAddress(preferredPayeeWallet.wallet)
											? preferredPayeeWallet.wallet
											: undefined
									}
									focusAmountOnMount={payFocusAmountOnMount}
									close={() => {
										setPreferredPayeeWallet(null)
										setPayFocusAmountOnMount(false)
										setShowAlphaHowItWorks('')
										setShowFooter(true)
								}}/>
							)}
							
							<div
								className="
								h-[24px]
								pb-[env(safe-area-inset-bottom)]
								pointer-events-none
								"
							/>
						</div>
					</div>
				</div>
			</div>

			{/* Merchant gift redeem (beamiocard + redeemcode) — Instant Vault Top-Up sheet */}
			{redeemClaimIntent?.cardAddress ? (
				<MerchantGiftClaimSheet
					cardAddress={redeemClaimIntent.cardAddress}
					redeemCode={redeemClaimIntent.redeemCode}
					giftImageUrl={redeemClaimIntent.giftImageUrl}
					onClose={closeRedeemClaimPanel}
					onSuccess={(tx) => {
						setRedeemResult({ success: true, tx })
						void refreshRecentActivityNoAa()
					}}
				/>
			) : redeemClaimIntent ? (
				<div className="fixed inset-0 z-[10000] flex flex-col bg-white dark:bg-slate-900">
					<div className="flex items-center justify-between border-b border-slate-200 px-5 pb-3 pt-[calc(env(safe-area-inset-top)+14px)] dark:border-slate-800">
						<div>
							<h2 className="text-lg font-bold text-slate-900 dark:text-slate-100">{tu('redeem_code')}</h2>
						</div>
						<button
							type="button"
							onClick={closeRedeemClaimPanel}
							className="text-sm font-medium text-slate-600 dark:text-slate-300"
						>
							Close
						</button>
					</div>
					<div className="flex-1 overflow-y-auto px-5 py-5">
						<div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950/30">
							<p className="text-sm font-semibold text-amber-800 dark:text-amber-200">{tu('missing_card_address')}</p>
							<p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
								{tu('this_redeem_link_must_include_a_valid_program_card_address')}
							</p>
						</div>
					</div>
				</div>
			) : null}

			<AnimatePresence>
				{couponClaimIntent && (
					<motion.div
						key="coupon-claim-overlay"
						className="fixed inset-0 z-[10000] bg-white dark:bg-slate-900 flex flex-col"
						initial={{ x: "100%" }}
						animate={{ x: 0 }}
						exit={{ x: "100%" }}
						transition={{ duration: 0.25, ease: "easeOut" }}
					>
						<div className="flex items-center justify-between px-5 pt-[calc(env(safe-area-inset-top)+14px)] pb-3 border-b border-slate-200 dark:border-slate-800">
							<div>
								<h2 className="text-lg font-bold text-slate-900 dark:text-slate-100">{tu('coupon_claim')}</h2>
								<p className="text-xs text-slate-500 dark:text-slate-400">
									{couponClaimEligibility === 'already_redeemed'
										? 'You already used this coupon.'
										: couponClaimEligibility === 'already_claimed'
											? 'You already claimed this coupon. Show Pay at the merchant POS to redeem.'
											: tu('confirm_before_submitting_on_chain_claim')}
								</p>
							</div>
							<button
								type="button"
								onClick={() => {
									if (couponClaimSubmitting) return
									closeCouponClaimPanel()
								}}
								disabled={couponClaimSubmitting}
								className="text-sm font-medium text-slate-600 dark:text-slate-300 disabled:opacity-50"
							>
								Close
							</button>
						</div>

						<div className="flex-1 overflow-y-auto px-5 py-5">
							<CouponClaimTicketPreview
								cardAddress={couponClaimIntent.cardAddress}
								couponId={couponClaimIntent.couponId}
								submitting={couponClaimSubmitting}
								onResolved={setCouponClaimPreviewRow}
								onEligibilityChange={setCouponClaimEligibility}
								onClaim={() => void handleConfirmCouponClaim()}
								onShowPay={() => setCouponClaimShowPayOpen(true)}
								referrerEoa={couponClaimIntent.referrerEoa ?? null}
								userEoa={profiles?.[0]?.keyID ?? null}
								userAa={profiles?.[0]?.aaAccount ?? null}
								getPrivateKeyArmor={() => resolveSigningPrivateKeyArmor(profiles?.[0]) || undefined}
								onWalletUnlock={() => navigate('/settings')}
							/>
						</div>

						<div className="px-5 pb-[calc(env(safe-area-inset-bottom)+16px)] pt-2 border-t border-slate-200 dark:border-slate-800">
							{(() => {
								const alreadyClaimed = couponClaimEligibility === 'already_claimed'
								const alreadyRedeemed = couponClaimEligibility === 'already_redeemed'
								const claimBlocked =
									alreadyClaimed ||
									alreadyRedeemed ||
									couponClaimEligibility === 'sold_out' ||
									couponClaimEligibility === 'expired' ||
									couponClaimEligibility === 'not_open_claim' ||
									couponClaimEligibility === 'insufficient_social_points'
								if (alreadyClaimed) {
									return (
										<AppButton
											fullWidth
											onClick={() => setCouponClaimShowPayOpen(true)}
											className="rounded-xl"
											aria-label="Show Pay"
										>
											Show Pay
										</AppButton>
									)
								}
								const bottomLabel = alreadyRedeemed
									? tu('redeemed')
									: couponClaimEligibility === 'sold_out'
										? 'Sold out'
										: couponClaimEligibility === 'expired'
											? tu('expired')
											: couponClaimSubmitting
												? tu('claiming')
												: tu('claim')
								return (
									<AppButton
										fullWidth
										onClick={handleConfirmCouponClaim}
										disabled={couponClaimSubmitting || claimBlocked}
										className="rounded-xl"
									>
										{bottomLabel}
									</AppButton>
								)
							})()}
						</div>
						<ShowPayCodeSheet
							isOpen={couponClaimShowPayOpen}
							onClose={() => setCouponClaimShowPayOpen(false)}
							profile={profiles?.[0]}
							setProfiles={setProfiles}
						/>
					</motion.div>
				)}
				{redeemResult && (
					<>
						<motion.div
							className="fixed inset-0 z-[210] bg-black/50"
							initial={{ opacity: 0 }}
							animate={{ opacity: 1 }}
							exit={{ opacity: 0 }}
							transition={{ duration: 0.2 }}
							onClick={() => setRedeemResult(null)}
							aria-hidden
						/>
						<motion.div
							className="fixed inset-x-0 bottom-0 z-[211] bg-white dark:bg-slate-900 rounded-t-[22px] pb-[env(safe-area-inset-bottom)]"
							initial={{ y: "100%" }}
							animate={{ y: 0 }}
							exit={{ y: "100%" }}
							transition={{ type: "tween", duration: 0.3, ease: "easeOut" }}
						>
							<div className="flex justify-center pt-2 pb-1">
								<div className="h-1 w-10 rounded-full bg-slate-300/70 dark:bg-white/15" />
							</div>
							<div className="px-6 pb-6">
								{redeemResult.success ? (
									<>
										<div className="flex items-center gap-3 mb-4">
											<div className="h-12 w-12 rounded-full bg-emerald-100 dark:bg-emerald-900/40 flex items-center justify-center shrink-0">
												<Check className="w-6 h-6 text-emerald-600 dark:text-emerald-400" strokeWidth={3} />
											</div>
											<div>
												<h3 className="text-lg font-bold text-slate-900 dark:text-slate-100">{tu('redeem_successful')}</h3>
												<p className="text-sm text-slate-600 dark:text-slate-400">{tu('your_reward_has_been_added_to_your_account')}</p>
											</div>
										</div>
										{redeemResult.tx && (
											<button
												type="button"
												onClick={() => openExternalUrl(`https://basescan.org/tx/${redeemResult.tx}`)}
												className="block mb-4 text-sm text-[#1652f0] underline"
											>{tu('view_transaction')}</button>
										)}
									</>
								) : (
									<>
										<div className="flex items-center gap-3 mb-4">
											<div className="h-12 w-12 rounded-full bg-rose-100 dark:bg-rose-900/40 flex items-center justify-center shrink-0">
												<span className="text-xl text-rose-600 dark:text-rose-400">!</span>
											</div>
											<div>
												<h3 className="text-lg font-bold text-slate-900 dark:text-slate-100">{tu('redeem_failed_2')}</h3>
												<p className="text-sm text-rose-600 dark:text-rose-400">{redeemResult.error}</p>
											</div>
										</div>
									</>
								)}
								<AppButton fullWidth onClick={() => setRedeemResult(null)} className="rounded-xl">{tu('done')}</AppButton>
							</div>
						</motion.div>
					</>
				)}
			</AnimatePresence>
		</div>
	)
}


const lastMessageTsOf = (chat: { messages?: Array<{ createdAt?: number }> } | undefined): number => {
	const m = chat?.messages
	return Array.isArray(m) && m.length ? Number(m[m.length - 1]?.createdAt ?? 0) || 0 : 0
}

export default function App() {
  return <AppShell />
}
