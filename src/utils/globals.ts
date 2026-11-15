//		globals.ts



import { isShellContext } from '../services/shellContext'
import { stripShellSecrets } from '../services/shellProfile'

let CoNET_Data: encrypt_keys_object | null = null;
let processingBlock: boolean = false;
let currentPageInvitees: number = 0;
let globalAllNodes: nodes_info[] = [];

const setCoNET_Data = (data: encrypt_keys_object | null) => {
  // Boundary: in a shell only the PGP private key is removed (the Chat SDK holds it); EOA fields stay with the page.
  CoNET_Data = data && isShellContext() ? stripShellSecrets(data) : data;
};

const setProcessingBlock = (value: boolean) => {
  processingBlock = value;
}

const setCurrentPageInvitees = (value: number) => {
  currentPageInvitees = value;
};

const setGlobalAllNodes = (_nodes: nodes_info[]) => {
  globalAllNodes = _nodes;
};

export {
  CoNET_Data,
  setCoNET_Data,
  processingBlock,
  setProcessingBlock,
  currentPageInvitees,
  setCurrentPageInvitees,
  globalAllNodes,
  setGlobalAllNodes,
};
