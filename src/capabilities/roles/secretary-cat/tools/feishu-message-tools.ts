import { Tool, ToolDefinition, ToolExecutionContext } from '../../../../runtime/contracts/tool';
import {
  DefaultLarkCliRunner,
  LarkCliRunner,
  optionalString,
  requireBooleanConfirmation,
  requireString,
  runLarkCliJson,
  toErrorToolJson,
  toToolJson,
} from '../utils/lark-cli-runner';

type DraftTone = 'brief' | 'polite' | 'casual';

export class FeishuContactSearchTool implements Tool {
  definition: ToolDefinition = {
    name: 'feishu_contact_search',
    description: 'Search Feishu contacts with user identity before inviting attendees or drafting messages.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Contact name, email, or keyword.' },
        limit: { type: 'number', description: 'Maximum result count, clamped to 1-30.' },
      },
      required: ['query'],
    },
  };

  constructor(private readonly runner: LarkCliRunner = new DefaultLarkCliRunner()) {}

  async execute(args: any, context: ToolExecutionContext): Promise<string> {
    try {
      const query = requireString(args?.query, 'query');
      const limit = clampLimit(args?.limit);
      const raw = await runLarkCliJson(this.runner, [
        'contact',
        '+search-user',
        '--as',
        'user',
        '--query',
        query,
        '--page-size',
        String(limit),
        '--format',
        'json',
      ], context);

      return toToolJson({
        ok: true,
        query,
        contacts: normalizeContacts(raw).slice(0, limit),
      });
    } catch (error) {
      return toErrorToolJson(error);
    }
  }
}

export class FeishuMessageDraftTool implements Tool {
  definition: ToolDefinition = {
    name: 'feishu_message_draft',
    description: 'Create a Feishu message draft only. This tool never sends the message; ask the user to confirm the final recipient and text.',
    parameters: {
      type: 'object',
      properties: {
        recipient: { type: 'string', description: 'Recipient name or id shown to the user.' },
        intent: { type: 'string', description: 'What the user wants to say.' },
        tone: {
          type: 'string',
          enum: ['brief', 'polite', 'casual'],
          description: 'Draft tone.',
        },
      },
      required: ['recipient', 'intent'],
    },
  };

  async execute(args: any, _context?: ToolExecutionContext): Promise<string> {
    try {
      const recipient = requireString(args?.recipient, 'recipient');
      const intent = requireString(args?.intent, 'intent');
      const tone = normalizeTone(args?.tone);
      const text = renderDraft(intent, tone);
      return toToolJson({
        ok: true,
        recipient,
        tone,
        text,
        confirmation_required: true,
        next_action: 'Show the draft and ask the user to confirm recipient and final text before sending. Use send_text only on channel-delivered surfaces; on CLI, return the draft directly.',
      });
    } catch (error) {
      return toErrorToolJson(error);
    }
  }
}

export class FeishuMessageSendConfirmedTool implements Tool {
  definition: ToolDefinition = {
    name: 'feishu_message_send_confirmed',
    description: 'Send a Feishu message only after explicit user confirmation of the exact recipient and final text.',
    parameters: {
      type: 'object',
      properties: {
        recipient_type: {
          type: 'string',
          enum: ['user_id', 'chat_id'],
          description: 'Whether recipient_id is an open_id/user id or a chat id.',
        },
        recipient_id: { type: 'string', description: 'Feishu open_id/user id or chat id.' },
        text: { type: 'string', description: 'Final confirmed message text.' },
        confirmed: { type: 'boolean', description: 'Must be true only when the immediately preceding user turn confirmed this exact message.' },
      },
      required: ['recipient_type', 'recipient_id', 'text', 'confirmed'],
    },
  };

  constructor(private readonly runner: LarkCliRunner = new DefaultLarkCliRunner()) {}

  async execute(args: any, context: ToolExecutionContext): Promise<string> {
    try {
      requireBooleanConfirmation(args?.confirmed, 'Message send');
      const recipientType = requireString(args?.recipient_type, 'recipient_type');
      if (recipientType !== 'user_id' && recipientType !== 'chat_id') {
        return toToolJson({
          ok: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'recipient_type must be user_id or chat_id.',
          },
        });
      }
      const recipientId = requireString(args?.recipient_id, 'recipient_id');
      const text = requireString(args?.text, 'text');
      const command = [
        'im',
        '+messages-send',
        '--as',
        'user',
        recipientType === 'chat_id' ? '--chat-id' : '--user-id',
        recipientId,
        '--text',
        text,
      ];

      const raw = await runLarkCliJson(this.runner, command, context);
      return toToolJson({
        ok: true,
        recipient_type: recipientType,
        recipient_id: recipientId,
        result: raw,
      });
    } catch (error) {
      return toErrorToolJson(error);
    }
  }
}

function clampLimit(value: unknown): number {
  const parsed = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : 10;
  return Math.max(1, Math.min(30, parsed));
}

function normalizeContacts(raw: unknown): Array<Record<string, unknown>> {
  const value = raw as any;
  const users = [value?.users, value?.data?.users, value?.items, value?.data?.items].find(Array.isArray) || [];
  return users.map((user: unknown) => normalizeContact(user));
}

function normalizeContact(raw: unknown): Record<string, unknown> {
  const user = (raw && typeof raw === 'object') ? raw as Record<string, any> : {};
  return {
    open_id: readString(user.open_id) || readString(user.openId) || readString(user.user_id) || readString(user.userId),
    name: readString(user.name) || readString(user.display_name) || readString(user.displayName),
    email: readString(user.email) || readString(user.enterprise_email) || readString(user.enterpriseEmail),
    department: readString(user.department) || readString(user.department_name) || readString(user.departmentName),
    matched_query: readString(user.matched_query) || readString(user.matchedQuery),
  };
}

function normalizeTone(value: unknown): DraftTone {
  return value === 'polite' || value === 'casual' || value === 'brief' ? value : 'brief';
}

function renderDraft(intent: string, tone: DraftTone): string {
  const normalized = intent.trim();
  if (tone === 'polite') {
    return `Hello, ${normalized}`;
  }
  if (tone === 'casual') {
    return normalized.endsWith('。') || normalized.endsWith('!') || normalized.endsWith('?')
      ? normalized
      : `${normalized}。`;
  }
  return normalized;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
