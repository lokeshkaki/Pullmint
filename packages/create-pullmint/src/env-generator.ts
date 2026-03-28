import * as fs from 'fs-extra';
import * as path from 'path';
import { EnvConfig, generateEnvFile } from './templates/env.template';

export interface WriteEnvOptions {
  installDir: string;
  config: EnvConfig;
  privateKeyPemContent?: string;
}

export async function writeEnvFiles(
  opts: WriteEnvOptions
): Promise<{ envPath: string; pemPath?: string }> {
  const { installDir, config, privateKeyPemContent } = opts;
  await fs.ensureDir(installDir);

  const envPath = path.join(installDir, '.env');
  await fs.writeFile(envPath, generateEnvFile(config), {
    encoding: 'utf8',
    mode: 0o600,
  });

  let pemPath: string | undefined;
  if (privateKeyPemContent && privateKeyPemContent.trim()) {
    const secretsDir = path.join(installDir, 'secrets');
    await fs.ensureDir(secretsDir);
    pemPath = path.join(secretsDir, 'github-app.pem');
    await fs.writeFile(pemPath, `${privateKeyPemContent.trim()}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
  }

  return { envPath, pemPath };
}
