import express from 'express';
import type { Server } from 'http';
import * as path from 'path';
import { Logger } from '../../runtime/observability/logger';
import { createApiRouter } from './routes/api';
import { ServiceManager } from './service-manager';
import { shutdownObservability } from '../../runtime/observability';
import { PathResolver } from '../../runtime/paths';

const DEFAULT_PORT = 3800;
const DEFAULT_HOST = '127.0.0.1';

export interface DashboardServerOptions {
  onNavigate?: (page: string) => void;
}

export async function startDashboard(
  port: number = DEFAULT_PORT,
  host?: string,
  options: DashboardServerOptions = {},
): Promise<Server> {
  const app = express();
  const projectRoot = process.cwd();
  const bodyLimit = process.env.XIAOBA_API_BODY_LIMIT || '50mb';
  const listenHost = host || process.env.XIAOBA_DASHBOARD_HOST || DEFAULT_HOST;
  const advertisedHost = listenHost === '0.0.0.0' ? '127.0.0.1' : listenHost;
  process.env.XIAOBA_DASHBOARD_URL = `http://${advertisedHost}:${port}`;
  const serviceManager = new ServiceManager(projectRoot);

  app.use(express.json({ limit: bodyLimit }));

  // API routes
  const apiRouter = createApiRouter(serviceManager, { onNavigate: options.onNavigate });
  app.use('/api', apiRouter);

  // Serve frontend
  const frontendPath = path.join(PathResolver.getApplicationRoot(), 'desktop/dashboard');
  app.use(express.static(frontendPath));

  // SPA fallback
  app.use((_req, res) => {
    res.sendFile(path.join(frontendPath, 'index.html'));
  });

  // 优雅退出
  let server: Server | null = null;
  const shutdown = async () => {
    serviceManager.stopAll();
    await (apiRouter as any).closeChat?.();
    if (!server) {
      await shutdownObservability();
      process.exit(0);
      return;
    }
    server.close(() => {
      void shutdownObservability().finally(() => process.exit(0));
    });
  };
  const onSigint = () => { void shutdown(); };
  const onSigterm = () => { void shutdown(); };
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);

  server = app.listen(port, listenHost);
  server.once('close', () => {
    void (apiRouter as any).closeChat?.();
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
  });
  await new Promise<void>((resolve, reject) => {
    server!.once('listening', resolve);
    server!.once('error', reject);
  });

  Logger.success(`\nXiaoBa Dashboard 已启动`);
  Logger.info(`访问地址: ${process.env.XIAOBA_DASHBOARD_URL}`);
  if (listenHost !== advertisedHost) {
    Logger.info(`监听地址: http://${listenHost}:${port}`);
  }
  Logger.info('');

  return server;
}
