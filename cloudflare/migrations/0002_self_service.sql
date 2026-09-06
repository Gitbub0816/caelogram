CREATE TABLE oauth_states(state TEXT PRIMARY KEY, tenant TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE INDEX oauth_states_expiry ON oauth_states(expires);
