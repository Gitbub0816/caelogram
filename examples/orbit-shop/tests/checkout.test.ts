import { checkout } from '../src/api/checkout.js';
import { calculateTotal } from '../src/catalog/pricing.js';
export async function checkoutContract() { return checkout({ items: [], total: 0 }); }
