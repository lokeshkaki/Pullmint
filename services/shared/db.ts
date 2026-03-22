import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

let dbInstance: ReturnType<typeof drizzle> | null = null;
let sqlClient: ReturnType<typeof postgres> | null = null;

export function getDb() {
  if (!dbInstance) {
    const connectionString =
      process.env.DATABASE_URL || 'postgresql://pullmint:pullmint@localhost:5432/pullmint';
    sqlClient = postgres(connectionString);
    dbInstance = drizzle(sqlClient, { schema });
  }

  return dbInstance;
}

export async function closeDb(): Promise<void> {
  if (sqlClient) {
    await sqlClient.end();
    sqlClient = null;
    dbInstance = null;
  }
}

export { schema };
