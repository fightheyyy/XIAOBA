import { ChildProcess, spawn } from 'child_process';
import * as path from 'path';
import { Logger } from '../../runtime/observability/logger';

export interface PetDesktopOptions {
  petUrl: string;
  chatUrl: string;
}

export function launchPetDesktop(options: PetDesktopOptions): ChildProcess | null {
  const electronExecutable = resolveElectronExecutable();
  if (!electronExecutable) {
    Logger.warning('[pet] 未找到 Electron，已仅启动 Pet HTTP 服务');
    return null;
  }

  const entry = resolvePetDesktopEntry();
  const child = spawn(electronExecutable, [entry], {
    cwd: process.env.XIAOBA_APP_ROOT || process.cwd(),
    env: {
      ...process.env,
      XIAOBA_PET_URL: options.petUrl,
      XIAOBA_PET_CHAT_URL: options.chatUrl,
    },
    stdio: 'ignore',
    detached: false,
    windowsHide: true,
  });

  child.on('error', err => {
    Logger.warning(`[pet] 桌宠窗口启动失败: ${err.message}`);
  });

  child.on('exit', code => {
    if (code && code !== 0) {
      Logger.warning(`[pet] 桌宠窗口已退出: ${code}`);
    }
  });

  Logger.info('[pet] 桌宠窗口已启动');
  return child;
}

export function resolvePetDesktopEntry(): string {
  const explicit = process.env.XIAOBA_PET_MAIN;
  if (explicit && explicit.trim()) {
    return path.resolve(explicit.trim());
  }

  const appRoot = process.env.XIAOBA_APP_ROOT;
  if (appRoot && appRoot.trim()) {
    return path.resolve(appRoot.trim(), 'desktop', 'electron', 'pet-main.js');
  }

  return path.resolve(process.cwd(), 'desktop', 'electron', 'pet-main.js');
}

function resolveElectronExecutable(): string | null {
  const explicit = process.env.XIAOBA_ELECTRON_EXE;
  if (explicit && explicit.trim()) {
    return explicit.trim();
  }

  try {
    return require('electron') as string;
  } catch {
    return null;
  }
}
