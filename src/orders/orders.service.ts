import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import Stripe from 'stripe';
import { DatabaseService } from '../db/database.service';
import { OutboxService } from '../email/outbox.service';
import { STRIPE } from '../stripe.provider';

export interface Order {
  id: string;
  product_id: string;
  quantity: number;
  amount: number;
  customer_email: string;
  status: 'pending' | 'paid' | 'refunded';
  payment_intent_id: string | null;
}

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly outbox: OutboxService,
    @Inject(STRIPE) private readonly stripe: Stripe,
  ) {}

  async checkout(productId: string, quantity: number, email: string) {
    const product = await this.db.one<{ price: number; stock: number }>('SELECT * FROM products WHERE id = $1', [productId]);
    if (!product) throw new NotFoundException('Unknown product');
    if (product.stock < quantity) throw new BadRequestException('Not enough tickets left');

    const order = (await this.db.one<Order>(
      `INSERT INTO orders (product_id, quantity, amount, customer_email) VALUES ($1, $2, $3, $4) RETURNING *`,
      [productId, quantity, product.price * quantity, email],
    ))!;

    // Test mode: pay with Stripe's test card straight away, so no frontend is needed.
    const intent = await this.stripe.paymentIntents.create({
      amount: order.amount,
      currency: 'usd',
      metadata: { order_id: order.id },
      payment_method: 'pm_card_visa',
      confirm: true,
      automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
    });
    await this.db.query('UPDATE orders SET payment_intent_id = $1, updated_at = now() WHERE id = $2', [intent.id, order.id]);
    return { ...order, payment_intent_id: intent.id, payment_status: intent.status };
  }

  async refund(orderId: string) {
    const order = await this.db.one<Order>('SELECT * FROM orders WHERE id = $1', [orderId]);
    if (!order?.payment_intent_id) throw new NotFoundException('Order not found or not paid');
    const refund = await this.stripe.refunds.create({ payment_intent: order.payment_intent_id });
    return { orderId, refundId: refund.id, status: refund.status };
  }

  async get(orderId: string) {
    const order = await this.db.one<Order>('SELECT * FROM orders WHERE id = $1', [orderId]);
    if (!order) throw new NotFoundException();
    return order;
  }

  /**
   * Applies a Stripe event at most once, atomically with its effects. A duplicate delivery of the same event
   * (Stripe retry, concurrent copy) blocks on the primary key until the first transaction commits, then
   * inserts nothing and skips. If the first one rolled back, the duplicate applies it instead.
   */
  private async applyOnce(event: Stripe.Event, apply: (tx: PoolClient) => Promise<void>) {
    await this.db.transaction(async (tx) => {
      const claimed = await tx.query(
        'INSERT INTO processed_events (event_id, type) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING event_id',
        [event.id, event.type],
      );
      if (claimed.rowCount === 0) return; // already applied
      await apply(tx);
    });
  }

  /** payment_intent.succeeded */
  async markPaid(event: Stripe.Event, intent: Stripe.PaymentIntent) {
    await this.applyOnce(event, async (tx) => {
      // Lock the order so a concurrent refund for it waits for this payment, and vice versa.
      const { rows } = await tx.query<Order>('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [intent.metadata.order_id]);
      const order = rows[0];
      if (!order) {
        this.logger.warn(`payment for unknown order ${intent.metadata.order_id}`);
        return;
      }
      // One payment per order, whatever events Stripe sends (unique index on order_id + type).
      const payment = await tx.query(
        `INSERT INTO ledger_entries (order_id, type, amount) VALUES ($1, 'payment', $2)
         ON CONFLICT (order_id, type) DO NOTHING RETURNING id`,
        [order.id, intent.amount_received],
      );
      if (payment.rowCount === 0) return;
      // Status only moves forward: a payment that arrives after its refund records the money and the tickets
      // (the refund already gave them back), but leaves the order refunded.
      await tx.query(
        `UPDATE orders SET status = CASE WHEN status = 'refunded' THEN status ELSE 'paid' END, updated_at = now() WHERE id = $1`,
        [order.id],
      );
      await tx.query('UPDATE products SET stock = stock - $1 WHERE id = $2', [order.quantity, order.product_id]);
      await tx.query(
        'INSERT INTO email_outbox (order_id, recipient, amount) VALUES ($1, $2, $3) ON CONFLICT (order_id) DO NOTHING',
        [order.id, order.customer_email, order.amount],
      );
    });
    this.outbox.kick(); // send the receipt after the commit, outside the webhook's response time
  }

  /** charge.refunded */
  async markRefunded(event: Stripe.Event, charge: Stripe.Charge) {
    const paymentIntentId = typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id;
    await this.applyOnce(event, async (tx) => {
      const { rows } = await tx.query<Order>('SELECT * FROM orders WHERE payment_intent_id = $1 FOR UPDATE', [paymentIntentId]);
      const order = rows[0];
      if (!order) {
        this.logger.warn(`refund for unknown payment intent ${paymentIntentId}`);
        return;
      }
      const refund = await tx.query(
        `INSERT INTO ledger_entries (order_id, type, amount) VALUES ($1, 'refund', $2)
         ON CONFLICT (order_id, type) DO NOTHING RETURNING id`,
        [order.id, -charge.amount_refunded],
      );
      if (refund.rowCount === 0) return;
      await tx.query(`UPDATE orders SET status = 'refunded', updated_at = now() WHERE id = $1`, [order.id]);
      await tx.query('UPDATE products SET stock = stock + $1 WHERE id = $2', [order.quantity, order.product_id]);
    });
  }
}
