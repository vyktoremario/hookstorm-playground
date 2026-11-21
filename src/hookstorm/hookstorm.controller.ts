import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseService } from '../db/database.service';

// TEST-ONLY routes for Hookstorm. Mounted only when HOOKSTORM=1 (see app.module.ts). Never enable in production.
//
// Replaying recorded Stripe events needs the orders those events refer to, in the state they were in *before*
// the events arrived. `npm run hookstorm:export-seed` writes them to hookstorm/seed.json after a recording.
const root = join(__dirname, '../..');

interface SeedOrder {
  id: string;
  product_id: string;
  quantity: number;
  amount: number;
  customer_email: string;
  payment_intent_id: string;
}

@Controller('hookstorm')
export class HookstormController {
  constructor(private readonly db: DatabaseService) {}

  @Post('reset')
  @HttpCode(204)
  async reset() {
    const products = JSON.parse(readFileSync(join(root, 'src/db/products.json'), 'utf8'));
    // Same rule as hookstorm.config.ts: a real recording if there is one, else the hand-written sample.
    const recorded = existsSync(join(root, 'hookstorm/events.jsonl'));
    const seedPath = join(root, recorded ? 'hookstorm/seed.json' : 'hookstorm/sample/seed.json');
    const orders: SeedOrder[] = JSON.parse(readFileSync(seedPath, 'utf8')).orders;
    await this.db.transaction(async (tx) => {
      await tx.query('TRUNCATE email_outbox, processed_events, ledger_entries, orders');
      for (const p of products) await tx.query('UPDATE products SET stock = $1 WHERE id = $2', [p.stock, p.id]);
      for (const o of orders)
        await tx.query(
          `INSERT INTO orders (id, product_id, quantity, amount, customer_email, status, payment_intent_id)
           VALUES ($1, $2, $3, $4, $5, 'pending', $6)`,
          [o.id, o.product_id, o.quantity, o.amount, o.customer_email, o.payment_intent_id],
        );
    });
  }

  @Get('state')
  async state() {
    return {
      orders: await this.db.query('SELECT id, product_id, quantity, amount, status, payment_intent_id FROM orders ORDER BY created_at'),
      products: await this.db.query('SELECT id, stock FROM products ORDER BY id'),
      ledger: await this.db.query('SELECT order_id, type, amount FROM ledger_entries ORDER BY id'),
    };
  }
}
