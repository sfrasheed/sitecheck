/** Thin D1 helpers. No domain knowledge lives here. */

export async function all<T>(db: D1Database, sql: string, ...binds: unknown[]): Promise<T[]> {
  const { results } = await db
    .prepare(sql)
    .bind(...binds)
    .all<T>();
  return results ?? [];
}

export async function one<T>(
  db: D1Database,
  sql: string,
  ...binds: unknown[]
): Promise<T | null> {
  return (
    (await db
      .prepare(sql)
      .bind(...binds)
      .first<T>()) ?? null
  );
}

export async function run(db: D1Database, sql: string, ...binds: unknown[]): Promise<void> {
  await db
    .prepare(sql)
    .bind(...binds)
    .run();
}
