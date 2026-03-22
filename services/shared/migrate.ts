import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { existsSync } from 'fs';
import { join, resolve } from 'path';
import postgres from 'postgres';

function resolveMigrationsFolder(): string {
  const candidates = [
    join(__dirname, '../drizzle'),
    join(__dirname, 'drizzle'),
    resolve(process.cwd(), 'services/shared/drizzle'),
    resolve(process.cwd(), 'drizzle'),
  ];

  for (const folder of candidates) {
    if (existsSync(folder)) {
      return folder;
    }
  }

  return './drizzle';
}

export async function runMigrations(): Promise<void> {
  const connectionString =
    process.env.DATABASE_URL || 'postgresql://pullmint:pullmint@localhost:5432/pullmint';

  const sql = postgres(connectionString, { max: 1 });
  const db = drizzle(sql);
  const migrationsFolder = resolveMigrationsFolder();

  console.log('Running database migrations...');
  await migrate(db, { migrationsFolder });
  console.log('Migrations complete.');

  await sql.end();
}

if (require.main === module) {
  runMigrations().catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
}
