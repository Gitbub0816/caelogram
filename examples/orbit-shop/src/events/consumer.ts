import { sendReceipt } from '../notifications/email.js';
export async function handleOrderCreated(order: { id: string }) { return sendReceipt(order.id); }
