import { existsSync, readFileSync } from 'node:fs';
import { atMostOnce, custom, defineConfig, exactlyOnce, finalState } from 'hookstorm-cli';

// Hookstorm doesn't read .env, so load it here: the secret below must be the one the app verifies with.
if (existsSync('.env')) process.loadEnvFile('.env');

// Guide: https://github.com/vyktoremario/hookstorm/blob/main/docs/guide-your-own-receiver.md
//
// 1. npm run dev:hookstorm   (app with test-only routes, receipts → Hookstorm's sink)
// 2. npx hookstorm run

// Use a real recording (hookstorm/events.jsonl + hookstorm/seed.json) if there is one, else the hand-written sample.
const dir = existsSync(new URL('./hookstorm/events.jsonl', import.meta.url)) ? 'hookstorm' : 'hookstorm/sample';

// The orders the events refer to, as they were before any webhook arrived (the app's POST /hookstorm/reset
// recreates the same state from the same file).
const seed: { orders: Array<{ id: string; product_id: string; quantity: number; payment_intent_id: string }> } =
  JSON.parse(readFileSync(new URL(`./${dir}/seed.json`, import.meta.url), 'utf8'));
const products: Array<{ id: string; stock: number }> = JSON.parse(
  readFileSync(new URL('./src/db/products.json', import.meta.url), 'utf8'),
);
const orderByIntent = new Map(seed.orders.map((o) => [o.payment_intent_id, o]));

/** The order an event is about: payment intents carry it in metadata, charges via their payment intent. */
const orderIdOf = (event: { json: any }): string | undefined => {
  const obj = event.json?.data?.object ?? {};
  return obj.metadata?.order_id ?? orderByIntent.get(obj.payment_intent)?.id;
};

export default defineConfig({
  target: `http://127.0.0.1:${process.env.PORT ?? 3000}/webhooks/stripe`, // same PORT as the app (.env)
  provider: 'stripe',
  // The same whsec_ secret the app verifies with (STRIPE_WEBHOOK_SECRET). Test mode only.
  secret: process.env.STRIPE_WEBHOOK_SECRET ?? 'whsec_local_dev',
  events: `./${dir}/events.jsonl`,
  profile: 'realistic',

  // Receipt emails: the app POSTs to $EMAIL_API_URL/receipts → recorded as effect "email.receipts".
  sink: { port: 4400 },
  reset: '/hookstorm/reset',
  probe: '/hookstorm/state',
  eventKey: orderIdOf,

  invariants: [
    atMostOnce('email.receipts', (c) => c.body.orderId, 'each order gets at most one receipt'),

    exactlyOnce('email.receipts', (c) => c.body.orderId, {
      forEachEvent: 'payment_intent.succeeded',
      eventKey: orderIdOf,
      description: 'every paid order gets a receipt',
    }),

    custom('at most one payment ledger entry per order', ({ state }) => {
      const count = new Map<string, number>();
      for (const row of state.ledger) if (row.type === 'payment') count.set(row.order_id, (count.get(row.order_id) ?? 0) + 1);
      return [...count].filter(([, n]) => n > 1).map(([id, n]) => ({ key: id, message: `order ${id} has ${n} payment entries` }));
    }),

    finalState('a refunded order stays refunded', (state, obs) =>
      obs.events
        .filter((e) => e.type === 'charge.refunded' && obs.isAcked(e.id))
        .map((e) => orderIdOf(e)!)
        .filter((id) => state.orders.find((o: any) => o.id === id)?.status !== 'refunded')
        .map((id) => `order ${id} ended as "${state.orders.find((o: any) => o.id === id)?.status}" after its refund was acknowledged`),
    ),

    custom('ticket stock matches paid, unrefunded orders', ({ events, isAcked, state }) => {
      const paid = new Set<string>();
      const refunded = new Set<string>();
      for (const e of events) {
        if (!isAcked(e.id)) continue;
        if (e.type === 'payment_intent.succeeded') paid.add(orderIdOf(e)!);
        if (e.type === 'charge.refunded') refunded.add(orderIdOf(e)!);
      }
      const sold = new Map<string, number>();
      for (const o of seed.orders)
        if (paid.has(o.id) && !refunded.has(o.id)) sold.set(o.product_id, (sold.get(o.product_id) ?? 0) + o.quantity);
      return products
        .map((p) => ({ p, want: p.stock - (sold.get(p.id) ?? 0), got: state.products.find((x: any) => x.id === p.id)?.stock }))
        .filter(({ want, got }) => want !== got)
        .map(({ p, want, got }) => `${p.id}: stock ${got}, expected ${want}`);
    }),
  ],
});
