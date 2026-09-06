import { index, sourceFile } from "./graph.js";
import { digest } from "./security.js";
import type { Repository } from "./types.js";
const files: Record<string, string> = {
  "src/api/checkout.ts": `import { createOrder } from '../orders/service.js';\nimport { authorizePayment } from '../payments/gateway.js';\nimport type { Cart } from '../catalog/types.js';\n\nexport async function checkout(cart: Cart) {\n  const payment = await authorizePayment(cart.total);\n  return createOrder(cart, payment.id);\n}\n`,
  "src/api/products.ts": `import { listProducts } from '../catalog/repository.js';\nexport async function products() { return listProducts(); }\n`,
  "src/api/orders.ts": `import { getOrder } from '../orders/service.js';\nexport async function order(id: string) { return getOrder(id); }\n`,
  "src/api/health.ts": `export function health() { return { status: 'ok' }; }\n`,
  "src/catalog/types.ts": `export interface Product { id: string; name: string; price: number; }\nexport interface Cart { items: Product[]; total: number; }\n`,
  "src/catalog/repository.ts": `import { query } from '../database/client.js';\nimport type { Product } from './types.js';\nexport async function listProducts(): Promise<Product[]> { return query('SELECT * FROM products'); }\n`,
  "src/catalog/pricing.ts": `import type { Cart } from './types.js';\nexport function calculateTotal(cart: Cart) { return cart.items.reduce((sum, item) => sum + item.price, 0); }\n`,
  "src/orders/service.ts": `import { query } from '../database/client.js';\nimport { publishOrderCreated } from '../events/publisher.js';\nimport type { Cart } from '../catalog/types.js';\nexport async function createOrder(cart: Cart, paymentId: string) {\n  const order = { id: paymentId, total: cart.total };\n  await publishOrderCreated(order);\n  return order;\n}\nexport async function getOrder(id: string) { return query('SELECT * FROM orders WHERE id = ?', [id]); }\n`,
  "src/orders/types.ts": `export interface Order { id: string; total: number; status: 'pending' | 'paid'; }\n`,
  "src/payments/gateway.ts": `import { paymentConfig } from './config.js';\nimport { audit } from '../observability/audit.js';\nexport async function authorizePayment(amount: number) {\n  audit('payment.authorized', { amount });\n  return { id: 'sample-payment', amount, currency: paymentConfig.currency };\n}\n`,
  "src/payments/config.ts": `export const paymentConfig = { currency: 'USD', endpoint: process.env.PAYMENT_ENDPOINT };\n`,
  "src/payments/refunds.ts": `import { getOrder } from '../orders/service.js';\nimport { audit } from '../observability/audit.js';\nexport async function refund(id: string) { const order = await getOrder(id); audit('refund.requested', { id }); return order; }\n`,
  "src/database/client.ts": `export async function query<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {\n  // Sample adapter: no database is contacted by the demonstration.\n  return [];\n}\n`,
  "src/database/schema.sql": `CREATE TABLE products (id TEXT PRIMARY KEY, name TEXT NOT NULL, price INTEGER NOT NULL);\nCREATE TABLE orders (id TEXT PRIMARY KEY, total INTEGER NOT NULL);\n`,
  "src/events/publisher.ts": `import { audit } from '../observability/audit.js';\nexport async function publishOrderCreated(order: { id: string; total: number }) { audit('order.created', order); }\n`,
  "src/events/consumer.ts": `import { sendReceipt } from '../notifications/email.js';\nexport async function handleOrderCreated(order: { id: string }) { return sendReceipt(order.id); }\n`,
  "src/notifications/email.ts": `import { receiptTemplate } from './templates.js';\nexport function sendReceipt(id: string) { return receiptTemplate(id); }\n`,
  "src/notifications/templates.ts": `export const receiptTemplate = (id: string) => 'Receipt for ' + id;\n`,
  "src/observability/audit.ts": `export function audit(event: string, attributes: Record<string, unknown>) { return { event, attributes }; }\n`,
  "tests/checkout.test.ts": `import { checkout } from '../src/api/checkout.js';\nimport { calculateTotal } from '../src/catalog/pricing.js';\nexport async function checkoutContract() { return checkout({ items: [], total: 0 }); }\n`,
  "tests/payments.test.ts": `import { authorizePayment } from '../src/payments/gateway.js';\nexport async function paymentContract() { return authorizePayment(1200); }\n`,
  "tests/orders.test.ts": `import { createOrder } from '../src/orders/service.js';\nexport async function orderContract() { return createOrder({ items: [], total: 0 }, 'test'); }\n`,
  "README.md": `# Orbit Shop\nA small, explicitly labeled sample repository for the Caelogram demonstration.\nPayment, order, catalogue, notification, and event boundaries.\n`,
  ".github/workflows/ci.yml": `name: Validate\non: [pull_request]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo "Sample workflow only"\n`,
};
export function demoRepository(): Repository {
  const source = Object.entries(files).map(([p, c]) => sourceFile(p, c));
  const revision = digest(source).slice(0, 40);
  return {
    id: "orbit-shop-demo",
    name: "examples/orbit-shop",
    branch: "main",
    installationId: 0,
    status: "sample",
    graph: index(source, revision),
  };
}
