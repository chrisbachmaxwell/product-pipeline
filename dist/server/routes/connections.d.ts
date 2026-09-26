import { Router } from 'express';
import { sendIncidentEmail } from '../incident-email.js';
import { deleteStoredAnthropicKey, deleteStoredEmailConfig, storeEmailConfigJson, deleteStoredGithubToken, getAnthropicConnectionStatus, getGithubConnectionStatus, storeAnthropicKey, storeGithubToken, validateAnthropicKey, validateGithubToken } from '../connections.js';
export declare function createConnectionsRouter(dependencies?: Readonly<{
    validate?: typeof validateAnthropicKey;
    store?: typeof storeAnthropicKey;
    remove?: typeof deleteStoredAnthropicKey;
    status?: typeof getAnthropicConnectionStatus;
    githubValidate?: typeof validateGithubToken;
    githubStore?: typeof storeGithubToken;
    githubRemove?: typeof deleteStoredGithubToken;
    githubStatus?: typeof getGithubConnectionStatus;
    emailStatus?: () => {
        connected: boolean;
        source: 'env' | 'stored' | null;
        to: string[] | null;
    };
    emailTestSend?: typeof sendIncidentEmail;
    emailStore?: typeof storeEmailConfigJson;
    emailRemove?: typeof deleteStoredEmailConfig;
}>): Router;
declare const _default: Router;
export default _default;
