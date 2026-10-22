import { startPetServer } from '../../pet/server';
import { launchPetDesktop } from '../../pet/desktop-launcher';

export async function petCommand(options: { port?: string; host?: string; desktop?: boolean }): Promise<void> {
  const port = options.port ? parseInt(options.port, 10) : parseInt(process.env.XIAOBA_PET_PORT || '3900', 10);
  const host = options.host || process.env.XIAOBA_PET_HOST || '127.0.0.1';

  await startPetServer(port, options.host);

  if (options.desktop !== false && process.env.XIAOBA_PET_DESKTOP !== 'false') {
    const petUrl = `http://${host}:${port}`;
    const dashboardPetUrl = process.env.XIAOBA_DASHBOARD_URL
      ? `${process.env.XIAOBA_DASHBOARD_URL}/?page=pet`
      : '';
    launchPetDesktop({
      petUrl,
      chatUrl: process.env.XIAOBA_PET_CHAT_URL || dashboardPetUrl || petUrl,
    });
  }
}
