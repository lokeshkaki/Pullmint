import { startAnalysisGroup } from './groups/analysis-group.js';
import { startIntegrationGroup } from './groups/integration-group.js';
import { startBackgroundGroup } from './groups/background-group.js';

async function start(): Promise<void> {
  const group = process.env.WORKER_GROUP;

  if (group === 'analysis') {
    console.log('Starting analysis worker group...');
    const { shutdown } = await startAnalysisGroup();
    setupShutdown(shutdown);
    return;
  }

  if (group === 'integration') {
    console.log('Starting integration worker group...');
    const { shutdown } = await startIntegrationGroup();
    setupShutdown(shutdown);
    return;
  }

  if (group === 'background') {
    console.log('Starting background worker group...');
    const { shutdown } = await startBackgroundGroup();
    setupShutdown(shutdown);
    return;
  }

  console.log('Starting Pullmint workers (unified mode)...');

  const analysis = await startAnalysisGroup();
  const integration = await startIntegrationGroup();
  const background = await startBackgroundGroup();

  console.log('All worker groups started');

  const shutdown = async (): Promise<void> => {
    console.log('Shutting down all worker groups...');
    await Promise.all([analysis.shutdown(), integration.shutdown(), background.shutdown()]);
  };

  setupShutdown(shutdown);
}

function setupShutdown(shutdown: () => Promise<void>): void {
  let isShuttingDown = false;

  const handleSignal = (): void => {
    if (isShuttingDown) {
      return;
    }
    isShuttingDown = true;

    void shutdown()
      .then(() => process.exit(0))
      .catch((error) => {
        console.error('Failed during worker shutdown:', error);
        process.exit(1);
      });
  };

  process.on('SIGTERM', () => {
    handleSignal();
  });
  process.on('SIGINT', () => {
    handleSignal();
  });
}

start().catch((err) => {
  console.error('Failed to start workers:', err);
  process.exit(1);
});
