import { build } from 'esbuild';

// Package the official AppBridge and the shared A2UI validator locally; no CDN runtime.
await build({
  entryPoints: [new URL('../desktop/dashboard/chat/index.js', import.meta.url).pathname],
  outfile: new URL('../desktop/dashboard/chat-runtime.js', import.meta.url).pathname,
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: ['chrome120'],
  minify: true,
  legalComments: 'eof',
});
