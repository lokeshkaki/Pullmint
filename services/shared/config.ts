import { readFileSync } from 'fs';

export function getConfig(key: string): string {
  const value = process.env[key];
  if (value) {
    return value;
  }

  const pathKey = `${key}_PATH`;
  const filePath = process.env[pathKey];

  if (filePath) {
    try {
      return readFileSync(filePath, 'utf-8').trim();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to read secret from file ${filePath} (env var ${pathKey}): ${message}`
      );
    }
  }

  throw new Error(
    `Configuration key "${key}" not found. Set ${key} or ${pathKey} environment variable.`
  );
}

export function getConfigOptional(key: string): string | undefined {
  try {
    return getConfig(key);
  } catch {
    return undefined;
  }
}
