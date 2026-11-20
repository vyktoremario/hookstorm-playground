import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';

// Creates tables and seeds the product catalogue (only products that don't exist yet).
async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  await client.query(readFileSync(join(__dirname, '../../src/db/schema.sql'), 'utf8'));
  const products = JSON.parse(readFileSync(join(__dirname, '../../src/db/products.json'), 'utf8'));
  for (const p of products)
    await client.query(
      'INSERT INTO products (id, name, price, stock) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING',
      [p.id, p.name, p.price, p.stock],
    );
  await client.end();
  console.log('migrated');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
