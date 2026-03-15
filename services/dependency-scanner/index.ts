import { DynamoDBDocumentClient, ScanCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { getGitHubInstallationClient } from '../shared/github-app';
import { retryWithBackoff } from '../shared/error-handling';

const EXECUTIONS_TABLE_NAME = process.env.EXECUTIONS_TABLE_NAME!;
const DEPENDENCY_GRAPH_TABLE_NAME = process.env.DEPENDENCY_GRAPH_TABLE_NAME!;

const TTL_48H_SECONDS = 48 * 60 * 60;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

type GitHubContentClient = {
  request: (
    route: string,
    params: Record<string, string>
  ) => Promise<{ data: { content?: string; encoding?: string } }>;
};

export const handler = async (): Promise<void> => {
  // 1. Scan executions table for distinct repos
  const { Items: executions = [] } = await ddb.send(
    new ScanCommand({
      TableName: EXECUTIONS_TABLE_NAME,
      ProjectionExpression: 'repoFullName',
    })
  );

  // Deduplicate
  const distinctRepos = [
    ...new Set(
      executions
        .map((e) => e.repoFullName as string | undefined)
        .filter((r): r is string => Boolean(r))
    ),
  ];

  // 2. Scan each repo for inter-repo dependencies
  for (const repoFullName of distinctRepos) {
    try {
      await scanRepoForDependencies(repoFullName, distinctRepos);
    } catch (error) {
      console.error(`Failed to scan repo ${repoFullName}:`, error);
      // Continue with next repo
    }
  }
};

async function scanRepoForDependencies(repoFullName: string, knownRepos: string[]): Promise<void> {
  const [owner, repo] = repoFullName.split('/');

  // 3. Fetch package.json from GitHub via installation client
  const client = (await getGitHubInstallationClient(
    repoFullName
  )) as unknown as GitHubContentClient;

  let packageJson: Record<string, unknown>;
  try {
    const response = await retryWithBackoff(() =>
      client.request('GET /repos/{owner}/{repo}/contents/{path}', {
        owner,
        repo,
        path: 'package.json',
      })
    );
    const content = response.data.content ?? '';
    const decoded = Buffer.from(content, 'base64').toString('utf-8');
    packageJson = JSON.parse(decoded) as Record<string, unknown>;
  } catch (error) {
    if (isNotFoundError(error)) return; // No package.json — skip silently
    throw error;
  }

  // 4. Parse all declared dependencies
  const allDeps = {
    ...((packageJson.dependencies as Record<string, string> | undefined) ?? {}),
    ...((packageJson.devDependencies as Record<string, string> | undefined) ?? {}),
  };

  const ttl = Math.floor(Date.now() / 1000) + TTL_48H_SECONDS;
  const orgPrefix = repoFullName.split('/')[0];

  // 5. Write edges for dependencies that match known repos in the org
  for (const depName of Object.keys(allDeps)) {
    const upstreamRepo = resolveRepoFromPackageName(depName, orgPrefix, knownRepos);
    if (!upstreamRepo || upstreamRepo === repoFullName) continue;

    await ddb.send(
      new PutCommand({
        TableName: DEPENDENCY_GRAPH_TABLE_NAME,
        Item: {
          repoFullName: upstreamRepo, // upstream dependency (PK)
          dependentRepo: repoFullName, // the repo that depends on it (SK)
          dependencyType: 'npm',
          lastScannedAt: Date.now(),
          ttl,
        },
      })
    );
  }
}

/**
 * Resolve a package name to a known repo full name, or undefined if not a known org repo.
 * Matches:
 *   @org/repo-name  →  org/repo-name
 *   repo-name       →  org/repo-name (if org/repo-name is in knownRepos)
 */
function resolveRepoFromPackageName(
  packageName: string,
  orgPrefix: string,
  knownRepos: string[]
): string | undefined {
  // Scoped package: @org/repo-name
  if (packageName.startsWith('@')) {
    const withoutAt = packageName.slice(1); // "org/repo-name"
    if (knownRepos.includes(withoutAt)) return withoutAt;
    return undefined;
  }

  // Unscoped: check if any known repo's name part matches
  const match = knownRepos.find(
    (r) => r === `${orgPrefix}/${packageName}` || r.split('/')[1] === packageName
  );
  return match;
}

function isNotFoundError(error: unknown): boolean {
  const status = (error as { status?: number })?.status;
  const message = (error as Error)?.message ?? '';
  return status === 404 || message.includes('Not Found') || message.includes('404');
}
