import * as crypto from 'crypto';
import { ToolExecutionContext } from '../../../runtime/contracts/tool';

const VALID_REF_PATTERN = /^@?e\d+$/;
const RISKY_ACTION_PATTERN = /(?:\b(?:delete|remove|erase|clear|send|submit|publish|post|pay|purchase|buy|order|book|reserve|authorize|approve|grant|transfer|install|unsubscribe|close account|sign out|continue|confirm|save|accept|checkout|yes|ok)\b|删除|移除|清空|发送|提交|发布|支付|付款|购买|下单|预订|预约|授权|批准|转账|安装|退订|注销|继续|确认|保存|接受|结账|确定)/i;
const PASSWORD_FIELD_PATTERN = /(?:\b(?:password|passcode|passphrase|pin|one[- ]?time password|otp|verification code|security code)\b|密码|口令|验证码|动态码|安全码)/i;

export interface BrowserSessionState {
  sessionId: string;
  headed: boolean;
  lastSnapshot?: string;
  refs: Map<string, string>;
  lastOrigin?: string;
  screenshotCounter: number;
}

export class BrowserSessionStore {
  private readonly sessions = new Map<string, BrowserSessionState>();

  get(context: ToolExecutionContext): BrowserSessionState {
    const sessionId = deriveBrowserSessionId(context);
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = {
        sessionId,
        headed: false,
        refs: new Map(),
        screenshotCounter: 0,
      };
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  updateSnapshot(
    session: BrowserSessionState,
    snapshot: string,
    origin?: string,
    driverRefs?: Map<string, string>,
  ): void {
    session.lastSnapshot = snapshot;
    session.refs = driverRefs && driverRefs.size > 0 ? new Map(driverRefs) : parseSnapshotRefs(snapshot);
    if (origin) session.lastOrigin = origin;
  }

  invalidateSnapshot(session: BrowserSessionState): void {
    session.lastSnapshot = undefined;
    session.refs.clear();
  }

  close(session: BrowserSessionState): void {
    this.sessions.delete(session.sessionId);
  }
}

export function deriveBrowserSessionId(context: ToolExecutionContext): string {
  const extended = context as ToolExecutionContext & { parentSessionId?: string };
  const identity = [
    extended.parentSessionId || 'direct',
    context.sessionId || 'local',
    context.workingDirectory,
    context.roleName || 'browser-cat',
  ].join('\0');
  const digest = crypto.createHash('sha256').update(identity).digest('hex').slice(0, 20);
  return `xb-browser-${digest}`;
}

export function normalizeBrowserRef(value: unknown): string {
  const rawRef = typeof value === 'string' ? value.trim() : '';
  if (!VALID_REF_PATTERN.test(rawRef)) {
    throw new BrowserInputError('BROWSER_INVALID_REF', 'Browser element refs must use the eN or @eN form from a recent snapshot.');
  }
  return rawRef.startsWith('@') ? rawRef : `@${rawRef}`;
}

export function requireSnapshotRef(
  session: BrowserSessionState,
  value: unknown,
): { ref: string; metadata: string } {
  const ref = normalizeBrowserRef(value);
  if (!session.lastSnapshot) {
    throw new BrowserInputError(
      'BROWSER_SNAPSHOT_REQUIRED',
      'Take a fresh browser_snapshot before interacting with an element.',
    );
  }
  const metadata = session.refs.get(ref);
  if (!metadata) {
    throw new BrowserInputError(
      'BROWSER_STALE_OR_UNKNOWN_REF',
      `${ref} is not present in the latest snapshot. Take a fresh browser_snapshot.`,
    );
  }
  return { ref, metadata };
}

export function isRiskyBrowserTarget(metadata: string): boolean {
  return RISKY_ACTION_PATTERN.test(metadata) || isUnnamedButton(metadata);
}

export function isPasswordBrowserTarget(metadata: string): boolean {
  return PASSWORD_FIELD_PATTERN.test(metadata);
}

export class BrowserInputError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'BrowserInputError';
  }
}

function parseSnapshotRefs(snapshot: string): Map<string, string> {
  const refs = new Map<string, string>();
  for (const line of snapshot.split(/\r?\n/)) {
    const matches = Array.from(line.matchAll(/@(?<at>e\d+)|\[ref=(?<bracket>e\d+)\]/g));
    for (const match of matches) {
      const raw = match.groups?.at || match.groups?.bracket;
      if (raw) refs.set(`@${raw}`, line.trim());
    }
  }
  return refs;
}

function isUnnamedButton(metadata: string): boolean {
  if (!/(?:^|[\s-])button\b/i.test(metadata)) return false;
  const quotedName = metadata.match(/\bbutton\s+"([^"]*)"/i)?.[1];
  return quotedName === undefined || quotedName.trim().length === 0;
}
