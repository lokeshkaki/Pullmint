import postgres from 'postgres';
import * as schema from './schema';
export declare function getDb(): import("drizzle-orm/postgres-js").PostgresJsDatabase<Record<string, unknown>> & {
    $client: postgres.Sql<{}>;
};
export declare function closeDb(): Promise<void>;
export { schema };
//# sourceMappingURL=db.d.ts.map