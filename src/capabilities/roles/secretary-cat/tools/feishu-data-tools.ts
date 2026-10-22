import { Tool, ToolDefinition, ToolExecutionContext } from '../../../../runtime/contracts/tool';
import {
  DefaultLarkCliRunner,
  LarkCliRunner,
  SecretaryToolError,
  optionalString,
  requireBooleanConfirmation,
  requireString,
  runLarkCliJson,
  toErrorToolJson,
  toToolJson,
} from '../utils/lark-cli-runner';
import {
  clampInteger,
  parseJsonArrayString,
  parseJsonObjectString,
  pushOptionalString,
  pushRepeatedStringList,
} from '../utils/feishu-tool-args';

export class FeishuSheetsReadTool implements Tool {
  definition: ToolDefinition = {
    name: 'feishu_sheets_read',
    description: 'Read Feishu spreadsheet cell values. Read-only.',
    parameters: {
      type: 'object',
      properties: {
        spreadsheet_token: { type: 'string', description: 'Spreadsheet token. Use either spreadsheet_token or url.' },
        url: { type: 'string', description: 'Spreadsheet URL. Use either url or spreadsheet_token.' },
        range: { type: 'string', description: 'Range such as SheetId!A1:D10 or A1:D10 with sheet_id.' },
        sheet_id: { type: 'string', description: 'Optional sheet id when range omits sheet id.' },
        value_render_option: {
          type: 'string',
          enum: ['ToString', 'FormattedValue', 'Formula', 'UnformattedValue'],
          description: 'Optional render option.',
        },
      },
      required: ['range'],
    },
  };

  constructor(private readonly runner: LarkCliRunner = new DefaultLarkCliRunner()) {}

  async execute(args: any, context: ToolExecutionContext): Promise<string> {
    try {
      const range = requireString(args?.range, 'range');
      const command = ['sheets', '+read', '--as', 'user', '--range', range];
      pushSpreadsheetTarget(command, args);
      pushOptionalString(command, '--sheet-id', args?.sheet_id);
      pushOptionalString(command, '--value-render-option', normalizeValueRenderOption(args?.value_render_option));

      const raw = await runLarkCliJson(this.runner, command, context);
      return toToolJson({
        ok: true,
        range,
        result: raw,
      });
    } catch (error) {
      return toErrorToolJson(error);
    }
  }
}

export class FeishuSheetsAppendConfirmedTool implements Tool {
  definition: ToolDefinition = {
    name: 'feishu_sheets_append_confirmed',
    description: 'Append rows to a Feishu spreadsheet only after explicit user confirmation of target range and values.',
    parameters: {
      type: 'object',
      properties: {
        spreadsheet_token: { type: 'string', description: 'Spreadsheet token. Use either spreadsheet_token or url.' },
        url: { type: 'string', description: 'Spreadsheet URL. Use either url or spreadsheet_token.' },
        range: { type: 'string', description: 'Append range.' },
        sheet_id: { type: 'string', description: 'Optional sheet id when range omits sheet id.' },
        values_json: { type: 'string', description: '2D array JSON, for example [["Name","Status"],["A","Done"]].' },
        confirmed: { type: 'boolean', description: 'Must be true only after explicit user confirmation.' },
      },
      required: ['range', 'values_json', 'confirmed'],
    },
  };

  constructor(private readonly runner: LarkCliRunner = new DefaultLarkCliRunner()) {}

  async execute(args: any, context: ToolExecutionContext): Promise<string> {
    try {
      requireBooleanConfirmation(args?.confirmed, 'Sheets append');
      const range = requireString(args?.range, 'range');
      const values = parseJsonArrayString(args?.values_json, 'values_json');
      const command = ['sheets', '+append', '--as', 'user', '--range', range, '--values', values];

      pushSpreadsheetTarget(command, args);
      pushOptionalString(command, '--sheet-id', args?.sheet_id);

      const raw = await runLarkCliJson(this.runner, command, context);
      return toToolJson({
        ok: true,
        range,
        result: raw,
      });
    } catch (error) {
      return toErrorToolJson(error);
    }
  }
}

export class FeishuBaseTableListTool implements Tool {
  definition: ToolDefinition = {
    name: 'feishu_base_table_list',
    description: 'List tables in a Feishu Base. Read-only.',
    parameters: {
      type: 'object',
      properties: {
        base_token: { type: 'string', description: 'Base app token.' },
        limit: { type: 'number', description: 'Pagination limit. Clamped to 1-200.' },
        offset: { type: 'number', description: 'Pagination offset.' },
      },
      required: ['base_token'],
    },
  };

  constructor(private readonly runner: LarkCliRunner = new DefaultLarkCliRunner()) {}

  async execute(args: any, context: ToolExecutionContext): Promise<string> {
    try {
      const baseToken = requireString(args?.base_token, 'base_token');
      const command = [
        'base',
        '+table-list',
        '--as',
        'user',
        '--base-token',
        baseToken,
        '--limit',
        String(clampInteger(args?.limit, 50, 1, 200)),
      ];

      pushOffset(command, args?.offset);

      const raw = await runLarkCliJson(this.runner, command, context);
      return toToolJson({
        ok: true,
        base_token: baseToken,
        result: raw,
      });
    } catch (error) {
      return toErrorToolJson(error);
    }
  }
}

export class FeishuBaseFieldListTool implements Tool {
  definition: ToolDefinition = {
    name: 'feishu_base_field_list',
    description: 'List fields in a Feishu Base table. Read-only and recommended before record writes.',
    parameters: {
      type: 'object',
      properties: {
        base_token: { type: 'string', description: 'Base app token.' },
        table_id: { type: 'string', description: 'Table id or table name.' },
        limit: { type: 'number', description: 'Pagination limit. Clamped to 1-200.' },
        offset: { type: 'number', description: 'Pagination offset.' },
      },
      required: ['base_token', 'table_id'],
    },
  };

  constructor(private readonly runner: LarkCliRunner = new DefaultLarkCliRunner()) {}

  async execute(args: any, context: ToolExecutionContext): Promise<string> {
    try {
      const baseToken = requireString(args?.base_token, 'base_token');
      const tableId = requireString(args?.table_id, 'table_id');
      const command = [
        'base',
        '+field-list',
        '--as',
        'user',
        '--base-token',
        baseToken,
        '--table-id',
        tableId,
        '--limit',
        String(clampInteger(args?.limit, 100, 1, 200)),
      ];

      pushOffset(command, args?.offset);

      const raw = await runLarkCliJson(this.runner, command, context);
      return toToolJson({
        ok: true,
        base_token: baseToken,
        table_id: tableId,
        result: raw,
      });
    } catch (error) {
      return toErrorToolJson(error);
    }
  }
}

export class FeishuBaseRecordListTool implements Tool {
  definition: ToolDefinition = {
    name: 'feishu_base_record_list',
    description: 'List records in a Feishu Base table. Use field_ids to keep output small.',
    parameters: {
      type: 'object',
      properties: {
        base_token: { type: 'string', description: 'Base app token.' },
        table_id: { type: 'string', description: 'Table id or table name.' },
        field_ids: { type: 'string', description: 'Optional comma-separated field ids or names to project.' },
        view_id: { type: 'string', description: 'Optional view id or name.' },
        limit: { type: 'number', description: 'Pagination limit, clamped to 1-200.' },
        offset: { type: 'number', description: 'Pagination offset.' },
      },
      required: ['base_token', 'table_id'],
    },
  };

  constructor(private readonly runner: LarkCliRunner = new DefaultLarkCliRunner()) {}

  async execute(args: any, context: ToolExecutionContext): Promise<string> {
    try {
      const baseToken = requireString(args?.base_token, 'base_token');
      const tableId = requireString(args?.table_id, 'table_id');
      const command = [
        'base',
        '+record-list',
        '--as',
        'user',
        '--base-token',
        baseToken,
        '--table-id',
        tableId,
        '--limit',
        String(clampInteger(args?.limit, 100, 1, 200)),
        '--format',
        'json',
      ];

      pushOptionalString(command, '--view-id', args?.view_id);
      pushOffset(command, args?.offset);
      pushRepeatedStringList(command, '--field-id', args?.field_ids);

      const raw = await runLarkCliJson(this.runner, command, context);
      return toToolJson({
        ok: true,
        base_token: baseToken,
        table_id: tableId,
        result: raw,
      });
    } catch (error) {
      return toErrorToolJson(error);
    }
  }
}

export class FeishuBaseRecordUpsertConfirmedTool implements Tool {
  definition: ToolDefinition = {
    name: 'feishu_base_record_upsert_confirmed',
    description: 'Create or update a Feishu Base record only after explicit user confirmation of table, target record, and fields.',
    parameters: {
      type: 'object',
      properties: {
        base_token: { type: 'string', description: 'Base app token.' },
        table_id: { type: 'string', description: 'Table id or table name.' },
        record_id: { type: 'string', description: 'Optional record id. Omit to create a new record.' },
        fields_json: { type: 'string', description: 'Record JSON object: Map<FieldNameOrID, CellValue>.' },
        confirmed: { type: 'boolean', description: 'Must be true only after explicit user confirmation.' },
      },
      required: ['base_token', 'table_id', 'fields_json', 'confirmed'],
    },
  };

  constructor(private readonly runner: LarkCliRunner = new DefaultLarkCliRunner()) {}

  async execute(args: any, context: ToolExecutionContext): Promise<string> {
    try {
      requireBooleanConfirmation(args?.confirmed, 'Base record upsert');
      const baseToken = requireString(args?.base_token, 'base_token');
      const tableId = requireString(args?.table_id, 'table_id');
      const fields = parseJsonObjectString(args?.fields_json, 'fields_json');
      const command = [
        'base',
        '+record-upsert',
        '--as',
        'user',
        '--base-token',
        baseToken,
        '--table-id',
        tableId,
        '--json',
        fields,
      ];

      pushOptionalString(command, '--record-id', args?.record_id);

      const raw = await runLarkCliJson(this.runner, command, context);
      return toToolJson({
        ok: true,
        base_token: baseToken,
        table_id: tableId,
        record_id: optionalString(args?.record_id),
        result: raw,
      });
    } catch (error) {
      return toErrorToolJson(error);
    }
  }
}

function pushSpreadsheetTarget(command: string[], args: any): void {
  const spreadsheetToken = optionalString(args?.spreadsheet_token);
  const url = optionalString(args?.url);
  if (spreadsheetToken) {
    command.push('--spreadsheet-token', spreadsheetToken);
    return;
  }
  if (url) {
    command.push('--url', url);
    return;
  }
  throw new SecretaryToolError('VALIDATION_ERROR', 'spreadsheet_token or url is required.');
}

function normalizeValueRenderOption(value: unknown): string | undefined {
  const text = optionalString(value);
  if (text === 'ToString' || text === 'FormattedValue' || text === 'Formula' || text === 'UnformattedValue') {
    return text;
  }
  return undefined;
}

function pushOffset(command: string[], value: unknown): void {
  if (typeof value === 'number' && Number.isFinite(value)) {
    command.push('--offset', String(Math.max(0, Math.floor(value))));
  }
}
