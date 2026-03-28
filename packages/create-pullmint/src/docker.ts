import { exec, execSync } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface DockerCheckResult {
  dockerOk: boolean;
  composeOk: boolean;
  dockerVersion?: string;
  composeVersion?: string;
}

export function checkDockerInstalled(): DockerCheckResult {
  let dockerOk = false;
  let composeOk = false;
  let dockerVersion: string | undefined;
  let composeVersion: string | undefined;

  try {
    dockerVersion = execSync('docker --version', { stdio: 'pipe' }).toString().trim();
    dockerOk = true;
  } catch {
    dockerOk = false;
  }

  try {
    composeVersion = execSync('docker compose version', { stdio: 'pipe' }).toString().trim();
    composeOk = true;
  } catch {
    try {
      composeVersion = execSync('docker-compose --version', { stdio: 'pipe' }).toString().trim();
      composeOk = true;
    } catch {
      composeOk = false;
    }
  }

  return { dockerOk, composeOk, dockerVersion, composeVersion };
}

export function checkToolInstalled(tool: string): boolean {
  try {
    execSync(`which ${tool}`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

export async function pullImages(installDir: string): Promise<void> {
  await execAsync('docker compose pull', { cwd: installDir });
}

export async function composeLaunch(installDir: string): Promise<void> {
  await execAsync('docker compose up -d', { cwd: installDir });
}

export interface HealthPollOptions {
  apiBase?: string;
  timeoutMs?: number;
  intervalMs?: number;
  onTick?: (elapsedMs: number) => void;
}

export async function waitForHealth(opts: HealthPollOptions = {}): Promise<void> {
  const {
    apiBase = 'http://localhost:3000',
    timeoutMs = 120_000,
    intervalMs = 2_000,
    onTick,
  } = opts;

  const startTime = Date.now();
  const deadline = startTime + timeoutMs;

  async function pollUntil(url: string): Promise<void> {
    while (Date.now() < deadline) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(3_000) });
        if (res.ok) {
          return;
        }
      } catch {
        // Service not ready yet.
      }

      onTick?.(Date.now() - startTime);
      await sleep(intervalMs);
    }

    throw new Error(
      `Timed out waiting for ${url} after ${timeoutMs / 1000}s. Check: docker compose logs api`
    );
  }

  await pollUntil(`${apiBase}/health`);
  await pollUntil(`${apiBase}/health/ready`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
