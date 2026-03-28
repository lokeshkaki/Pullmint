#!/usr/bin/env node
'use strict';

import { runWizard } from './wizard';

runWizard().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);

  if (message.toLowerCase().includes('force closed')) {
    console.log('\nSetup cancelled.');
    process.exit(0);
  }

  console.error('\nUnexpected error:', message);
  process.exit(1);
});
