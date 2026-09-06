import { createOrder } from '../orders/service.js';
import { authorizePayment } from '../payments/gateway.js';
import type { Cart } from '../catalog/types.js';

export async function checkout(cart: Cart) {
  const payment = await authorizePayment(cart.total);
  return createOrder(cart, payment.id);
}
