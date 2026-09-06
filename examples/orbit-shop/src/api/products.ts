import { listProducts } from '../catalog/repository.js';
export async function products() { return listProducts(); }
