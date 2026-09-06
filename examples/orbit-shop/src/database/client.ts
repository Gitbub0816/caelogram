export async function query<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
  // Sample adapter: no database is contacted by the demonstration.
  return [];
}
