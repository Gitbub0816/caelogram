import type { Storage } from "../src/storage.js";
import { Fault, assert } from "../src/security.js";
/** D1 contains references, never source. R2 objects are AEAD-bound to tenant/kind/id. */
export class CloudStore implements Storage {
  private key: Promise<CryptoKey>;
  constructor(
    public db: D1Database,
    public bucket: R2Bucket,
    hexKey: string,
  ) {
    assert(
      /^[0-9a-f]{64}$/i.test(hexKey),
      "Configure DATA_KEY with 32 hex bytes",
      503,
    );
    this.key = crypto.subtle.importKey(
      "raw",
      Uint8Array.from(hexKey.match(/../g)!, (x) => parseInt(x, 16)),
      "AES-GCM",
      false,
      ["encrypt", "decrypt"],
    );
  }
  private aad(tenant: string, kind: string, id: string) {
    return new TextEncoder().encode(JSON.stringify([tenant, kind, id]));
  }
  async put<T extends { id: string }>(
    tenant: string,
    kind: string,
    value: T,
  ): Promise<T> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: this.aad(tenant, kind, value.id) },
      await this.key,
      new TextEncoder().encode(JSON.stringify(value)),
    );
    const payload = new Uint8Array(12 + ciphertext.byteLength);
    payload.set(iv);
    payload.set(new Uint8Array(ciphertext), 12);
    const objectKey = `private/${crypto.randomUUID()}`;
    // Stage every object for GC. The collector checks references before deletion.
    await this.db
      .prepare("INSERT INTO garbage VALUES(?)")
      .bind(objectKey)
      .run();
    await this.bucket.put(objectKey, payload, {
      httpMetadata: { contentType: "application/octet-stream" },
    });
    await this.db.batch([
      this.db
        .prepare(
          "INSERT OR IGNORE INTO garbage SELECT object_key FROM objects WHERE tenant=? AND kind=? AND id=?",
        )
        .bind(tenant, kind, value.id),
      this.db
        .prepare(
          "INSERT INTO objects VALUES(?,?,?,?) ON CONFLICT(tenant,kind,id) DO UPDATE SET object_key=excluded.object_key",
        )
        .bind(tenant, kind, value.id, objectKey),
      this.db.prepare("DELETE FROM garbage WHERE object_key=?").bind(objectKey),
    ]);
    return value;
  }
  async get<T>(tenant: string, kind: string, id: string): Promise<T> {
    const row = await this.db
      .prepare(
        "SELECT object_key FROM objects WHERE tenant=? AND kind=? AND id=?",
      )
      .bind(tenant, kind, id)
      .first<{ object_key: string }>();
    if (!row) throw new Fault(404, "Resource not found");
    const body = await this.bucket.get(row.object_key);
    assert(body, "Stored object unavailable", 503);
    const bytes = new Uint8Array(await body.arrayBuffer());
    const raw = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: bytes.slice(0, 12),
        additionalData: this.aad(tenant, kind, id),
      },
      await this.key,
      bytes.slice(12),
    );
    return JSON.parse(new TextDecoder().decode(raw));
  }
  async list<T>(tenant: string, kind: string): Promise<T[]> {
    const rows = await this.db
      .prepare(
        "SELECT id FROM objects WHERE tenant=? AND kind=? ORDER BY id LIMIT 1001",
      )
      .bind(tenant, kind)
      .all<{ id: string }>();
    assert(
      rows.results.length <= 1000,
      "Collection exceeds alpha limit; archive old tasks",
      413,
    );
    const result: T[] = [];
    for (let i = 0; i < rows.results.length; i += 8)
      result.push(
        ...(await Promise.all(
          rows.results
            .slice(i, i + 8)
            .map((r) => this.get<T>(tenant, kind, r.id)),
        )),
      );
    return result;
  }
  async remove(tenant: string, kind: string, id: string) {
    await this.db.batch([
      this.db
        .prepare(
          "INSERT OR IGNORE INTO garbage SELECT object_key FROM objects WHERE tenant=? AND kind=? AND id=?",
        )
        .bind(tenant, kind, id),
      this.db
        .prepare("DELETE FROM objects WHERE tenant=? AND kind=? AND id=?")
        .bind(tenant, kind, id),
    ]);
  }
  async audit(tenant: string, actor: string, action: string, target: string) {
    await this.db
      .prepare("INSERT INTO audit VALUES(?,?,?,?,?,?)")
      .bind(
        crypto.randomUUID(),
        tenant,
        new Date().toISOString(),
        actor,
        action,
        target,
      )
      .run();
  }
  async events(tenant: string) {
    return (
      await this.db
        .prepare(
          "SELECT at,actor,action,target FROM audit WHERE tenant=? ORDER BY at DESC LIMIT 100",
        )
        .bind(tenant)
        .all()
    ).results;
  }
  async exclusive<T>(tenant: string, run: () => Promise<T>): Promise<T> {
    const owner = crypto.randomUUID();
    const lock = await this.db
      .prepare("INSERT OR IGNORE INTO locks VALUES(?,?,?)")
      .bind(tenant, owner, new Date().toISOString())
      .run();
    assert(
      lock.meta.changes === 1,
      "Tenant mutation in progress. If a worker crashed, an operator must recover its lock.",
      409,
    );
    try {
      return await run();
    } finally {
      await this.db
        .prepare("DELETE FROM locks WHERE tenant=? AND owner=?")
        .bind(tenant, owner)
        .run();
    }
  }
  // Only call while ALL mutations are stopped. Prevents collecting an in-flight staged write.
  async collectOffline() {
    const rows = await this.db
      .prepare(
        "SELECT object_key FROM garbage WHERE object_key NOT IN (SELECT object_key FROM objects) LIMIT 500",
      )
      .all<{ object_key: string }>();
    for (const row of rows.results) {
      await this.bucket.delete(row.object_key);
      await this.db
        .prepare("DELETE FROM garbage WHERE object_key=?")
        .bind(row.object_key)
        .run();
    }
    return rows.results.length;
  }
}
