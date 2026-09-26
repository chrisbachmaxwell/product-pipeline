import { Router } from 'express';
import { deleteStoredAnthropicKey, getAnthropicConnectionStatus, storeAnthropicKey, validateAnthropicKey } from '../connections.js';
export declare function createConnectionsRouter(dependencies?: Readonly<{
    validate?: typeof validateAnthropicKey;
    store?: typeof storeAnthropicKey;
    remove?: typeof deleteStoredAnthropicKey;
    status?: typeof getAnthropicConnectionStatus;
}>): Router;
declare const _default: Router;
export default _default;
