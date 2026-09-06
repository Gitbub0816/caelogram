import type { Cart } from './types.js';
export function calculateTotal(cart: Cart) { return cart.items.reduce((sum, item) => sum + item.price, 0); }
