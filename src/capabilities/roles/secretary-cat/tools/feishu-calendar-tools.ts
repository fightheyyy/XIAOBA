import { Tool, ToolDefinition, ToolExecutionContext } from '../../../../runtime/contracts/tool';
import {
  DefaultLarkCliRunner,
  LarkCliRunner,
  optionalString,
  requireBooleanConfirmation,
  requireIsoDateTime,
  requireString,
  runLarkCliJson,
  toErrorToolJson,
  toToolJson,
} from '../utils/lark-cli-runner';

const DEFAULT_CALENDAR_ID = 'primary';

export class FeishuCalendarAgendaTool implements Tool {
  definition: ToolDefinition = {
    name: 'feishu_calendar_agenda',
    description: 'Query the current Feishu user calendar for a specific time range. Use this for real agenda state; never invent events.',
    parameters: {
      type: 'object',
      properties: {
        start: {
          type: 'string',
          description: 'ISO 8601 start datetime with timezone, for example 2026-06-02T09:30:00+08:00.',
        },
        end: {
          type: 'string',
          description: 'ISO 8601 end datetime with timezone, for example 2026-06-02T10:30:00+08:00.',
        },
        calendar_id: {
          type: 'string',
          description: 'Calendar id. Defaults to primary.',
        },
      },
      required: ['start', 'end'],
    },
  };

  constructor(private readonly runner: LarkCliRunner = new DefaultLarkCliRunner()) {}

  async execute(args: any, context: ToolExecutionContext): Promise<string> {
    try {
      const start = requireIsoDateTime(args?.start, 'start');
      const end = requireIsoDateTime(args?.end, 'end');
      const calendarId = optionalString(args?.calendar_id) || DEFAULT_CALENDAR_ID;
      const raw = await runLarkCliJson(this.runner, [
        'calendar',
        '+agenda',
        '--as',
        'user',
        '--calendar-id',
        calendarId,
        '--start',
        start,
        '--end',
        end,
        '--format',
        'json',
      ], context);

      return toToolJson({
        ok: true,
        calendar_id: calendarId,
        events: normalizeEvents(raw, calendarId),
      });
    } catch (error) {
      return toErrorToolJson(error);
    }
  }
}

export class FeishuCalendarCreateTool implements Tool {
  definition: ToolDefinition = {
    name: 'feishu_calendar_create',
    description: 'Create a Feishu calendar event for the current user. Only use when the user explicitly asks to create, schedule, or add an event.',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Event title.' },
        start: { type: 'string', description: 'ISO 8601 start datetime with timezone.' },
        end: { type: 'string', description: 'ISO 8601 end datetime with timezone.' },
        description: { type: 'string', description: 'Optional event description.' },
        attendee_ids: { type: 'string', description: 'Optional comma-separated Feishu attendee ids.' },
        calendar_id: { type: 'string', description: 'Calendar id. Defaults to primary.' },
      },
      required: ['summary', 'start', 'end'],
    },
  };

  constructor(private readonly runner: LarkCliRunner = new DefaultLarkCliRunner()) {}

  async execute(args: any, context: ToolExecutionContext): Promise<string> {
    try {
      const summary = requireString(args?.summary, 'summary');
      const start = requireIsoDateTime(args?.start, 'start');
      const end = requireIsoDateTime(args?.end, 'end');
      const calendarId = optionalString(args?.calendar_id) || DEFAULT_CALENDAR_ID;
      const command = [
        'calendar',
        '+create',
        '--as',
        'user',
        '--calendar-id',
        calendarId,
        '--summary',
        summary,
        '--start',
        start,
        '--end',
        end,
        '--format',
        'json',
      ];

      const description = optionalString(args?.description);
      if (description) command.push('--description', description);

      const attendeeIds = optionalString(args?.attendee_ids);
      if (attendeeIds) command.push('--attendee-ids', attendeeIds);

      const raw = await runLarkCliJson(this.runner, command, context);
      return toToolJson({
        ok: true,
        event: normalizeSingleEvent(raw, calendarId),
      });
    } catch (error) {
      return toErrorToolJson(error);
    }
  }
}

export class FeishuCalendarUpdateTool implements Tool {
  definition: ToolDefinition = {
    name: 'feishu_calendar_update',
    description: 'Update an existing Feishu calendar event. Must only be called after the user explicitly confirms a before/after summary.',
    parameters: {
      type: 'object',
      properties: {
        event_id: { type: 'string', description: 'Event id to update.' },
        calendar_id: { type: 'string', description: 'Calendar id. Defaults to primary.' },
        summary: { type: 'string', description: 'Optional new title.' },
        start: { type: 'string', description: 'Optional new ISO 8601 start datetime; requires end.' },
        end: { type: 'string', description: 'Optional new ISO 8601 end datetime; requires start.' },
        description: { type: 'string', description: 'Optional new event description.' },
        add_attendee_ids: { type: 'string', description: 'Optional comma-separated attendee ids to add.' },
        remove_attendee_ids: { type: 'string', description: 'Optional comma-separated attendee ids to remove.' },
        notify: { type: 'boolean', description: 'Whether to notify attendees.' },
        confirmed: { type: 'boolean', description: 'Must be true only after explicit user confirmation.' },
      },
      required: ['event_id', 'confirmed'],
    },
  };

  constructor(private readonly runner: LarkCliRunner = new DefaultLarkCliRunner()) {}

  async execute(args: any, context: ToolExecutionContext): Promise<string> {
    try {
      requireBooleanConfirmation(args?.confirmed, 'Calendar update');
      const eventId = requireString(args?.event_id, 'event_id');
      const calendarId = optionalString(args?.calendar_id) || DEFAULT_CALENDAR_ID;
      const command = [
        'calendar',
        '+update',
        '--as',
        'user',
        '--calendar-id',
        calendarId,
        '--event-id',
        eventId,
        '--format',
        'json',
      ];

      const summary = optionalString(args?.summary);
      if (summary) command.push('--summary', summary);

      const start = optionalString(args?.start);
      const end = optionalString(args?.end);
      if (start || end) {
        command.push('--start', requireIsoDateTime(start, 'start'));
        command.push('--end', requireIsoDateTime(end, 'end'));
      }

      const description = optionalString(args?.description);
      if (description) command.push('--description', description);

      const addAttendeeIds = optionalString(args?.add_attendee_ids);
      if (addAttendeeIds) command.push('--add-attendee-ids', addAttendeeIds);

      const removeAttendeeIds = optionalString(args?.remove_attendee_ids);
      if (removeAttendeeIds) command.push('--remove-attendee-ids', removeAttendeeIds);

      if (args?.notify === false) {
        command.push('--notify=false');
      } else if (args?.notify === true) {
        command.push('--notify');
      }

      const raw = await runLarkCliJson(this.runner, command, context);
      return toToolJson({
        ok: true,
        event: normalizeSingleEvent(raw, calendarId),
      });
    } catch (error) {
      return toErrorToolJson(error);
    }
  }
}

export class FeishuCalendarDeleteTool implements Tool {
  definition: ToolDefinition = {
    name: 'feishu_calendar_delete',
    description: 'Delete a Feishu calendar event. Must only be called after explicit user confirmation, except manual test cleanup that the user clearly requested.',
    parameters: {
      type: 'object',
      properties: {
        event_id: { type: 'string', description: 'Event id to delete.' },
        calendar_id: { type: 'string', description: 'Calendar id. Defaults to primary.' },
        need_notification: { type: 'boolean', description: 'Whether to notify attendees. Defaults to false.' },
        confirmed: { type: 'boolean', description: 'Must be true only after explicit user confirmation.' },
      },
      required: ['event_id', 'confirmed'],
    },
  };

  constructor(private readonly runner: LarkCliRunner = new DefaultLarkCliRunner()) {}

  async execute(args: any, context: ToolExecutionContext): Promise<string> {
    try {
      requireBooleanConfirmation(args?.confirmed, 'Calendar delete');
      const eventId = requireString(args?.event_id, 'event_id');
      const calendarId = optionalString(args?.calendar_id) || DEFAULT_CALENDAR_ID;
      const needNotification = args?.need_notification === true;
      const raw = await runLarkCliJson(this.runner, [
        'calendar',
        'events',
        'delete',
        '--as',
        'user',
        '--params',
        JSON.stringify({
          calendar_id: calendarId,
          event_id: eventId,
          need_notification: String(needNotification),
        }),
        '--format',
        'json',
      ], context);

      return toToolJson({
        ok: true,
        calendar_id: calendarId,
        event_id: eventId,
        need_notification: needNotification,
        result: raw,
      });
    } catch (error) {
      return toErrorToolJson(error);
    }
  }
}

function normalizeEvents(raw: unknown, calendarId: string): Array<Record<string, unknown>> {
  const value = raw as any;
  const candidates = [
    value?.events,
    value?.items,
    value?.data?.events,
    value?.data?.items,
    value?.data?.event_instances,
    value?.event_instances,
  ];
  const events = candidates.find(Array.isArray) || [];
  return events.map((event: unknown) => normalizeEvent(event, calendarId));
}

function normalizeSingleEvent(raw: unknown, calendarId: string): Record<string, unknown> {
  const value = raw as any;
  return normalizeEvent(value?.event || value?.data?.event || value, calendarId);
}

function normalizeEvent(raw: unknown, calendarId: string): Record<string, unknown> {
  const event = (raw && typeof raw === 'object') ? raw as Record<string, any> : {};
  return {
    event_id: readFirstString(event, ['event_id', 'id']),
    summary: readFirstString(event, ['summary', 'title']),
    start: normalizeCalendarTime(event.start_time || event.start),
    end: normalizeCalendarTime(event.end_time || event.end),
    calendar: readFirstString(event, ['calendar_id', 'calendar']) || calendarId,
    app_link: readFirstString(event, ['app_link', 'url']),
    status: readFirstString(event, ['status']),
  };
}

function normalizeCalendarTime(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.date === 'string') {
    return record.date;
  }
  if (typeof record.timestamp === 'string' && /^\d+$/.test(record.timestamp)) {
    const date = new Date(Number(record.timestamp) * 1000);
    return Number.isFinite(date.getTime()) ? date.toISOString() : record.timestamp;
  }
  return undefined;
}

function readFirstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}
