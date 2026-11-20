import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';

// After recording events with real checkouts, save the orders they refer to (as unpaid) so
// POST /hookstorm/reset can recreate the "before the webhooks" state for every replay.
async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const { rows } = await client.query(
    `SELECT id, product_id, quantity, amount, customer_email, payment_intent_id
       FROM orders WHERE payment_intent_id IS NOT NULL ORDER BY created_at`,
  );
  await client.end();
  const dir = join(__dirname, '../../hookstorm');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'seed.json'), JSON.stringify({ orders: rows }, null, 2) + '\n');
  console.log(`wrote ${rows.length} orders to hookstorm/seed.json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
