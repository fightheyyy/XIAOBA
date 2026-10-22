import { rmSync } from 'node:fs';

// TypeScript does not remove outputs for relocated or deleted source files.
rmSync(new URL('../dist/', import.meta.url), { recursive: true, force: true });
