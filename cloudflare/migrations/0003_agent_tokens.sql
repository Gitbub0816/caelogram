CREATE TABLE agent_tokens(hash TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE, tenant TEXT NOT NULL, subject TEXT NOT NULL, label TEXT NOT NULL, scopes TEXT NOT NULL, repositories TEXT NOT NULL, expires INTEGER NOT NULL, created INTEGER NOT NULL);
CREATE INDEX agent_tokens_tenant ON agent_tokens(tenant);
