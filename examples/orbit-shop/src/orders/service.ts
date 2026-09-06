import { query } from '../database/client.js';
import { publishOrderCreated } from '../events/publisher.js';
import type { Cart } from '../catalog/types.js';
export async function createOrder(cart: Cart, paymentId: string) {
  const order = { id: paymentId, total: cart.total };
  await publishOrderCreated(order);
  return order;
}
export async function getOrder(id: string) { return query('SELECT * FROM orders WHERE id = ?', [id]); }
