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
