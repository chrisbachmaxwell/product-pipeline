import { Router } from 'express';
import { type PublishAllDependencies } from '../publish-all.js';
export declare function createListingPublishAllRouter(dependencies?: PublishAllDependencies & {
    armedCheck?: () => boolean;
}): Router;
declare const _default: Router;
export default _default;
