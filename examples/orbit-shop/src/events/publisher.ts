import { audit } from '../observability/audit.js';
export async function publishOrderCreated(order: { id: string; total: number }) { audit('order.created', order); }
