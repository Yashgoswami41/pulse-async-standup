// Keep Slack's exact raw request body intact for signature verification.
export const config = { api: { bodyParser: false } };

export { default } from '../server/index.js';
