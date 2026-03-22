import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

export async function runMigrations(): Promise<void> {
  const connectionString =
    process.env.DATABASE_URL || 'postgresql://pullmint:pullmint@localhost:5432/pullmint';

  const sql = postgres(connectionString, { max: 1 });
  const db = drizzle(sql);

  console.log('Running database migrations...');
  await migrate(db, { migrationsFolder: './drizzle' });
  console.log('Migrations complete.');

  await sql.end();
}

if (require.main === module) {
  runMigrations().catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
}
