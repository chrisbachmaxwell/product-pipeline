import { Router } from 'express';
import { deleteStoredAnthropicKey, deleteStoredGithubToken, getAnthropicConnectionStatus, getGithubConnectionStatus, storeAnthropicKey, storeGithubToken, validateAnthropicKey, validateGithubToken } from '../connections.js';
export declare function createConnectionsRouter(dependencies?: Readonly<{
    validate?: typeof validateAnthropicKey;
    store?: typeof storeAnthropicKey;
    remove?: typeof deleteStoredAnthropicKey;
    status?: typeof getAnthropicConnectionStatus;
    githubValidate?: typeof validateGithubToken;
    githubStore?: typeof storeGithubToken;
    githubRemove?: typeof deleteStoredGithubToken;
    githubStatus?: typeof getGithubConnectionStatus;
}>): Router;
declare const _default: Router;
export default _default;
