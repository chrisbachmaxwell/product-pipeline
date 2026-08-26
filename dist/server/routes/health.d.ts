import { Router } from 'express';
import { type CachedOperationalHealthProjection } from '../operational-monitoring.js';
export declare function createHealthRouter(cachedMonitoringReader?: () => CachedOperationalHealthProjection): Router;
declare const _default: Router;
export default _default;
