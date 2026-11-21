CREATE TABLE IF NOT EXISTS products (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  price       integer NOT NULL,          -- cents
  stock       integer NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id         text NOT NULL REFERENCES products(id),
  quantity           integer NOT NULL,
  amount             integer NOT NULL,   -- cents
  customer_email     text NOT NULL,
  status             text NOT NULL DEFAULT 'pending',  -- pending | paid | refunded
  payment_intent_id  text UNIQUE,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id          serial PRIMARY KEY,
  order_id    uuid NOT NULL REFERENCES orders(id),
  type        text NOT NULL,             -- payment | refund
  amount      integer NOT NULL,          -- cents, negative for refunds
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Fix: every Stripe event is applied at most once. The insert happens in the same transaction as the event's
-- effects, so a duplicate delivery either waits for the first to commit and then skips, or applies it if the
-- first one rolled back.
CREATE TABLE IF NOT EXISTS processed_events (
  event_id      text PRIMARY KEY,
  type          text NOT NULL,
  processed_at  timestamptz NOT NULL DEFAULT now()
);

-- Fix: at most one payment and one refund per order, even if Stripe sent two different events for the same thing.
CREATE UNIQUE INDEX IF NOT EXISTS ledger_entries_one_per_type ON ledger_entries (order_id, type);

-- Fix: receipts go through an outbox written in the payment's transaction, and are sent after it commits.
-- One receipt per order, retried until the email API accepts it.
CREATE TABLE IF NOT EXISTS email_outbox (
  id          serial PRIMARY KEY,
  order_id    uuid NOT NULL UNIQUE REFERENCES orders(id),
  recipient   text NOT NULL,
  amount      integer NOT NULL,
  attempts    integer NOT NULL DEFAULT 0,
  sent_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
