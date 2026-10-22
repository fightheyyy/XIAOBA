import { ArtifactManifestItem, Tool, ToolDefinition, ToolExecutionContext } from '../../../../runtime/contracts/tool';
import { ResearchBoardStore, ResearchBoardUpdateInput } from '../utils/research-board-store';

export class ResearchBoardUpdateTool implements Tool {
  definition: ToolDefinition = {
    name: 'research_board_update',
    description: [
      'ResearcherCat tool: create or update a durable Research Board for a research project.',
      'Use it before claiming progress on experiments, manuscripts, figures, PDFs, PPTs, papers, reviews, or submissions.',
      'The tool writes board JSON, human-readable Markdown, and an event log; it does not fabricate delivered artifacts.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        project: {
          type: 'string',
          description: 'Stable project name, for example ttt-revision or rice-ept-paper.',
        },
        task_type: {
          type: 'string',
          description: 'Current workflow task type, for example state_recovery, paper_reading, experiment_run, manuscript_sync, pdf_delivery, review_triage.',
        },
        goal: {
          type: 'string',
          description: 'Current research project goal or task goal.',
        },
        current_storyline: {
          type: 'string',
          description: 'Current manuscript/research storyline. Use only when evidence supports it; otherwise leave explicit uncertainty in claim_board.',
        },
        claim_board: {
          type: 'array',
          description: 'Claims with status and evidence. Each item can be a string or object with claim, status, evidence.',
          items: {
            type: 'object',
            properties: {
              claim: { type: 'string' },
              status: {
                type: 'string',
                enum: ['unknown', 'unsupported', 'weakly_supported', 'supported', 'contradicted', 'blocked'],
              },
              evidence: { type: 'array', items: { type: 'string' } },
            },
          },
        },
        evidence_board: {
          type: 'array',
          description: 'Evidence entries or evidence gaps. Items can be strings or objects with text, status, evidence.',
          items: { type: 'string' },
        },
        experiment_queue: {
          type: 'array',
          description: 'Planned/running/completed/failed/blocked experiment tasks. Items can be strings or objects with text/status/evidence.',
          items: { type: 'string' },
        },
        artifact_board: {
          type: 'array',
          description: 'Artifact ledger entries. Items can be relative paths or objects with path/type/status/evidence/note. Absolute or parent-relative paths are stored as blocked boundary hashes.',
          items: { type: 'string' },
        },
        risk_board: {
          type: 'array',
          description: 'Research, delivery, evidence, runtime, confidentiality, or schedule risks. Items can be strings or objects.',
          items: { type: 'string' },
        },
        handoff: {
          type: 'string',
          description: 'Single handoff reason. Prefer handoffs for multiple structured handoffs.',
        },
        handoffs: {
          type: 'array',
          description: 'Structured handoffs to inspector-cat, engineer-cat, or reviewer-cat.',
          items: {
            type: 'object',
            properties: {
              target_role: { type: 'string' },
              reason: { type: 'string' },
              status: {
                type: 'string',
                enum: ['planned', 'running', 'completed', 'failed', 'blocked', 'unknown'],
              },
              evidence: { type: 'array', items: { type: 'string' } },
            },
          },
        },
        next_actions: {
          type: 'array',
          description: 'Next concrete actions, ideally one to three. Items can be strings or objects with text/status/evidence.',
          items: { type: 'string' },
        },
        run_registry: {
          type: 'array',
          description: 'Experiment runs with method, split, seed, config, command, status, log_path, output_path, manuscript_target, evidence.',
          items: {
            type: 'object',
            properties: {
              run_id: { type: 'string' },
              method: { type: 'string' },
              split: { type: 'string' },
              seed: { type: 'string' },
              config: { type: 'string' },
              command: { type: 'string' },
              status: {
                type: 'string',
                enum: ['planned', 'running', 'completed', 'failed', 'blocked', 'unknown'],
              },
              log_path: { type: 'string' },
              output_path: { type: 'string' },
              manuscript_target: { type: 'string' },
              evidence: { type: 'array', items: { type: 'string' } },
            },
          },
        },
        mode: {
          type: 'string',
          enum: ['merge', 'replace_sections'],
          description: 'merge keeps previous board entries by id; replace_sections replaces only sections included in this call.',
          default: 'merge',
        },
      },
      required: ['project'],
    },
  };

  async execute(args: ResearchBoardUpdateInput, context: ToolExecutionContext): Promise<string> {
    const store = new ResearchBoardStore(context.workingDirectory);
    const result = store.update(args);
    return `${JSON.stringify(result, null, 2)}\n`;
  }

  getArtifactManifest(_args: ResearchBoardUpdateInput, result: string, context: ToolExecutionContext): ArtifactManifestItem[] {
    const parsed = parseJsonResult(result);
    return [
      artifactFromPath(parsed.board_json_path, 'updated', context.workingDirectory),
      artifactFromPath(parsed.board_markdown_path, 'updated', context.workingDirectory),
      artifactFromPath(parsed.events_jsonl_path, 'updated', context.workingDirectory),
    ].filter((item): item is ArtifactManifestItem => Boolean(item));
  }
}

export class ResearchBoardReadTool implements Tool {
  definition: ToolDefinition = {
    name: 'research_board_read',
    description: [
      'ResearcherCat tool: read a durable Research Board or list existing boards.',
      'Use it before answering progress questions, resuming after compression, or deciding whether evidence supports a manuscript claim.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        project: {
          type: 'string',
          description: 'Project name to read. Omit with list_only=true to list known boards.',
        },
        list_only: {
          type: 'boolean',
          description: 'List known boards instead of reading a single board.',
        },
        include_events: {
          type: 'boolean',
          description: 'Include recent update events in the response.',
        },
        max_events: {
          type: 'number',
          description: 'Maximum recent events to include when include_events=true. Defaults to 20.',
        },
        include_markdown: {
          type: 'boolean',
          description: 'Include rendered Markdown in the response. Defaults to true.',
        },
      },
    },
  };

  async execute(args: any, context: ToolExecutionContext): Promise<string> {
    const store = new ResearchBoardStore(context.workingDirectory);
    if (args?.list_only === true || !args?.project) {
      return `${JSON.stringify(store.list(), null, 2)}\n`;
    }
    const result = store.read(String(args.project), {
      includeEvents: args?.include_events === true,
      maxEvents: typeof args?.max_events === 'number' ? args.max_events : undefined,
    });
    if (args?.include_markdown === false) {
      const { markdown: _markdown, ...withoutMarkdown } = result;
      return `${JSON.stringify(withoutMarkdown, null, 2)}\n`;
    }
    return `${JSON.stringify(result, null, 2)}\n`;
  }
}

function parseJsonResult(result: unknown): Record<string, unknown> {
  if (typeof result !== 'string') return {};
  try {
    const parsed = JSON.parse(result);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function artifactFromPath(
  pathValue: unknown,
  action: ArtifactManifestItem['action'],
  workingDirectory: string,
): ArtifactManifestItem | undefined {
  if (typeof pathValue !== 'string' || !pathValue.trim()) {
    return undefined;
  }
  const normalized = workspaceRelativePath(pathValue, workingDirectory);
  return {
    path: normalized,
    type: artifactType(normalized),
    action,
  };
}

function workspaceRelativePath(pathValue: string, workingDirectory: string): string {
  const normalized = pathValue.trim().replace(/\\/g, '/');
  const cwd = workingDirectory.replace(/\\/g, '/').replace(/\/+$/, '');
  if (normalized.startsWith(`${cwd}/`)) {
    return normalized.slice(cwd.length + 1);
  }
  return normalized.replace(/^\/+/, '');
}

function artifactType(pathValue: string): string {
  const match = pathValue.match(/\.([A-Za-z0-9]+)(?:$|[?#])/);
  return match ? match[1].toLowerCase() : 'file';
}
