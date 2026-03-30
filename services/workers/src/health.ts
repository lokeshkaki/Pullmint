import fs from 'fs';

const HEALTH_FILE = process.env.HEALTH_FILE || '/tmp/pullmint-worker-health';
const HEARTBEAT_INTERVAL_MS = 5_000;

let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

export function startHealthHeartbeat(): void {
  writeHeartbeat();
  heartbeatTimer = setInterval(writeHeartbeat, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref();
}

export function stopHealthHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
  }
}

function writeHeartbeat(): void {
  try {
    const epochSeconds = Math.floor(Date.now() / 1000);
    fs.writeFileSync(HEALTH_FILE, String(epochSeconds));
  } catch {
    // Best-effort heartbeat writes should not crash workers.
  }
}
