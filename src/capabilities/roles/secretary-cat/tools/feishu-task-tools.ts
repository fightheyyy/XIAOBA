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
import { clampInteger, pushOptionalString } from '../utils/feishu-tool-args';

type TaskStatusFilter = 'all' | 'complete' | 'incomplete';
type TaskStateAction = 'complete' | 'reopen';

export class FeishuTaskListTool implements Tool {
  definition: ToolDefinition = {
    name: 'feishu_task_list',
    description: 'List Feishu tasks assigned to the current user. Use this for daily brief and personal task review.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Optional task title keyword.' },
        status: {
          type: 'string',
          enum: ['all', 'complete', 'incomplete'],
          description: 'Task completion filter. Defaults to all.',
        },
        due_start: { type: 'string', description: 'Optional due-date lower bound accepted by lark-cli, such as 2026-06-02 or +2d.' },
        due_end: { type: 'string', description: 'Optional due-date upper bound accepted by lark-cli, such as 2026-06-09 or +7d.' },
        page_all: { type: 'boolean', description: 'Whether to auto-paginate, capped by page_limit.' },
        page_limit: { type: 'number', description: 'Maximum pages when page_all is true. Clamped to 1-40.' },
      },
      required: [],
    },
  };

  constructor(private readonly runner: LarkCliRunner = new DefaultLarkCliRunner()) {}

  async execute(args: any, context: ToolExecutionContext): Promise<string> {
    try {
      const status = normalizeTaskStatus(args?.status);
      const command = ['task', '+get-my-tasks', '--as', 'user', '--format', 'json'];

      if (status === 'complete') {
        command.push('--complete');
      } else if (status === 'incomplete') {
        command.push('--complete=false');
      }

      pushOptionalString(command, '--query', args?.query);
      pushOptionalString(command, '--due-start', args?.due_start);
      pushOptionalString(command, '--due-end', args?.due_end);

      if (args?.page_all === true) {
        command.push('--page-all', '--page-limit', String(clampInteger(args?.page_limit, 20, 1, 40)));
      }

      const raw = await runLarkCliJson(this.runner, command, context);
      return toToolJson({
        ok: true,
        status,
        result: raw,
      });
    } catch (error) {
      return toErrorToolJson(error);
    }
  }
}

export class FeishuTaskCreateConfirmedTool implements Tool {
  definition: ToolDefinition = {
    name: 'feishu_task_create_confirmed',
    description: 'Create a Feishu task only after the user confirms the task title, owner/assignee, and due date if provided.',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Task title.' },
        description: { type: 'string', description: 'Optional task description.' },
        due: { type: 'string', description: 'Optional due date accepted by lark-cli, such as 2026-06-02, +2d, or ISO datetime.' },
        assignee: { type: 'string', description: 'Optional assignee open_id.' },
        follower: { type: 'string', description: 'Optional follower open_id.' },
        tasklist_id: { type: 'string', description: 'Optional task list id or applink URL.' },
        idempotency_key: { type: 'string', description: 'Optional idempotency key.' },
        confirmed: { type: 'boolean', description: 'Must be true only after explicit user confirmation.' },
      },
      required: ['summary', 'confirmed'],
    },
  };

  constructor(private readonly runner: LarkCliRunner = new DefaultLarkCliRunner()) {}

  async execute(args: any, context: ToolExecutionContext): Promise<string> {
    try {
      requireBooleanConfirmation(args?.confirmed, 'Task create');
      const summary = requireString(args?.summary, 'summary');
      const command = ['task', '+create', '--as', 'user', '--summary', summary, '--format', 'json'];

      pushOptionalString(command, '--description', args?.description);
      pushOptionalString(command, '--due', args?.due);
      pushOptionalString(command, '--assignee', args?.assignee);
      pushOptionalString(command, '--follower', args?.follower);
      pushOptionalString(command, '--tasklist-id', args?.tasklist_id);
      pushOptionalString(command, '--idempotency-key', args?.idempotency_key);

      const raw = await runLarkCliJson(this.runner, command, context);
      return toToolJson({
        ok: true,
        result: raw,
      });
    } catch (error) {
      return toErrorToolJson(error);
    }
  }
}

export class FeishuTaskUpdateConfirmedTool implements Tool {
  definition: ToolDefinition = {
    name: 'feishu_task_update_confirmed',
    description: 'Update Feishu task attributes only after explicit user confirmation of the target task and changes.',
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task id, comma-separated for multiple tasks when supported by lark-cli.' },
        summary: { type: 'string', description: 'Optional new title.' },
        description: { type: 'string', description: 'Optional new description.' },
        due: { type: 'string', description: 'Optional new due date accepted by lark-cli.' },
        confirmed: { type: 'boolean', description: 'Must be true only after explicit user confirmation.' },
      },
      required: ['task_id', 'confirmed'],
    },
  };

  constructor(private readonly runner: LarkCliRunner = new DefaultLarkCliRunner()) {}

  async execute(args: any, context: ToolExecutionContext): Promise<string> {
    try {
      requireBooleanConfirmation(args?.confirmed, 'Task update');
      const taskId = requireString(args?.task_id, 'task_id');
      const command = ['task', '+update', '--as', 'user', '--task-id', taskId, '--format', 'json'];

      pushOptionalString(command, '--summary', args?.summary);
      pushOptionalString(command, '--description', args?.description);
      pushOptionalString(command, '--due', args?.due);

      const raw = await runLarkCliJson(this.runner, command, context);
      return toToolJson({
        ok: true,
        task_id: taskId,
        result: raw,
      });
    } catch (error) {
      return toErrorToolJson(error);
    }
  }
}

export class FeishuTaskStateConfirmedTool implements Tool {
  definition: ToolDefinition = {
    name: 'feishu_task_state_confirmed',
    description: 'Mark a Feishu task complete or reopen it only after explicit user confirmation.',
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task id.' },
        action: {
          type: 'string',
          enum: ['complete', 'reopen'],
          description: 'Task state transition.',
        },
        confirmed: { type: 'boolean', description: 'Must be true only after explicit user confirmation.' },
      },
      required: ['task_id', 'action', 'confirmed'],
    },
  };

  constructor(private readonly runner: LarkCliRunner = new DefaultLarkCliRunner()) {}

  async execute(args: any, context: ToolExecutionContext): Promise<string> {
    try {
      requireBooleanConfirmation(args?.confirmed, 'Task state change');
      const taskId = requireString(args?.task_id, 'task_id');
      const action = normalizeTaskStateAction(args?.action);
      const raw = await runLarkCliJson(this.runner, [
        'task',
        action === 'reopen' ? '+reopen' : '+complete',
        '--as',
        'user',
        '--task-id',
        taskId,
        '--format',
        'json',
      ], context);

      return toToolJson({
        ok: true,
        task_id: taskId,
        action,
        result: raw,
      });
    } catch (error) {
      return toErrorToolJson(error);
    }
  }
}

function normalizeTaskStatus(value: unknown): TaskStatusFilter {
  if (value === 'complete' || value === 'incomplete' || value === 'all') {
    return value;
  }
  return 'all';
}

function normalizeTaskStateAction(value: unknown): TaskStateAction {
  const text = optionalString(value);
  if (text === 'complete' || text === 'reopen') {
    return text;
  }
  throw new SecretaryToolError('VALIDATION_ERROR', 'action must be complete or reopen.');
}
