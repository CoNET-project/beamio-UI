import { useEffect, useState } from 'react'
import { PENDING_SERVER_SYNC_EVENT, pendingServerSyncNoticeVisible } from '@/services/pendingServerSync'

/**
 * The approved notice: shown only while an unsynced profile update is queued. The English interface shows the same
 * Chinese text until the English copy is approved (as the banner does).
 */
export const PENDING_SERVER_SYNC_NOTICE_TEXT = '资料已保存在本机，将在网络恢复后同步到服务器。'

export default function PendingServerSyncNotice() {
	const [visible, setVisible] = useState(() => pendingServerSyncNoticeVisible())
	useEffect(() => {
		const update = () => setVisible(pendingServerSyncNoticeVisible())
		window.addEventListener(PENDING_SERVER_SYNC_EVENT, update)
		return () => window.removeEventListener(PENDING_SERVER_SYNC_EVENT, update)
	}, [])
	if (!visible) return null
	return (
		<div
			role="status"
			className="pointer-events-none fixed bottom-4 left-4 right-4 z-[1000] rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-800 shadow"
		>
			{PENDING_SERVER_SYNC_NOTICE_TEXT}
		</div>
	)
}
