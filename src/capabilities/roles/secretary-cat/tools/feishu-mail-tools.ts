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
import {
  clampInteger,
  parseOptionalJsonObjectString,
  pushOptionalString,
} from '../utils/feishu-tool-args';

export class FeishuMailTriageTool implements Tool {
  definition: ToolDefinition = {
    name: 'feishu_mail_triage',
    description: 'List Feishu mail summaries for inbox triage or search. This is read-only and does not send mail.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Optional full-text keyword, max 50 chars in lark-cli.' },
        mailbox: { type: 'string', description: 'Mailbox address. Defaults to me.' },
        filter_json: { type: 'string', description: 'Optional JSON object filter, for example {"folder":"INBOX"}.' },
        max: { type: 'number', description: 'Maximum messages to fetch. Clamped to 1-400.' },
        labels: { type: 'boolean', description: 'Include label ids.' },
      },
      required: [],
    },
  };

  constructor(private readonly runner: LarkCliRunner = new DefaultLarkCliRunner()) {}

  async execute(args: any, context: ToolExecutionContext): Promise<string> {
    try {
      const mailbox = optionalString(args?.mailbox) || 'me';
      const command = [
        'mail',
        '+triage',
        '--as',
        'user',
        '--mailbox',
        mailbox,
        '--max',
        String(clampInteger(args?.max, 20, 1, 400)),
        '--format',
        'json',
      ];

      pushOptionalString(command, '--query', args?.query);

      const filterJson = parseOptionalJsonObjectString(args?.filter_json, 'filter_json');
      if (filterJson) {
        command.push('--filter', filterJson);
      }

      if (args?.labels === true) {
        command.push('--labels');
      }

      const raw = await runLarkCliJson(this.runner, command, context);
      return toToolJson({
        ok: true,
        mailbox,
        result: raw,
      });
    } catch (error) {
      return toErrorToolJson(error);
    }
  }
}

export class FeishuMailReadTool implements Tool {
  definition: ToolDefinition = {
    name: 'feishu_mail_read',
    description: 'Read one Feishu email by message id. Use only after identifying the message from triage/search.',
    parameters: {
      type: 'object',
      properties: {
        message_id: { type: 'string', description: 'Email message id.' },
        mailbox: { type: 'string', description: 'Mailbox address. Defaults to me.' },
        html: { type: 'boolean', description: 'Whether to include HTML body. Defaults to false in this wrapper to reduce payload.' },
      },
      required: ['message_id'],
    },
  };

  constructor(private readonly runner: LarkCliRunner = new DefaultLarkCliRunner()) {}

  async execute(args: any, context: ToolExecutionContext): Promise<string> {
    try {
      const messageId = requireString(args?.message_id, 'message_id');
      const mailbox = optionalString(args?.mailbox) || 'me';
      const command = [
        'mail',
        '+message',
        '--as',
        'user',
        '--mailbox',
        mailbox,
        '--message-id',
        messageId,
        '--format',
        'json',
      ];

      if (args?.html === true) {
        command.push('--html');
      } else {
        command.push('--html=false');
      }

      const raw = await runLarkCliJson(this.runner, command, context);
      return toToolJson({
        ok: true,
        mailbox,
        message_id: messageId,
        result: raw,
      });
    } catch (error) {
      return toErrorToolJson(error);
    }
  }
}

export class FeishuMailDraftCreateTool implements Tool {
  definition: ToolDefinition = {
    name: 'feishu_mail_draft_create',
    description: 'Create a Feishu mail draft. This never sends mail; ask the user to review and confirm before sending a draft.',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Comma-separated To recipient list.' },
        cc: { type: 'string', description: 'Optional comma-separated Cc recipient list.' },
        bcc: { type: 'string', description: 'Optional comma-separated Bcc recipient list.' },
        subject: { type: 'string', description: 'Draft subject.' },
        body: { type: 'string', description: 'Draft body. Plain text by default.' },
        mailbox: { type: 'string', description: 'Mailbox address. Defaults to me.' },
        from: { type: 'string', description: 'Optional sender address.' },
        priority: { type: 'string', enum: ['high', 'normal', 'low'], description: 'Optional email priority.' },
        plain_text: { type: 'boolean', description: 'Force plain-text body. Defaults to true.' },
      },
      required: ['to', 'subject', 'body'],
    },
  };

  constructor(private readonly runner: LarkCliRunner = new DefaultLarkCliRunner()) {}

  async execute(args: any, context: ToolExecutionContext): Promise<string> {
    try {
      const to = requireString(args?.to, 'to');
      const subject = requireString(args?.subject, 'subject');
      const body = requireString(args?.body, 'body');
      const mailbox = optionalString(args?.mailbox) || 'me';
      const command = [
        'mail',
        '+draft-create',
        '--as',
        'user',
        '--mailbox',
        mailbox,
        '--to',
        to,
        '--subject',
        subject,
        '--body',
        body,
      ];

      if (args?.plain_text !== false) {
        command.push('--plain-text');
      }

      pushOptionalString(command, '--cc', args?.cc);
      pushOptionalString(command, '--bcc', args?.bcc);
      pushOptionalString(command, '--from', args?.from);
      pushOptionalString(command, '--priority', normalizePriority(args?.priority));

      const raw = await runLarkCliJson(this.runner, command, context);
      return toToolJson({
        ok: true,
        mailbox,
        result: raw,
        confirmation_required: true,
        next_action: 'Show the draft id, recipients, subject, and body to the user. Send only with feishu_mail_draft_send_confirmed after explicit confirmation.',
      });
    } catch (error) {
      return toErrorToolJson(error);
    }
  }
}

export class FeishuMailDraftSendConfirmedTool implements Tool {
  definition: ToolDefinition = {
    name: 'feishu_mail_draft_send_confirmed',
    description: 'Send an existing Feishu mail draft only after explicit user confirmation of draft id and recipients.',
    parameters: {
      type: 'object',
      properties: {
        draft_id: { type: 'string', description: 'Draft id, comma-separated or one draft id.' },
        mailbox: { type: 'string', description: 'Mailbox address that owns the draft. Defaults to me.' },
        stop_on_error: { type: 'boolean', description: 'Stop at first recoverable per-draft failure.' },
        confirmed: { type: 'boolean', description: 'Must be true only after explicit user confirmation.' },
      },
      required: ['draft_id', 'confirmed'],
    },
  };

  constructor(private readonly runner: LarkCliRunner = new DefaultLarkCliRunner()) {}

  async execute(args: any, context: ToolExecutionContext): Promise<string> {
    try {
      requireBooleanConfirmation(args?.confirmed, 'Mail draft send');
      const draftId = requireString(args?.draft_id, 'draft_id');
      const mailbox = optionalString(args?.mailbox) || 'me';
      const command = [
        'mail',
        '+draft-send',
        '--as',
        'user',
        '--mailbox',
        mailbox,
        '--draft-id',
        draftId,
        '--format',
        'json',
        '--yes',
      ];

      if (args?.stop_on_error === true) {
        command.push('--stop-on-error');
      }

      const raw = await runLarkCliJson(this.runner, command, context);
      return toToolJson({
        ok: true,
        mailbox,
        draft_id: draftId,
        result: raw,
      });
    } catch (error) {
      return toErrorToolJson(error);
    }
  }
}

function normalizePriority(value: unknown): string | undefined {
  const text = optionalString(value);
  return text === 'high' || text === 'normal' || text === 'low' ? text : undefined;
}
