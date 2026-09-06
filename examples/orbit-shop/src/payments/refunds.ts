import { getOrder } from '../orders/service.js';
import { audit } from '../observability/audit.js';
export async function refund(id: string) { const order = await getOrder(id); audit('refund.requested', { id }); return order; }
