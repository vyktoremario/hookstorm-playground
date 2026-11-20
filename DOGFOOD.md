# Dogfooding Hookstorm on the ticket shop

Hookstorm 0.1.1 from npm, run against this app with hand-written Stripe-shaped events (3 orders, 1 refund, 10 events including types the app ignores). All 5 rules are listed in the README.

## Bugs Hookstorm found in the app

### 1. A retried or late payment after a refund pays the order again

`markPaid` skips orders whose status is `'paid'`. A refunded order's status is `'refunded'`, so a `payment_intent.succeeded` delivered after the refund runs the payment again. That happens when Stripe retries after a lost response, or when the events arrive out of order. The result:

- a second `payment` ledger entry;
- tickets taken out of stock again;
- a second receipt email;
- the order flipped from `refunded` back to `paid`.

Example, `realistic` profile, seed 2:

```text
196ms  payment_intent.succeeded attempt 1 → response dropped (app processed it, provider saw a failure)
199ms  charge.refunded attempt 1 → acknowledged 200
206ms  side effect email.receipts → 200
257ms  payment_intent.succeeded attempt 2 → acknowledged 200        ← processes the payment again
266ms  side effect email.receipts → 200
→ order …0001 ended as "paid" after its refund was acknowledged; afrobeats stock 94, expected 96
```

Broken in 3/10 seeds on `realistic` (seeds 1–10).

### 2. Concurrent duplicate deliveries both process the payment

The status check runs outside the transaction and doesn't lock the row. Two deliveries of the same event that arrive together both see `pending` and both process the payment. Orders that were never refunded got two payment entries in 13 of 30 seeds on `hostile` (seeds 100–129).

### The usual fix for both

- Record processed event ids in a `processed_events` table with a unique constraint, inserted in the same transaction as the work: `INSERT … ON CONFLICT DO NOTHING`, and stop if nothing was inserted.
- Lock the order (`SELECT … FOR UPDATE`) inside the transaction, and only move status forward: `pending → paid → refunded`.
- Send the receipt from an outbox after the commit, not inline. Right now a failing email API turns into a 500 after the payment is committed. The retry then skips the order as already paid, so the receipt is never sent.

## Friction in Hookstorm (things to improve)

1. **Seeding the "before" state isn't covered.** Recorded events refer to rows that must already exist, here orders created at checkout. The guide's `reset` example only truncates tables. Do that here and every event hits "unknown order", the handler logs a warning and answers 200, and **every rule passes without testing anything**. This is the most important finding. The guide should cover seeding, and a ready-made "acknowledged events actually changed something" rule (or a warning when the state never changes) would catch it.
2. **The CLI doesn't load `.env`.** The secret in the config has to match the app's `STRIPE_WEBHOOK_SECRET`, which lives in `.env`. Worked around with `process.loadEnvFile()` in the config. An `--env-file` flag, or loading `.env` by default, would help.
3. **`init --provider stripe` sample events don't fit real apps** (`order_id: "ord_1"`, no `amount_received`). They're fine as an illustration, but `init` should say to replace them with a recording first.
4. **Timelines are noisy.** Grouping by business key also shows unrelated event types for that order (`payment_intent.created`, `charge.succeeded`). Hiding attempts of event types no rule refers to, or a `--timeline-types` filter, would make the cause easier to see.
5. **One duplicate is reported twice:** by `atMostOnce` and by `exactlyOnce` (which also flags duplicates). That's correct, but it inflates the count. Worth a note in the guide.
6. **The "races may be timing-dependent" note appears on deterministic failures** whenever the plan has *any* concurrent delivery for that order, even when the failure came from a dropped response. It should only appear when a concurrent delivery overlapped the attempts behind the violation.
7. **What worked well:**
   - signatures checked by the real Stripe SDK, with no changes to the app;
   - the probe and reset routes plus `custom` rules over SQL state;
   - `import.meta.url` and `readFileSync` inside a TypeScript config;
   - the reproduce command.
