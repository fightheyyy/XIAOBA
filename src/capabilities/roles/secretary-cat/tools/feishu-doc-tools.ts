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
  parseOptionalJsonObjectString,
  pushOptionalString,
} from '../utils/feishu-tool-args';

type DocFormat = 'xml' | 'markdown';
type DocFetchScope = 'full' | 'outline' | 'range' | 'keyword' | 'section';
type DocFetchDetail = 'simple' | 'with-ids' | 'full';
type DocUpdateCommand =
  | 'str_replace'
  | 'block_delete'
  | 'block_insert_after'
  | 'block_copy_insert_after'
  | 'block_replace'
  | 'block_move_after'
  | 'overwrite'
  | 'append';

export class FeishuDocsSearchTool implements Tool {
  definition: ToolDefinition = {
    name: 'feishu_docs_search',
    description: 'Search Feishu docs, wiki, sheets, and related cloud documents. Read-only.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search keyword.' },
        filter_json: { type: 'string', description: 'Optional JSON object filter.' },
        page_size: { type: 'number', description: 'Page size, clamped to 1-20.' },
        page_token: { type: 'string', description: 'Optional pagination token.' },
      },
      required: [],
    },
  };

  constructor(private readonly runner: LarkCliRunner = new DefaultLarkCliRunner()) {}

  async execute(args: any, context: ToolExecutionContext): Promise<string> {
    try {
      const command = [
        'docs',
        '+search',
        '--as',
        'user',
        '--page-size',
        String(clampInteger(args?.page_size, 15, 1, 20)),
        '--format',
        'json',
      ];

      pushOptionalString(command, '--query', args?.query);
      pushOptionalString(command, '--page-token', args?.page_token);

      const filterJson = parseOptionalJsonObjectString(args?.filter_json, 'filter_json');
      if (filterJson) {
        command.push('--filter', filterJson);
      }

      const raw = await runLarkCliJson(this.runner, command, context);
      return toToolJson({ ok: true, result: raw });
    } catch (error) {
      return toErrorToolJson(error);
    }
  }
}

export class FeishuDocsFetchTool implements Tool {
  definition: ToolDefinition = {
    name: 'feishu_docs_fetch',
    description: 'Fetch Feishu document content with docs v2. Use partial scopes to keep output small when possible.',
    parameters: {
      type: 'object',
      properties: {
        doc: { type: 'string', description: 'Document URL or token.' },
        scope: {
          type: 'string',
          enum: ['full', 'outline', 'range', 'keyword', 'section'],
          description: 'Fetch scope. Defaults to full.',
        },
        detail: {
          type: 'string',
          enum: ['simple', 'with-ids', 'full'],
          description: 'Detail level. Defaults to simple.',
        },
        doc_format: {
          type: 'string',
          enum: ['xml', 'markdown'],
          description: 'Content format. Defaults to xml.',
        },
        keyword: { type: 'string', description: 'Keyword for keyword scope.' },
        start_block_id: { type: 'string', description: 'Start block id for range or section scope.' },
        end_block_id: { type: 'string', description: 'End block id for range scope. Use -1 for end of document.' },
        context_before: { type: 'number', description: 'Sibling blocks before match.' },
        context_after: { type: 'number', description: 'Sibling blocks after match.' },
      },
      required: ['doc'],
    },
  };

  constructor(private readonly runner: LarkCliRunner = new DefaultLarkCliRunner()) {}

  async execute(args: any, context: ToolExecutionContext): Promise<string> {
    try {
      const doc = requireString(args?.doc, 'doc');
      const command = [
        'docs',
        '+fetch',
        '--api-version',
        'v2',
        '--as',
        'user',
        '--doc',
        doc,
        '--scope',
        normalizeFetchScope(args?.scope),
        '--detail',
        normalizeFetchDetail(args?.detail),
        '--doc-format',
        normalizeDocFormat(args?.doc_format),
        '--format',
        'json',
      ];

      pushOptionalString(command, '--keyword', args?.keyword);
      pushOptionalString(command, '--start-block-id', args?.start_block_id);
      pushOptionalString(command, '--end-block-id', args?.end_block_id);
      if (typeof args?.context_before === 'number' && Number.isFinite(args.context_before)) {
        command.push('--context-before', String(Math.max(0, Math.floor(args.context_before))));
      }
      if (typeof args?.context_after === 'number' && Number.isFinite(args.context_after)) {
        command.push('--context-after', String(Math.max(0, Math.floor(args.context_after))));
      }

      const raw = await runLarkCliJson(this.runner, command, context);
      return toToolJson({
        ok: true,
        doc,
        result: raw,
      });
    } catch (error) {
      return toErrorToolJson(error);
    }
  }
}

export class FeishuDocsCreateConfirmedTool implements Tool {
  definition: ToolDefinition = {
    name: 'feishu_docs_create_confirmed',
    description: 'Create a Feishu document using docs v2 only after explicit user confirmation of title/content and parent location.',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Document content, XML by default or Markdown when doc_format=markdown.' },
        doc_format: {
          type: 'string',
          enum: ['xml', 'markdown'],
          description: 'Content format. Defaults to xml.',
        },
        parent_token: { type: 'string', description: 'Optional parent folder or wiki node token.' },
        parent_position: { type: 'string', description: 'Optional parent position such as my_library.' },
        confirmed: { type: 'boolean', description: 'Must be true only after explicit user confirmation.' },
      },
      required: ['content', 'confirmed'],
    },
  };

  constructor(private readonly runner: LarkCliRunner = new DefaultLarkCliRunner()) {}

  async execute(args: any, context: ToolExecutionContext): Promise<string> {
    try {
      requireBooleanConfirmation(args?.confirmed, 'Docs create');
      const content = requireString(args?.content, 'content');
      const command = [
        'docs',
        '+create',
        '--api-version',
        'v2',
        '--as',
        'user',
        '--content',
        content,
        '--doc-format',
        normalizeDocFormat(args?.doc_format),
      ];

      pushOptionalString(command, '--parent-token', args?.parent_token);
      pushOptionalString(command, '--parent-position', args?.parent_position);

      const raw = await runLarkCliJson(this.runner, command, context);
      return toToolJson({ ok: true, result: raw });
    } catch (error) {
      return toErrorToolJson(error);
    }
  }
}

export class FeishuDocsUpdateConfirmedTool implements Tool {
  definition: ToolDefinition = {
    name: 'feishu_docs_update_confirmed',
    description: 'Update a Feishu document using docs v2 only after explicit user confirmation of target document and edit command.',
    parameters: {
      type: 'object',
      properties: {
        doc: { type: 'string', description: 'Document URL or token.' },
        command: {
          type: 'string',
          enum: ['str_replace', 'block_delete', 'block_insert_after', 'block_copy_insert_after', 'block_replace', 'block_move_after', 'overwrite', 'append'],
          description: 'Docs update operation.',
        },
        content: { type: 'string', description: 'New content for write operations.' },
        doc_format: {
          type: 'string',
          enum: ['xml', 'markdown'],
          description: 'Content format. Defaults to xml.',
        },
        block_id: { type: 'string', description: 'Target block id for block operations.' },
        pattern: { type: 'string', description: 'Regex pattern for str_replace.' },
        src_block_ids: { type: 'string', description: 'Comma-separated source block ids for copy/move operations.' },
        confirmed: { type: 'boolean', description: 'Must be true only after explicit user confirmation.' },
      },
      required: ['doc', 'command', 'confirmed'],
    },
  };

  constructor(private readonly runner: LarkCliRunner = new DefaultLarkCliRunner()) {}

  async execute(args: any, context: ToolExecutionContext): Promise<string> {
    try {
      requireBooleanConfirmation(args?.confirmed, 'Docs update');
      const doc = requireString(args?.doc, 'doc');
      const updateCommand = normalizeUpdateCommand(args?.command);
      const command = [
        'docs',
        '+update',
        '--api-version',
        'v2',
        '--as',
        'user',
        '--doc',
        doc,
        '--command',
        updateCommand,
        '--doc-format',
        normalizeDocFormat(args?.doc_format),
      ];

      pushOptionalString(command, '--content', args?.content);
      pushOptionalString(command, '--block-id', args?.block_id);
      pushOptionalString(command, '--pattern', args?.pattern);
      pushOptionalString(command, '--src-block-ids', args?.src_block_ids);

      const raw = await runLarkCliJson(this.runner, command, context);
      return toToolJson({
        ok: true,
        doc,
        command: updateCommand,
        result: raw,
      });
    } catch (error) {
      return toErrorToolJson(error);
    }
  }
}

function normalizeDocFormat(value: unknown): DocFormat {
  return value === 'markdown' ? 'markdown' : 'xml';
}

function normalizeFetchScope(value: unknown): DocFetchScope {
  if (value === 'outline' || value === 'range' || value === 'keyword' || value === 'section' || value === 'full') {
    return value;
  }
  return 'full';
}

function normalizeFetchDetail(value: unknown): DocFetchDetail {
  if (value === 'with-ids' || value === 'full' || value === 'simple') {
    return value;
  }
  return 'simple';
}

function normalizeUpdateCommand(value: unknown): DocUpdateCommand {
  const text = optionalString(value);
  if (
    text === 'str_replace'
    || text === 'block_delete'
    || text === 'block_insert_after'
    || text === 'block_copy_insert_after'
    || text === 'block_replace'
    || text === 'block_move_after'
    || text === 'overwrite'
    || text === 'append'
  ) {
    return text;
  }
  throw new SecretaryToolError('VALIDATION_ERROR', 'command must be a supported docs update command.');
}
