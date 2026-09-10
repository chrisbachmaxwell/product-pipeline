import { Router } from 'express';
import { type StepRunner } from '../order-import-trigger.js';
export declare function createListingPublishRouter(dependencies?: Readonly<{
    runStep?: StepRunner;
    preflightArgv?: readonly string[] | null;
    dispatchArgv?: readonly string[] | null;
}>): Router;
declare const _default: Router;
export default _default;
