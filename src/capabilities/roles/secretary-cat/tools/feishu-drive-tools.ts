import { ArtifactManifestItem, Tool, ToolDefinition, ToolExecutionContext } from '../../../../runtime/contracts/tool';
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
import { clampInteger, pushOptionalString } from '../utils/feishu-tool-args';
import { secretaryToolOwnedArtifactManifest } from '../utils/feishu-artifact-manifest';

type DriveImportType = 'docx' | 'sheet' | 'bitable' | 'slides';

export class FeishuDriveSearchTool implements Tool {
  definition: ToolDefinition = {
    name: 'feishu_drive_search',
    description: 'Search Feishu Drive cloud files, folders, docs, sheets, and bases. Read-only.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search keyword. May be empty when browsing with filters.' },
        doc_types: { type: 'string', description: 'Optional comma-separated doc types such as docx,sheet,bitable,file,folder,wiki.' },
        page_size: { type: 'number', description: 'Page size, clamped to 1-20.' },
        page_token: { type: 'string', description: 'Optional pagination token.' },
        mine: { type: 'boolean', description: 'Restrict to docs owned by current user.' },
        only_title: { type: 'boolean', description: 'Match titles only.' },
        folder_tokens: { type: 'string', description: 'Optional comma-separated folder tokens.' },
      },
      required: [],
    },
  };

  constructor(private readonly runner: LarkCliRunner = new DefaultLarkCliRunner()) {}

  async execute(args: any, context: ToolExecutionContext): Promise<string> {
    try {
      const command = [
        'drive',
        '+search',
        '--as',
        'user',
        '--page-size',
        String(clampInteger(args?.page_size, 15, 1, 20)),
        '--format',
        'json',
      ];

      pushOptionalString(command, '--query', args?.query);
      pushOptionalString(command, '--doc-types', args?.doc_types);
      pushOptionalString(command, '--page-token', args?.page_token);
      pushOptionalString(command, '--folder-tokens', args?.folder_tokens);
      if (args?.mine === true) {
        command.push('--mine');
      }
      if (args?.only_title === true) {
        command.push('--only-title');
      }

      const raw = await runLarkCliJson(this.runner, command, context);
      return toToolJson({ ok: true, result: raw });
    } catch (error) {
      return toErrorToolJson(error);
    }
  }
}

export class FeishuDriveUploadConfirmedTool implements Tool {
  definition: ToolDefinition = {
    name: 'feishu_drive_upload_confirmed',
    description: 'Upload a local file to Feishu Drive only after explicit user confirmation of local file and target folder/wiki.',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Local file path.' },
        name: { type: 'string', description: 'Optional uploaded file name.' },
        folder_token: { type: 'string', description: 'Optional target folder token.' },
        wiki_token: { type: 'string', description: 'Optional target wiki node token.' },
        file_token: { type: 'string', description: 'Optional existing file token to overwrite in place.' },
        confirmed: { type: 'boolean', description: 'Must be true only after explicit user confirmation.' },
      },
      required: ['file', 'confirmed'],
    },
  };

  constructor(private readonly runner: LarkCliRunner = new DefaultLarkCliRunner()) {}

  async execute(args: any, context: ToolExecutionContext): Promise<string> {
    try {
      requireBooleanConfirmation(args?.confirmed, 'Drive upload');
      const file = requireString(args?.file, 'file');
      const command = ['drive', '+upload', '--as', 'user', '--file', file];

      pushOptionalString(command, '--name', args?.name);
      pushOptionalString(command, '--folder-token', args?.folder_token);
      pushOptionalString(command, '--wiki-token', args?.wiki_token);
      pushOptionalString(command, '--file-token', args?.file_token);

      const raw = await runLarkCliJson(this.runner, command, context);
      return toToolJson({
        ok: true,
        file,
        result: raw,
      });
    } catch (error) {
      return toErrorToolJson(error);
    }
  }

  getArtifactManifest(args: any, result: string, context: ToolExecutionContext): ArtifactManifestItem[] {
    return secretaryToolOwnedArtifactManifest({
      toolName: this.definition.name,
      artifactRole: 'upload_source',
      action: 'captured',
      result,
      context,
      explicitPaths: [args?.file],
      includeResultPaths: false,
    });
  }
}

export class FeishuDriveDownloadTool implements Tool {
  definition: ToolDefinition = {
    name: 'feishu_drive_download',
    description: 'Download a Feishu Drive file to local output. If overwrite is requested, explicit confirmation is required.',
    parameters: {
      type: 'object',
      properties: {
        file_token: { type: 'string', description: 'Drive file token.' },
        output: { type: 'string', description: 'Optional local save path.' },
        overwrite: { type: 'boolean', description: 'Overwrite existing output file. Requires confirmed=true.' },
        confirmed: { type: 'boolean', description: 'Required only when overwrite=true.' },
      },
      required: ['file_token'],
    },
  };

  constructor(private readonly runner: LarkCliRunner = new DefaultLarkCliRunner()) {}

  async execute(args: any, context: ToolExecutionContext): Promise<string> {
    try {
      if (args?.overwrite === true) {
        requireBooleanConfirmation(args?.confirmed, 'Drive download overwrite');
      }

      const fileToken = requireString(args?.file_token, 'file_token');
      const command = ['drive', '+download', '--as', 'user', '--file-token', fileToken];

      pushOptionalString(command, '--output', args?.output);
      if (args?.overwrite === true) {
        command.push('--overwrite');
      }

      const raw = await runLarkCliJson(this.runner, command, context);
      return toToolJson({
        ok: true,
        file_token: fileToken,
        result: raw,
      });
    } catch (error) {
      return toErrorToolJson(error);
    }
  }

  getArtifactManifest(args: any, result: string, context: ToolExecutionContext): ArtifactManifestItem[] {
    return secretaryToolOwnedArtifactManifest({
      toolName: this.definition.name,
      artifactRole: 'downloaded_file',
      action: 'captured',
      result,
      context,
      explicitPaths: [args?.output],
    });
  }
}

export class FeishuDriveImportConfirmedTool implements Tool {
  definition: ToolDefinition = {
    name: 'feishu_drive_import_confirmed',
    description: 'Import a local file into Feishu Drive as a cloud doc, sheet, base, or slides only after explicit user confirmation.',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Local file path, such as .docx, .xlsx, .md, .base, or .pptx.' },
        type: {
          type: 'string',
          enum: ['docx', 'sheet', 'bitable', 'slides'],
          description: 'Target cloud document type.',
        },
        name: { type: 'string', description: 'Optional imported document name.' },
        folder_token: { type: 'string', description: 'Optional target folder token.' },
        target_token: { type: 'string', description: 'Optional existing bitable token for mounting imported data.' },
        confirmed: { type: 'boolean', description: 'Must be true only after explicit user confirmation.' },
      },
      required: ['file', 'type', 'confirmed'],
    },
  };

  constructor(private readonly runner: LarkCliRunner = new DefaultLarkCliRunner()) {}

  async execute(args: any, context: ToolExecutionContext): Promise<string> {
    try {
      requireBooleanConfirmation(args?.confirmed, 'Drive import');
      const file = requireString(args?.file, 'file');
      const type = normalizeImportType(args?.type);
      const command = ['drive', '+import', '--as', 'user', '--file', file, '--type', type];

      pushOptionalString(command, '--name', args?.name);
      pushOptionalString(command, '--folder-token', args?.folder_token);
      pushOptionalString(command, '--target-token', args?.target_token);

      const raw = await runLarkCliJson(this.runner, command, context);
      return toToolJson({
        ok: true,
        file,
        type,
        result: raw,
      });
    } catch (error) {
      return toErrorToolJson(error);
    }
  }

  getArtifactManifest(args: any, result: string, context: ToolExecutionContext): ArtifactManifestItem[] {
    return secretaryToolOwnedArtifactManifest({
      toolName: this.definition.name,
      artifactRole: 'import_source',
      action: 'captured',
      result,
      context,
      explicitPaths: [args?.file],
      includeResultPaths: false,
    });
  }
}

function normalizeImportType(value: unknown): DriveImportType {
  const text = optionalString(value);
  if (text === 'docx' || text === 'sheet' || text === 'bitable' || text === 'slides') {
    return text;
  }
  throw new SecretaryToolError('VALIDATION_ERROR', 'type must be docx, sheet, bitable, or slides.');
}
