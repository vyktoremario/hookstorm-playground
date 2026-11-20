import Stripe from 'stripe';

export const STRIPE = Symbol('STRIPE');

export const stripeProvider = {
  provide: STRIPE,
  // Webhook verification doesn't need the API key, so the app still starts without one (e.g. under Hookstorm).
  useFactory: () => new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_not_configured'),
};
