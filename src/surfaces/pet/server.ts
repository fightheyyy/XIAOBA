import express from 'express';
import * as path from 'path';
import { Logger } from '../../runtime/observability/logger';
import { startCommandSupport, stopCommandSupport } from '../cli/command-support';
import { createPetRouter } from './channel';
import { shutdownObservability } from '../../runtime/observability';
import { PathResolver } from '../../runtime/paths';

const DEFAULT_PORT = 3900;
const DEFAULT_HOST = '127.0.0.1';

export async function startPetServer(port: number = DEFAULT_PORT, host?: string): Promise<void> {
  const app = express();
  const listenHost = host || process.env.XIAOBA_PET_HOST || DEFAULT_HOST;
  const bodyLimit = process.env.XIAOBA_API_BODY_LIMIT || '50mb';
  const frontendPath = path.join(PathResolver.getApplicationRoot(), 'desktop/dashboard');

  await startCommandSupport();

  app.use(express.json({ limit: bodyLimit }));
  app.use('/api', createPetRouter());
  app.get('/', (_req, res) => {
    res.sendFile(path.join(frontendPath, 'pet.html'));
  });
  app.use(express.static(frontendPath));

  app.use((_req, res) => {
    res.sendFile(path.join(frontendPath, 'pet.html'));
  });

  const shutdown = async () => {
    await stopCommandSupport();
    await shutdownObservability();
    process.exit(0);
  };
  process.on('SIGINT', () => { void shutdown(); });
  process.on('SIGTERM', () => { void shutdown(); });

  app.listen(port, listenHost, () => {
    Logger.success(`\nXiaoBa Pet 已启动`);
    Logger.info(`监听地址: http://${listenHost}:${port}\n`);
  });
}
