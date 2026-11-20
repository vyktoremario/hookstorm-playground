import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import Stripe from 'stripe';
import { DatabaseService } from '../db/database.service';
import { EmailService } from '../email/email.service';
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
    private readonly email: EmailService,
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

  /** payment_intent.succeeded */
  async markPaid(intent: Stripe.PaymentIntent) {
    const orderId = intent.metadata.order_id;
    const order = await this.db.one<Order>('SELECT * FROM orders WHERE id = $1', [orderId]);
    if (!order) {
      this.logger.warn(`payment for unknown order ${orderId}`);
      return;
    }
    if (order.status === 'paid') return; // already processed

    await this.db.transaction(async (tx) => {
      await tx.query(`UPDATE orders SET status = 'paid', updated_at = now() WHERE id = $1`, [order.id]);
      await tx.query('UPDATE products SET stock = stock - $1 WHERE id = $2', [order.quantity, order.product_id]);
      await tx.query(`INSERT INTO ledger_entries (order_id, type, amount) VALUES ($1, 'payment', $2)`, [
        order.id,
        intent.amount_received,
      ]);
    });

    await this.email.sendReceipt({ orderId: order.id, to: order.customer_email, amount: order.amount });
  }

  /** charge.refunded */
  async markRefunded(charge: Stripe.Charge) {
    const paymentIntentId = typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id;
    const order = await this.db.one<Order>('SELECT * FROM orders WHERE payment_intent_id = $1', [paymentIntentId]);
    if (!order) {
      this.logger.warn(`refund for unknown payment intent ${paymentIntentId}`);
      return;
    }
    if (order.status === 'refunded') return; // already processed

    await this.db.transaction(async (tx) => {
      await tx.query(`UPDATE orders SET status = 'refunded', updated_at = now() WHERE id = $1`, [order.id]);
      await tx.query('UPDATE products SET stock = stock + $1 WHERE id = $2', [order.quantity, order.product_id]);
      await tx.query(`INSERT INTO ledger_entries (order_id, type, amount) VALUES ($1, 'refund', $2)`, [
        order.id,
        -charge.amount_refunded,
      ]);
    });
  }
}
