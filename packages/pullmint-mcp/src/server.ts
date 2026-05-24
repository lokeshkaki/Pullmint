import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { PullmintClient } from './client';
import { loadConfig } from './config';
import { asTextContent, runTool, toolDefinitions } from './tools';

type RegisterCompatibleTool = (
  name: string,
  config: { description: string; inputSchema: Record<string, unknown> },
  handler: (input: unknown) => Promise<ReturnType<typeof asTextContent>>
) => unknown;

export function createServer(client = new PullmintClient(loadConfig())): McpServer {
  const server = new McpServer({ name: 'pullmint', version: '0.1.0' });
  // npm resolves the SDK and this workspace package through separate Zod type identities.
  const registerTool = server.registerTool.bind(server) as unknown as RegisterCompatibleTool;

  for (const tool of toolDefinitions) {
    registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.schema.shape },
      async (input: unknown) => asTextContent(await runTool(client, tool.name, input))
    );
  }

  return server;
}

export async function runStdioServer(): Promise<void> {
  const server = createServer();
  await server.connect(new StdioServerTransport());
}
