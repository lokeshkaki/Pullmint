import { startAnalysisGroup } from '../groups/analysis-group.js';

async function run(): Promise<void> {
  const { shutdown } = await startAnalysisGroup();

  process.on('SIGTERM', () => {
    void shutdown().then(() => process.exit(0));
  });

  process.on('SIGINT', () => {
    void shutdown().then(() => process.exit(0));
  });
}

run().catch((err) => {
  console.error('Failed to start analysis worker group:', err);
  process.exit(1);
});
