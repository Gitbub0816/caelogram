import { createOrder } from '../src/orders/service.js';
export async function orderContract() { return createOrder({ items: [], total: 0 }, 'test'); }
