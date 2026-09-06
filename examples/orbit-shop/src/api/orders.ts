import { getOrder } from '../orders/service.js';
export async function order(id: string) { return getOrder(id); }
