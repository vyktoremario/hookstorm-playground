import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../db/database.service';
import { EmailService } from './email.service';

interface OutboxRow {
  id: number;
  order_id: string;
  recipient: string;
  amount: number;
  attempts: number;
}

/**
 * Sends receipts written to `email_outbox` by the webhook transaction, after it commits. A slow or failing email
 * API no longer makes the webhook slow or fail, and a receipt can't be lost or sent twice for the same order.
 *
 * Single-process version for the playground. With several instances, claim rows with
 * `SELECT … FOR UPDATE SKIP LOCKED` inside a transaction instead of the in-memory `draining` flag.
 */
@Injectable()
export class OutboxService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxService.name);
  private timer: NodeJS.Timeout | undefined;
  private draining = false;
  private again = false;

  constructor(
    private readonly db: DatabaseService,
    private readonly email: EmailService,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => this.kick(), 1000); // also picks up anything left after a crash
    this.timer.unref();
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  /** Call after committing rows to the outbox. */
  kick() {
    void this.drain();
  }

  private async drain() {
    if (this.draining) {
      this.again = true;
      return;
    }
    this.draining = true;
    try {
      do {
        this.again = false;
        const rows = await this.db.query<OutboxRow>(
          'SELECT * FROM email_outbox WHERE sent_at IS NULL AND attempts < 10 ORDER BY id LIMIT 50',
        );
        for (const row of rows) {
          try {
            await this.email.sendReceipt({ orderId: row.order_id, to: row.recipient, amount: row.amount });
            await this.db.query('UPDATE email_outbox SET sent_at = now(), attempts = attempts + 1 WHERE id = $1', [row.id]);
          } catch (err) {
            await this.db.query('UPDATE email_outbox SET attempts = attempts + 1 WHERE id = $1', [row.id]);
            this.logger.warn(`receipt for order ${row.order_id} failed (attempt ${row.attempts + 1}): ${(err as Error).message}`);
            setTimeout(() => this.kick(), 100 * (row.attempts + 1)).unref();
          }
        }
      } while (this.again);
    } finally {
      this.draining = false;
    }
  }
}
