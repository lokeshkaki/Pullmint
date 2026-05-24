#!/usr/bin/env node
import { runStdioServer } from './server';

runStdioServer().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unable to start Pullmint MCP server';
  process.stderr.write(`Pullmint MCP startup failed: ${message}\n`);
  process.exitCode = 1;
});
