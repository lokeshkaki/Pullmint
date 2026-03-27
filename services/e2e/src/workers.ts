// services/e2e/src/workers.ts
import { startAnalysisGroup } from '../../workers/src/groups/analysis-group';
import { startIntegrationGroup } from '../../workers/src/groups/integration-group';

let shutdownFns: Array<() => Promise<void>> = [];

export async function startWorkers(): Promise<void> {
  const analysis = await startAnalysisGroup();
  const integration = await startIntegrationGroup();
  shutdownFns = [analysis.shutdown, integration.shutdown];
  // background group not needed for pipeline tests
}

export async function stopWorkers(): Promise<void> {
  await Promise.all(shutdownFns.map((fn) => fn()));
  shutdownFns = [];
}
