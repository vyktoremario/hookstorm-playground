import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { OrdersService } from './orders.service';

@Controller()
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post('checkout')
  checkout(@Body() body: { productId: string; quantity?: number; email: string }) {
    return this.orders.checkout(body.productId, body.quantity ?? 1, body.email);
  }

  @Post('orders/:id/refund')
  refund(@Param('id') id: string) {
    return this.orders.refund(id);
  }

  @Get('orders/:id')
  get(@Param('id') id: string) {
    return this.orders.get(id);
  }
}
