import { startBackgroundGroup } from '../groups/background-group.js';

async function run(): Promise<void> {
  const { shutdown } = await startBackgroundGroup();

  process.on('SIGTERM', () => {
    void shutdown().then(() => process.exit(0));
  });

  process.on('SIGINT', () => {
    void shutdown().then(() => process.exit(0));
  });
}

run().catch((err) => {
  console.error('Failed to start background worker group:', err);
  process.exit(1);
});
