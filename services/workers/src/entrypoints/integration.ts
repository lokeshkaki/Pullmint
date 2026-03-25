import { startIntegrationGroup } from '../groups/integration-group.js';

async function run(): Promise<void> {
  const { shutdown } = await startIntegrationGroup();

  process.on('SIGTERM', () => {
    void shutdown().then(() => process.exit(0));
  });

  process.on('SIGINT', () => {
    void shutdown().then(() => process.exit(0));
  });
}

run().catch((err) => {
  console.error('Failed to start integration worker group:', err);
  process.exit(1);
});
