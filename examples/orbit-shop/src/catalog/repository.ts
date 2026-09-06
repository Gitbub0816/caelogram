import { query } from '../database/client.js';
import type { Product } from './types.js';
export async function listProducts(): Promise<Product[]> { return query('SELECT * FROM products'); }
