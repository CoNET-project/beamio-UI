/**
 * Chat SDK gossip worker entry (wrapper). The SDK worker is loaded after the WebSocket refusal is installed in this
 * worker's global scope (project rule: no WebSocket). The SDK entry keeps its own behaviour.
 */
import '../../utils/webSocketGuard'
import { startChatWorkerEntry } from '@conet.project/chat-sdk/worker'

//an explicit start. The SDK package declares sideEffects:false, so a side-effect import of the worker entry was dropped by tree shaking
// and the worker never attached its message listener (no ready). The call keeps the listener in the worker chunk.
startChatWorkerEntry()
