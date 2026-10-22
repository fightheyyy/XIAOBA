import * as fs from 'fs';
import * as path from 'path';
import { Message } from '../contracts';
import { Logger } from '../observability/logger';

const PERSISTENT_SYSTEM_PREFIXES = [
  '[compact_boundary]',
  '[session_memory]',
  '[im_visible_transcript]',
  '[last_turn_anchor]',
];

function sessionsDir(...segments: string[]): string {
  return path.resolve(process.cwd(), 'data', 'sessions', ...segments);
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function keyToFilename(key: string): string {
  return key.replace(/[^a-zA-Z0-9_-]/g, '_') + '.jsonl';
}

function safeSessionType(sessionType?: string): string {
  const raw = (sessionType || 'chat').trim();
  return raw.replace(/[^a-zA-Z0-9_-]/g, '_') || 'chat';
}

function scopedDir(sessionType?: string): string {
  return sessionsDir(safeSessionType(sessionType));
}

function scopedFilePath(key: string, sessionType?: string): string {
  return path.join(scopedDir(sessionType), keyToFilename(key));
}

function legacyFilePath(key: string): string {
  return path.join(sessionsDir(), keyToFilename(key));
}

function readableFilePath(key: string, sessionType?: string): string {
  const scoped = scopedFilePath(key, sessionType);
  if (fs.existsSync(scoped)) {
    return scoped;
  }

  return legacyFilePath(key);
}

function shouldPersistMessage(message: Message): boolean {
  if ((message as any).__injected) {
    return false;
  }

  if (message.role !== 'system') {
    return true;
  }

  const content = message.content;
  if (typeof content !== 'string') {
    return false;
  }

  return PERSISTENT_SYSTEM_PREFIXES.some(prefix => content.startsWith(prefix));
}

export class SessionStore {
  private static instance: SessionStore | null = null;

  static getInstance(): SessionStore {
    if (!SessionStore.instance) SessionStore.instance = new SessionStore();
    return SessionStore.instance;
  }

  /** 保存完整 context（覆盖写入） */
  saveContext(sessionKey: string, messages: Message[], sessionType?: string): void {
    try {
      const dir = scopedDir(sessionType);
      ensureDir(dir);
      const fp = scopedFilePath(sessionKey, sessionType);
      const lines = messages
        .filter(shouldPersistMessage)
        .map(m => JSON.stringify(m));
      fs.writeFileSync(fp, lines.join('\n') + '\n', 'utf-8');
    } catch (err) {
      Logger.error(`保存 context 失败 [${sessionKey}]: ${err}`);
    }
  }

  /** 加载完整 context */
  loadContext(sessionKey: string, sessionType?: string): Message[] {
    try {
      const fp = readableFilePath(sessionKey, sessionType);
      if (!fs.existsSync(fp)) return [];
      const content = fs.readFileSync(fp, 'utf-8').trim();
      if (!content) return [];
      const msgs: Message[] = [];
      for (const line of content.split('\n')) {
        try { msgs.push(JSON.parse(line) as Message); }
        catch { Logger.warning(`跳过损坏的 JSONL 行 [${sessionKey}]: ${line.slice(0, 50)}`); }
      }
      return msgs;
    } catch (err) {
      Logger.error(`加载 context 失败 [${sessionKey}]: ${err}`);
      return [];
    }
  }

  /** 检查是否有会话文件 */
  hasSession(sessionKey: string, sessionType?: string): boolean {
    return fs.existsSync(scopedFilePath(sessionKey, sessionType))
      || fs.existsSync(legacyFilePath(sessionKey));
  }

  /** 返回当前 surface-scoped durable context 文件路径，用于状态边界证据引用。 */
  getContextFilePath(sessionKey: string, sessionType?: string): string {
    return scopedFilePath(sessionKey, sessionType);
  }

  /** 删除会话文件 */
  deleteSession(sessionKey: string, sessionType?: string): void {
    try {
      for (const fp of this.deletionCandidates(sessionKey, sessionType)) {
        if (fs.existsSync(fp)) fs.unlinkSync(fp);
      }
      Logger.info(`会话已删除: ${sessionKey}`);
    } catch (err) {
      Logger.error(`删除会话失败 [${sessionKey}]: ${err}`);
    }
  }

  private deletionCandidates(sessionKey: string, sessionType?: string): string[] {
    const candidates = new Set<string>([
      scopedFilePath(sessionKey, sessionType),
      legacyFilePath(sessionKey),
    ]);

    if (!sessionType) {
      const root = sessionsDir();
      if (fs.existsSync(root)) {
        for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
          if (entry.isDirectory()) {
            candidates.add(path.join(root, entry.name, keyToFilename(sessionKey)));
          }
        }
      }
    }

    return Array.from(candidates);
  }
}
