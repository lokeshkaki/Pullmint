jest.mock('postgres', () => {
  const mockSql = Object.assign(jest.fn(), {
    end: jest.fn().mockResolvedValue(undefined),
  });
  return jest.fn(() => mockSql);
});

jest.mock('drizzle-orm/postgres-js', () => ({
  drizzle: jest.fn(() => ({ select: jest.fn(), insert: jest.fn() })),
}));

describe('db', () => {
  beforeEach(() => {
    jest.resetModules();
    delete process.env.DATABASE_URL;
  });

  it('should create a singleton db instance', () => {
    const { getDb } = require('../db') as typeof import('../db');
    const db1 = getDb();
    const db2 = getDb();
    expect(db1).toBe(db2);
  });

  it('should use DATABASE_URL from environment', () => {
    process.env.DATABASE_URL = 'postgresql://custom:custom@myhost:5432/mydb';
    const { getDb } = require('../db') as typeof import('../db');
    getDb();
    const postgres = require('postgres') as jest.Mock;
    expect(postgres).toHaveBeenCalledWith('postgresql://custom:custom@myhost:5432/mydb');
  });

  it('should use default connection string when DATABASE_URL not set', () => {
    const { getDb } = require('../db') as typeof import('../db');
    getDb();
    const postgres = require('postgres') as jest.Mock;
    expect(postgres).toHaveBeenCalledWith('postgresql://pullmint:pullmint@localhost:5432/pullmint');
  });

  it('should close the sql client and reset singleton state', async () => {
    const { closeDb, getDb } = require('../db') as typeof import('../db');
    getDb();
    await closeDb();

    const postgres = require('postgres') as jest.Mock;
    const sqlInstance = postgres.mock.results[0].value;
    expect(sqlInstance.end).toHaveBeenCalledTimes(1);
  });
});
