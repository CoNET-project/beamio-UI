import React, { useSyncExternalStore } from 'react'
import {
	getAccountInfoUnavailable,
	requestAccountInfoRetry,
	subscribeAccountInfoUnavailable,
	type AccountInfoUnavailableReason,
} from '@/services/accountInfoUnavailable'
import { accountUnavailableText } from '@/services/recipientCopy'
import { tu } from '@/locale/beamioLocale'


/** Shown when the App init gave up its capped reads. The button starts the init again; nothing is written here. */
export function AccountInfoUnavailableNotice() {
	const reason = useSyncExternalStore(subscribeAccountInfoUnavailable, getAccountInfoUnavailable, getAccountInfoUnavailable)
	if (!reason) return null
	return (
		<div
			role="alert"
			style={{
				position: 'fixed',
				left: 16,
				right: 16,
				bottom: 16,
				zIndex: 2000,
				padding: '12px 16px',
				borderRadius: 12,
				background: '#1b1f2a',
				color: '#ffffff',
				display: 'flex',
				alignItems: 'center',
				justifyContent: 'space-between',
				gap: 12,
			}}
		>
			<span style={{ fontSize: 14, lineHeight: 1.4 }}>{accountUnavailableText(reason)}</span>
			<button
				type="button"
				onClick={requestAccountInfoRetry}
				style={{ flexShrink: 0, padding: '8px 14px', borderRadius: 8, border: 'none', background: '#2f80ed', color: '#ffffff', fontSize: 14 }}
			>
				{tu('account.unavailable.retry')}
			</button>
		</div>
	)
}
