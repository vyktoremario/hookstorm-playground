// Starts the app the way Hookstorm needs it: test-only routes on, receipt emails to Hookstorm's sink,
// and a local webhook secret unless .env provides the real `stripe listen` one. Usage: npm run dev:hookstorm
process.env.HOOKSTORM = '1';
process.env.EMAIL_API_URL = 'http://127.0.0.1:4400/sink/email';
process.env.DATABASE_URL ??= 'postgres://shop:shop@127.0.0.1:5433/shop';
process.env.STRIPE_WEBHOOK_SECRET ||= 'whsec_local_dev';

// eslint-disable-next-line @typescript-eslint/no-require-imports
require('../main');
