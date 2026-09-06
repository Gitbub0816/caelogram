CREATE TABLE objects(tenant TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, object_key TEXT NOT NULL, PRIMARY KEY(tenant,kind,id));
CREATE TABLE audit(id TEXT PRIMARY KEY, tenant TEXT NOT NULL, at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL);
CREATE INDEX audit_tenant_time ON audit(tenant,at DESC);
CREATE TRIGGER immutable_audit_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT,'Audit is append only'); END;
CREATE TRIGGER immutable_audit_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT,'Audit is append only'); END;
CREATE TABLE locks(tenant TEXT PRIMARY KEY, owner TEXT NOT NULL, acquired TEXT NOT NULL);
CREATE TABLE jobs(id TEXT PRIMARY KEY, body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, updated TEXT NOT NULL);
CREATE TABLE garbage(object_key TEXT PRIMARY KEY);
