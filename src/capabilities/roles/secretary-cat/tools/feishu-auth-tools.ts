import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Tool, ToolDefinition, ToolExecutionContext } from '../../../../runtime/contracts/tool';
import {
  DefaultLarkCliRunner,
  LarkCliRunner,
  optionalString,
  runLarkCliJson,
  toErrorToolJson,
  toToolJson,
} from '../utils/lark-cli-runner';

export class FeishuAuthStatusTool implements Tool {
  definition: ToolDefinition = {
    name: 'feishu_auth_status',
    description: 'Check the local lark-cli Feishu auth state for user and bot identities.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  };

  constructor(private readonly runner: LarkCliRunner = new DefaultLarkCliRunner()) {}

  async execute(_args: any, context: ToolExecutionContext): Promise<string> {
    try {
      const raw = await runLarkCliJson(this.runner, ['auth', 'status'], context);
      return toToolJson({
        ok: true,
        ...normalizeFeishuAuthStatus(raw),
      });
    } catch (error) {
      return toErrorToolJson(error);
    }
  }
}

export class FeishuAuthLoginStartTool implements Tool {
  definition: ToolDefinition = {
    name: 'feishu_auth_login_start',
    description: 'Start Feishu user authorization through lark-cli device flow and return the verification URL/code. Use send_text only on channel-delivered surfaces; on CLI, return the URL/code directly.',
    parameters: {
      type: 'object',
      properties: {
        domain: {
          type: 'string',
          description: 'Comma-separated Feishu domains such as calendar,contact,im,task,docs,drive.',
        },
        recommend: {
          type: 'boolean',
          description: 'Request recommended scopes when true.',
        },
      },
      required: ['domain'],
    },
  };

  constructor(private readonly runner: LarkCliRunner = new DefaultLarkCliRunner()) {}

  async execute(args: any, context: ToolExecutionContext): Promise<string> {
    try {
      const domain = optionalString(args?.domain);
      if (!domain) {
        return toToolJson({
          ok: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'domain is required.',
          },
        });
      }

      const command = ['auth', 'login', '--no-wait', '--json', '--domain', domain];
      if (args?.recommend === true) {
        command.push('--recommend');
      }

      const raw = await runLarkCliJson(this.runner, command, context, { timeoutMs: 20_000 });
      const normalized = normalizeLoginStart(raw);
      const pending = savePendingAuthRequest(context, {
        deviceCode: normalized.device_code,
        domain,
        expiresIn: normalized.expires_in,
        interval: normalized.interval,
      });
      return toToolJson({
        ok: true,
        ...withoutDeviceCode(normalized),
        ...(pending ? {
          auth_request_id: pending.authRequestId,
          next_action: 'After the user completes browser authorization, call feishu_auth_login_complete with this auth_request_id.',
        } : {}),
      });
    } catch (error) {
      return toErrorToolJson(error);
    }
  }
}

export class FeishuAuthLoginCompleteTool implements Tool {
  definition: ToolDefinition = {
    name: 'feishu_auth_login_complete',
    description: 'Complete a pending Feishu user authorization started by feishu_auth_login_start after the user finishes browser approval.',
    parameters: {
      type: 'object',
      properties: {
        auth_request_id: {
          type: 'string',
          description: 'Pending authorization request id returned by feishu_auth_login_start. If omitted, the latest non-expired pending request is used.',
        },
      },
      required: [],
    },
  };

  constructor(private readonly runner: LarkCliRunner = new DefaultLarkCliRunner()) {}

  async execute(args: any, context: ToolExecutionContext): Promise<string> {
    try {
      const authRequestId = optionalString(args?.auth_request_id);
      const pending = readPendingAuthRequest(context, authRequestId);
      if (!pending) {
        return toToolJson({
          ok: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: authRequestId
              ? `No pending Feishu auth request found for ${authRequestId}.`
              : 'No pending Feishu auth request found.',
            next_action: 'Call feishu_auth_login_start to create a new authorization request.',
          },
        });
      }
      if (pending.expiresAt && Date.now() > pending.expiresAt) {
        removePendingAuthRequest(context, pending.authRequestId);
        return toToolJson({
          ok: false,
          error: {
            code: 'AUTH_MISSING',
            message: 'Pending Feishu auth request expired.',
            next_action: 'Call feishu_auth_login_start again and ask the user to approve the new browser authorization.',
          },
        });
      }

      const raw = await runLarkCliJson(this.runner, [
        'auth',
        'login',
        '--device-code',
        pending.deviceCode,
        '--json',
      ], context, { timeoutMs: 60_000 });
      removePendingAuthRequest(context, pending.authRequestId);
      return toToolJson({
        ok: true,
        auth_request_id: pending.authRequestId,
        domain: pending.domain,
        result: raw,
      });
    } catch (error) {
      return toErrorToolJson(error);
    }
  }
}

export function normalizeFeishuAuthStatus(raw: unknown): Record<string, unknown> {
  const status = (raw && typeof raw === 'object') ? raw as Record<string, any> : {};
  const identities = status.identities || {};
  const user = identities.user || {};
  const bot = identities.bot || {};
  return {
    identity: readString(status.identity),
    default_as: readString(status.defaultAs),
    user_identity: readString(user.status) || (user.available ? 'ready' : 'missing'),
    bot_identity: readString(bot.status) || (bot.available ? 'ready' : 'missing'),
    scopes: splitScopes(user.scope),
    expires_at: readString(user.expiresAt),
    user_name: readString(user.userName),
  };
}

function normalizeLoginStart(raw: unknown): Record<string, unknown> {
  const value = (raw && typeof raw === 'object') ? raw as Record<string, any> : {};
  return {
    verification_uri: readString(value.verification_uri) || readString(value.verificationUri) || readString(value.url),
    verification_uri_complete: readString(value.verification_uri_complete) || readString(value.verificationUriComplete),
    user_code: readString(value.user_code) || readString(value.userCode),
    device_code: readString(value.device_code) || readString(value.deviceCode),
    expires_in: typeof value.expires_in === 'number' ? value.expires_in : value.expiresIn,
    interval: typeof value.interval === 'number' ? value.interval : undefined,
  };
}

interface PendingAuthRecord {
  authRequestId: string;
  deviceCode: string;
  domain?: string;
  createdAt: number;
  expiresAt?: number;
  interval?: number;
}

interface PendingAuthStore {
  requests: PendingAuthRecord[];
}

const DEFAULT_PENDING_AUTH_EXPIRES_IN_SECONDS = 600;

function withoutDeviceCode(value: Record<string, unknown>): Record<string, unknown> {
  const { device_code: _deviceCode, ...rest } = value;
  return rest;
}

function savePendingAuthRequest(
  context: ToolExecutionContext,
  input: { deviceCode?: unknown; domain?: string; expiresIn?: unknown; interval?: unknown },
): { authRequestId: string } | undefined {
  const deviceCode = readString(input.deviceCode);
  if (!deviceCode) {
    return undefined;
  }
  const authRequestId = crypto.randomUUID();
  const createdAt = Date.now();
  const expiresIn = typeof input.expiresIn === 'number' && Number.isFinite(input.expiresIn)
    ? input.expiresIn
    : DEFAULT_PENDING_AUTH_EXPIRES_IN_SECONDS;
  const record: PendingAuthRecord = {
    authRequestId,
    deviceCode,
    domain: input.domain,
    createdAt,
    expiresAt: expiresIn ? createdAt + Math.max(1, expiresIn) * 1000 : undefined,
    interval: typeof input.interval === 'number' ? input.interval : undefined,
  };
  const store = loadPendingAuthStore(context);
  store.requests = [
    ...store.requests.filter(item => item.expiresAt === undefined || item.expiresAt > createdAt),
    record,
  ];
  writePendingAuthStore(context, store);
  return { authRequestId };
}

function readPendingAuthRequest(context: ToolExecutionContext, authRequestId?: string): PendingAuthRecord | undefined {
  const store = loadPendingAuthStore(context);
  if (authRequestId) {
    return store.requests.find(item => item.authRequestId === authRequestId);
  }
  const active = store.requests
    .filter(item => item.expiresAt === undefined || item.expiresAt > Date.now())
    .sort((a, b) => b.createdAt - a.createdAt);
  return active[0];
}

function removePendingAuthRequest(context: ToolExecutionContext, authRequestId: string): void {
  const store = loadPendingAuthStore(context);
  const next = store.requests.filter(item => item.authRequestId !== authRequestId);
  writePendingAuthStore(context, { requests: next });
}

function loadPendingAuthStore(context: ToolExecutionContext): PendingAuthStore {
  const filePath = pendingAuthStorePath(context);
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const requests = Array.isArray(parsed?.requests) ? parsed.requests : [];
    return {
      requests: requests
        .map((item: any): PendingAuthRecord | undefined => {
          const authRequestId = readString(item?.authRequestId);
          const deviceCode = readString(item?.deviceCode);
          if (!authRequestId || !deviceCode) {
            return undefined;
          }
          return {
            authRequestId,
            deviceCode,
            domain: readString(item?.domain),
            createdAt: typeof item?.createdAt === 'number' ? item.createdAt : 0,
            expiresAt: typeof item?.expiresAt === 'number' ? item.expiresAt : undefined,
            interval: typeof item?.interval === 'number' ? item.interval : undefined,
          };
        })
        .filter((item: PendingAuthRecord | undefined): item is PendingAuthRecord => Boolean(item)),
    };
  } catch {
    return { requests: [] };
  }
}

function writePendingAuthStore(context: ToolExecutionContext, store: PendingAuthStore): void {
  const filePath = pendingAuthStorePath(context);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(store, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Best-effort on filesystems that do not support chmod.
  }
}

function pendingAuthStorePath(context: ToolExecutionContext): string {
  return path.join(context.workingDirectory || process.cwd(), 'data', 'secretary-cat', 'auth', 'pending-device-auth.json');
}

function splitScopes(scope: unknown): string[] {
  if (Array.isArray(scope)) {
    return scope.filter((item): item is string => typeof item === 'string' && Boolean(item.trim()));
  }
  if (typeof scope !== 'string') {
    return [];
  }
  return scope.split(/[,\s]+/).map(item => item.trim()).filter(Boolean);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
