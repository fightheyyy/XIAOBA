#!/usr/bin/env node

import { startCli } from './surfaces/cli';
import { Logger } from './runtime/observability/logger';

startCli().catch((error: unknown) => {
  Logger.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
