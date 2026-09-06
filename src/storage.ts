/** Async-compatible domain persistence; adapters never receive GitHub credentials. */
export type Awaitable<T> = T | Promise<T>;
export interface Storage {
  put<T extends { id: string }>(
    tenant: string,
    kind: string,
    value: T,
  ): Awaitable<T>;
  get<T>(tenant: string, kind: string, id: string): Awaitable<T>;
  list<T>(tenant: string, kind: string): Awaitable<T[]>;
  remove(tenant: string, kind: string, id: string): Awaitable<void>;
  audit(
    tenant: string,
    actor: string,
    action: string,
    target: string,
  ): Awaitable<void>;
  events(tenant: string): Awaitable<unknown[]>;
}
