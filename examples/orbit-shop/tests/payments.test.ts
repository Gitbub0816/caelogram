import { authorizePayment } from '../src/payments/gateway.js';
export async function paymentContract() { return authorizePayment(1200); }
