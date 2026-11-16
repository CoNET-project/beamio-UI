/**
 * Chat SDK gossip worker entry (wrapper). The SDK worker is loaded after the WebSocket refusal is installed in this
 * worker's global scope (project rule: no WebSocket). The SDK entry keeps its own behaviour.
 */
import '../../utils/webSocketGuard'
import '@conet.project/chat-sdk/worker'
