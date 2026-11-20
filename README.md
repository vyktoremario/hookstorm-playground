# hookstorm-playground

A small NestJS + Postgres ticket shop that takes payments with **Stripe (test mode)**, used to try [Hookstorm](https://github.com/vyktoremario/hookstorm) on an app that wasn't built for it.

- `POST /checkout` creates an order and pays it with Stripe's test card.
- `POST /orders/:id/refund` refunds it through Stripe.
- `POST /webhooks/stripe` handles `payment_intent.succeeded` (mark paid, take tickets out of stock, write a ledger entry, email a receipt) and `charge.refunded` (mark refunded, restock, write a refund entry).

The webhook handler is written the way a careful-but-typical first version looks: it checks the order status and uses a transaction. Hookstorm still finds two bugs in it; see [DOGFOOD.md](DOGFOOD.md).

## Run it

Requires Node ≥ 22.12 and Docker.

```bash
npm ci
npm run db:up && npm run db:migrate
```

### Chaos-test the webhook handler (no Stripe account needed)

Uses hand-written, Stripe-shaped sample events in [`hookstorm/sample/`](hookstorm/sample):

```bash
npm run dev:hookstorm      # terminal 1: the app with test-only routes; receipt emails go to Hookstorm's sink
npx hookstorm run          # terminal 2
```

[`hookstorm.config.ts`](hookstorm.config.ts) checks five rules:
- each order gets at most one receipt;
- every paid order gets a receipt;
- at most one payment ledger entry per order;
- a refunded order stays refunded;
- ticket stock matches paid, unrefunded orders.

### Record real Stripe events, then replay them

1. `cp .env.example .env` and set `STRIPE_SECRET_KEY` to your **test** secret key (`sk_test_…`).
2. Terminal 1: forward Stripe's events to Hookstorm's recorder. Copy the `whsec_…` it prints into `.env` as `STRIPE_WEBHOOK_SECRET`.
   ```bash
   stripe listen --forward-to localhost:4500 \
     --events payment_intent.created,payment_intent.succeeded,charge.succeeded,charge.updated,charge.refunded,refund.created
   ```
   Newer Stripe CLI versions require an event list. These are the classic ("snapshot") events this flow produces. The app handles two of them and ignores the rest, as a real endpoint would. `--all-snapshot` also works but records everything on the account. Don't use `--all-thin`: thin events have a different shape that this handler doesn't parse.
3. Terminal 2: record each event, passing it on to the app unchanged:
   ```bash
   npx hookstorm record --provider stripe --port 4500 --forward http://127.0.0.1:3000/webhooks/stripe -o hookstorm/events.jsonl
   ```
4. Terminal 3: start from an empty shop, then run the app. Stop any `npm run dev:hookstorm` first: the app needs port 3000, and that mode doesn't call Stripe.
   ```bash
   npm run db:reset && npm run dev
   ```
5. Make a few purchases and refund one:
   ```bash
   ADA=$(curl -s localhost:3000/checkout -H 'content-type: application/json' -d '{"productId":"gig-afrobeats-night","quantity":2,"email":"ada@example.com"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).id') && echo "Ada's order: $ADA"
   curl -s localhost:3000/checkout -H 'content-type: application/json' -d '{"productId":"gig-jazz-brunch","email":"bola@example.com"}'; echo
   curl -s localhost:3000/checkout -H 'content-type: application/json' -d '{"productId":"gig-afrobeats-night","quantity":4,"email":"chidi@example.com"}'; echo
   curl -s -X POST "localhost:3000/orders/$ADA/refund"; echo
   ```
6. Wait a few seconds for the last events, then stop the recorder (Ctrl+C) and `stripe listen`.
7. Save the orders those events refer to, so every replay starts from the same "before the webhooks" state:
   ```bash
   npm run hookstorm:export-seed
   ```
8. Stop the app, then replay the real events with chaos:
   ```bash
   npm run dev:hookstorm
   npx hookstorm run --runs 20
   ```

Once `hookstorm/events.jsonl` exists, the config and the app's reset route use the recording instead of the samples. Delete it to go back to the samples.

## Test-only routes

`POST /hookstorm/reset` and `GET /hookstorm/state` exist only when `HOOKSTORM=1`. `npm run dev:hookstorm` sets it; never set it in production.
