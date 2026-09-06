import { paymentConfig } from './config.js';
import { audit } from '../observability/audit.js';
export async function authorizePayment(amount: number) {
  audit('payment.authorized', { amount });
  return { id: 'sample-payment', amount, currency: paymentConfig.currency };
}
