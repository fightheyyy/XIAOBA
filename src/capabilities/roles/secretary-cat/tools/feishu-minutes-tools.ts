import { ArtifactManifestItem, Tool, ToolDefinition, ToolExecutionContext } from '../../../../runtime/contracts/tool';
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
import { clampInteger, pushOptionalString } from '../utils/feishu-tool-args';
import { secretaryToolOwnedArtifactManifest } from '../utils/feishu-artifact-manifest';

type UserIdType = 'user_id' | 'union_id' | 'open_id';

export class FeishuMinutesSearchTool implements Tool {
  definition: ToolDefinition = {
    name: 'feishu_minutes_search',
    description: 'Search Feishu Minutes by keyword, owner, participant, or time range. Read-only.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Optional search keyword.' },
        owner_ids: { type: 'string', description: 'Optional comma-separated owner open_ids. Use me for current user.' },
        participant_ids: { type: 'string', description: 'Optional comma-separated participant open_ids. Use me for current user.' },
        start: { type: 'string', description: 'Optional lower time bound, ISO 8601 or YYYY-MM-DD.' },
        end: { type: 'string', description: 'Optional upper time bound, ISO 8601 or YYYY-MM-DD.' },
        page_size: { type: 'number', description: 'Page size, clamped to 1-30.' },
        page_token: { type: 'string', description: 'Optional pagination token.' },
      },
      required: [],
    },
  };

  constructor(private readonly runner: LarkCliRunner = new DefaultLarkCliRunner()) {}

  async execute(args: any, context: ToolExecutionContext): Promise<string> {
    try {
      const command = [
        'minutes',
        '+search',
        '--as',
        'user',
        '--page-size',
        String(clampInteger(args?.page_size, 15, 1, 30)),
        '--format',
        'json',
      ];

      pushOptionalString(command, '--query', args?.query);
      pushOptionalString(command, '--owner-ids', args?.owner_ids);
      pushOptionalString(command, '--participant-ids', args?.participant_ids);
      pushOptionalString(command, '--start', args?.start);
      pushOptionalString(command, '--end', args?.end);
      pushOptionalString(command, '--page-token', args?.page_token);

      const raw = await runLarkCliJson(this.runner, command, context);
      return toToolJson({ ok: true, result: raw });
    } catch (error) {
      return toErrorToolJson(error);
    }
  }
}

export class FeishuMinutesGetTool implements Tool {
  definition: ToolDefinition = {
    name: 'feishu_minutes_get',
    description: 'Get Feishu Minutes metadata by minute token. Read-only.',
    parameters: {
      type: 'object',
      properties: {
        minute_token: { type: 'string', description: 'Minute token from a Feishu Minutes URL.' },
        user_id_type: {
          type: 'string',
          enum: ['user_id', 'union_id', 'open_id'],
          description: 'Optional owner id type returned by the API.',
        },
      },
      required: ['minute_token'],
    },
  };

  constructor(private readonly runner: LarkCliRunner = new DefaultLarkCliRunner()) {}

  async execute(args: any, context: ToolExecutionContext): Promise<string> {
    try {
      const minuteToken = requireString(args?.minute_token, 'minute_token');
      const params: Record<string, string> = { minute_token: minuteToken };
      const userIdType = normalizeUserIdType(args?.user_id_type);
      if (userIdType) {
        params.user_id_type = userIdType;
      }

      const raw = await runLarkCliJson(this.runner, [
        'minutes',
        'minutes',
        'get',
        '--as',
        'user',
        '--params',
        JSON.stringify(params),
        '--format',
        'json',
      ], context);

      return toToolJson({
        ok: true,
        minute_token: minuteToken,
        result: raw,
      });
    } catch (error) {
      return toErrorToolJson(error);
    }
  }
}

export class FeishuMinutesNotesTool implements Tool {
  definition: ToolDefinition = {
    name: 'feishu_minutes_notes',
    description: 'Get meeting notes artifacts such as transcript, summary, action items, or chapters by minute token. Read-only.',
    parameters: {
      type: 'object',
      properties: {
        minute_tokens: { type: 'string', description: 'Comma-separated minute tokens.' },
        output_dir: { type: 'string', description: 'Optional output directory for artifact files.' },
      },
      required: ['minute_tokens'],
    },
  };

  constructor(private readonly runner: LarkCliRunner = new DefaultLarkCliRunner()) {}

  async execute(args: any, context: ToolExecutionContext): Promise<string> {
    try {
      const minuteTokens = requireString(args?.minute_tokens, 'minute_tokens');
      const command = [
        'vc',
        '+notes',
        '--as',
        'user',
        '--minute-tokens',
        minuteTokens,
        '--format',
        'json',
      ];

      pushOptionalString(command, '--output-dir', args?.output_dir);

      const raw = await runLarkCliJson(this.runner, command, context);
      return toToolJson({
        ok: true,
        minute_tokens: minuteTokens,
        result: raw,
      });
    } catch (error) {
      return toErrorToolJson(error);
    }
  }

  getArtifactManifest(_args: any, result: string, context: ToolExecutionContext): ArtifactManifestItem[] {
    return secretaryToolOwnedArtifactManifest({
      toolName: this.definition.name,
      artifactRole: 'minutes_notes',
      action: 'captured',
      result,
      context,
    });
  }
}

export class FeishuMinutesDownloadTool implements Tool {
  definition: ToolDefinition = {
    name: 'feishu_minutes_download',
    description: 'Get Feishu Minutes media download URLs by default. Actual local download requires explicit confirmation.',
    parameters: {
      type: 'object',
      properties: {
        minute_tokens: { type: 'string', description: 'Comma-separated minute tokens, max 50.' },
        url_only: { type: 'boolean', description: 'Only return download URLs. Defaults to true.' },
        output: { type: 'string', description: 'Output path for a single token when url_only=false.' },
        output_dir: { type: 'string', description: 'Output directory when url_only=false.' },
        overwrite: { type: 'boolean', description: 'Overwrite existing output file when url_only=false.' },
        confirmed: { type: 'boolean', description: 'Required when url_only=false or overwrite=true.' },
      },
      required: ['minute_tokens'],
    },
  };

  constructor(private readonly runner: LarkCliRunner = new DefaultLarkCliRunner()) {}

  async execute(args: any, context: ToolExecutionContext): Promise<string> {
    try {
      const minuteTokens = requireString(args?.minute_tokens, 'minute_tokens');
      const urlOnly = args?.url_only !== false;
      if (!urlOnly || args?.overwrite === true) {
        requireBooleanConfirmation(args?.confirmed, 'Minutes media download');
      }

      const command = [
        'minutes',
        '+download',
        '--as',
        'user',
        '--minute-tokens',
        minuteTokens,
        '--format',
        'json',
      ];

      if (urlOnly) {
        command.push('--url-only');
      }
      pushOptionalString(command, '--output', args?.output);
      pushOptionalString(command, '--output-dir', args?.output_dir);
      if (args?.overwrite === true) {
        command.push('--overwrite');
      }

      const raw = await runLarkCliJson(this.runner, command, context);
      return toToolJson({
        ok: true,
        minute_tokens: minuteTokens,
        url_only: urlOnly,
        result: raw,
      });
    } catch (error) {
      return toErrorToolJson(error);
    }
  }

  getArtifactManifest(args: any, result: string, context: ToolExecutionContext): ArtifactManifestItem[] {
    if (args?.url_only !== false) {
      return [];
    }
    return secretaryToolOwnedArtifactManifest({
      toolName: this.definition.name,
      artifactRole: 'minutes_media',
      action: 'captured',
      result,
      context,
      explicitPaths: [args?.output],
    });
  }
}

function normalizeUserIdType(value: unknown): UserIdType | undefined {
  const text = optionalString(value);
  if (text === 'user_id' || text === 'union_id' || text === 'open_id') {
    return text;
  }
  return undefined;
}
