import { DatabaseSync } from "node:sqlite";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Fault } from "./security.js";
export class Store {
  db: DatabaseSync;
  key?: Buffer;
  constructor(file = ":memory:", key?: string) {
    if (file !== ":memory:")
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    if (key) {
      if (!/^[a-f0-9]{64}$/i.test(key))
        throw new Error("Data key must be 32 hex-encoded bytes");
      this.key = Buffer.from(key, "hex");
    }
    this.db = new DatabaseSync(file);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS objects(tenant TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(tenant,kind,id));
      CREATE TABLE IF NOT EXISTS audit(id TEXT PRIMARY KEY, tenant TEXT NOT NULL, at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS deliveries(id TEXT PRIMARY KEY, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, updated TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS immutable_audit_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT,'Audit is append only'); END;
      CREATE TRIGGER IF NOT EXISTS immutable_audit_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT,'Audit is append only'); END;`);
  }
  encode(value: unknown) {
    const raw = JSON.stringify(value);
    if (!this.key) return raw;
    const iv = randomBytes(12),
      c = createCipheriv("aes-256-gcm", this.key, iv);
    return JSON.stringify({
      iv: Buffer.from(iv).toString("base64"),
      tag: (() => {
        const b = Buffer.concat([c.update(raw, "utf8"), c.final()]);
        return {
          tag: Buffer.from(c.getAuthTag()).toString("base64"),
          data: b.toString("base64"),
        };
      })(),
    });
  }
  decode<T>(raw: string): T {
    if (!this.key) return JSON.parse(raw);
    const x = JSON.parse(raw),
      d = createDecipheriv(
        "aes-256-gcm",
        this.key,
        Buffer.from(x.iv, "base64"),
      );
    d.setAuthTag(Buffer.from(x.tag.tag, "base64"));
    return JSON.parse(
      Buffer.concat([
        d.update(Buffer.from(x.tag.data, "base64")),
        d.final(),
      ]).toString(),
    );
  }
  put<T extends { id: string }>(tenant: string, kind: string, value: T) {
    this.db
      .prepare(
        "INSERT INTO objects VALUES(?,?,?,?) ON CONFLICT(tenant,kind,id) DO UPDATE SET body=excluded.body",
      )
      .run(tenant, kind, value.id, this.encode(value));
    return value;
  }
  get<T>(tenant: string, kind: string, id: string): T {
    const row = this.db
      .prepare("SELECT body FROM objects WHERE tenant=? AND kind=? AND id=?")
      .get(tenant, kind, id);
    if (!row) throw new Fault(404, "Resource not found");
    return this.decode<T>(String(row.body));
  }
  list<T>(tenant: string, kind: string): T[] {
    return this.db
      .prepare("SELECT body FROM objects WHERE tenant=? AND kind=?")
      .all(tenant, kind)
      .map((r) => this.decode<T>(String(r.body)));
  }
  remove(tenant: string, kind: string, id: string) {
    this.db
      .prepare("DELETE FROM objects WHERE tenant=? AND kind=? AND id=?")
      .run(tenant, kind, id);
  }
  audit(tenant: string, actor: string, action: string, target: string) {
    this.db
      .prepare("INSERT INTO audit VALUES(?,?,?,?,?,?)")
      .run(
        randomUUID(),
        tenant,
        new Date().toISOString(),
        actor,
        action,
        target,
      );
  }
  events(tenant: string) {
    return this.db
      .prepare(
        "SELECT at,actor,action,target FROM audit WHERE tenant=? ORDER BY at DESC LIMIT 100",
      )
      .all(tenant);
  }
  close() {
    this.db.close();
  }
}
