import { buildNotificationAdminProgram } from './program.js';

await buildNotificationAdminProgram().parseAsync(process.argv);
