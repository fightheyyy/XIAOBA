import { getObservability, ObservabilityAttributes, ObservabilitySeverity } from './';
import type { SessionLogEntry, SessionRuntimeEventLogEntry, SessionTurnLogEntry } from './session-turn-logger';

const OBSERVABILITY_SOURCE = 'session_log';

export function projectSessionLogEntryToObservability(entry: SessionLogEntry): void {
  try {
    if (entry.entry_type === 'trace' || entry.entry_type === 'turn') {
      projectTraceEntry(entry);
      return;
    }
    if (entry.entry_type === 'runtime_event') {
      projectRuntimeEventEntry(entry);
      return;
    }
    projectRuntimeLogEntry(entry);
  } catch (error) {
    console.error('[SessionLogProjector] Failed to project session log entry:', error);
  }
}

function projectTraceEntry(entry: SessionTurnLogEntry): void {
  const observability = getObservability();
  const baseAttrs = {
    ...baseAttributes(entry.session_id, entry.session_type),
    ...traceAttributes(entry),
    ...visibilityAttributes(entry),
  };
  const toolCalls = Array.isArray(entry.assistant?.tool_calls)
    ? entry.assistant.tool_calls as unknown as Array<Record<string, unknown>>
    : [];
  const events = Array.isArray((entry as any).events)
    ? (entry as any).events as SessionRuntimeEventLogEntry[]
    : [];

  for (const event of events) {
    projectRuntimeEventEntry({
      ...event,
      session_id: event.session_id || entry.session_id,
      session_type: event.session_type || entry.session_type,
    }, baseAttrs);
  }

  if (Number.isFinite(entry.tokens?.prompt)) {
    observability.recordMetric('xiaoba.tokens.prompt', Number(entry.tokens.prompt), baseAttrs, 'token');
  }
  if (Number.isFinite(entry.tokens?.completion)) {
    observability.recordMetric('xiaoba.tokens.completion', Number(entry.tokens.completion), baseAttrs, 'token');
  }
  const totalTokens = Number(entry.tokens?.prompt || 0) + Number(entry.tokens?.completion || 0);
  if (totalTokens > 0) {
    observability.recordMetric('xiaoba.tokens.total', totalTokens, baseAttrs, 'token');
  }

  for (const tool of toolCalls) {
    const toolStatus = stringValue(tool.status) || 'success';
    const toolAttrs: ObservabilityAttributes = {
      ...baseAttrs,
      ...(stringValue(tool.name) && { 'xiaoba.tool.name': stringValue(tool.name) }),
      'xiaoba.tool.status': toolStatus,
      ...(stringValue(tool.error_code) && { 'xiaoba.error_code': stringValue(tool.error_code) }),
      ...(stringValue(tool.blocked_reason) && { 'xiaoba.blocked_reason': stringValue(tool.blocked_reason) }),
      ...(stringValue(tool.skill_id) && { 'xiaoba.skill.name': stringValue(tool.skill_id) }),
    };
    observability.recordMetric('xiaoba.tool.call', 1, toolAttrs);
    observability.recordMetric('xiaoba.tool.result', 1, toolAttrs);
    const durationMs = numberValue(tool.duration_ms);
    if (durationMs !== undefined) {
      observability.recordMetric('xiaoba.tool.duration_ms', durationMs, toolAttrs, 'ms');
    }
    const severity: ObservabilitySeverity = toolStatus === 'success' ? 'INFO' : 'ERROR';
    observability.recordLog('xiaoba.tool.result', toolAttrs, severity);
    projectDeliveryEvidence(tool, baseAttrs);
  }
}

function projectRuntimeEventEntry(entry: SessionRuntimeEventLogEntry, inheritedAttrs: ObservabilityAttributes = {}): void {
  const observability = getObservability();
  const eventType = String(entry.event_type || 'runtime_event');
  const baseAttrs = {
    ...baseAttributes(entry.session_id, entry.session_type),
    ...inheritedAttrs,
  };
  if (eventType === 'session_started') {
    const attrs = {
      ...baseAttrs,
      ...runtimeEventAttributes(entry),
    };
    observability.recordMetric('xiaoba.session.started', 1, attrs);
    observability.recordLog('xiaoba.session.started', attrs, 'INFO');
    return;
  }
  if (eventType === 'session_completed') {
    const attrs = {
      ...baseAttrs,
      'xiaoba.session.status': stringValue(entry.status) || 'success',
      ...runtimeEventAttributes(entry),
    };
    observability.recordMetric('xiaoba.session.completed', 1, attrs);
    observability.recordMetric('xiaoba.session.result', 1, attrs);
    const durationMs = numberValue(entry.duration_ms);
    if (durationMs !== undefined) {
      observability.recordMetric('xiaoba.session.duration_ms', durationMs, attrs, 'ms');
    }
    const modelCalls = numberValue(entry.model_call_count);
    if (modelCalls !== undefined && modelCalls > 0) {
      observability.recordMetric('xiaoba.model.call', modelCalls, {
        ...attrs,
        'xiaoba.model.status': 'success',
      });
    }
    observability.recordLog('xiaoba.session.completed', attrs, 'INFO');
    return;
  }
  if (eventType === 'provider_error') {
    const attrs = {
      ...baseAttrs,
      'xiaoba.session.status': stringValue(entry.status) || 'failure',
      ...(stringValue(entry.error_code) && { 'xiaoba.error_code': stringValue(entry.error_code) }),
      ...(stringValue(entry.blocked_reason) && { 'xiaoba.blocked_reason': stringValue(entry.blocked_reason) }),
      ...providerAttributes(entry.provider_error),
    };
    observability.recordMetric('xiaoba.provider.error', 1, attrs);
    observability.recordMetric('xiaoba.session.result', 1, attrs);
    const durationMs = numberValue(entry.duration_ms);
    if (durationMs !== undefined) {
      observability.recordMetric('xiaoba.session.duration_ms', durationMs, attrs, 'ms');
    }
    observability.recordLog('xiaoba.provider.error', attrs, 'ERROR');
    return;
  }
  if (eventType === 'context_compaction') {
    const attrs = {
      ...baseAttrs,
      ...runtimeEventAttributes(entry),
      ...(stringValue(entry.source) && { 'xiaoba.context.compaction.source': stringValue(entry.source) }),
      ...(stringValue(entry.reason) && { 'xiaoba.context.compaction.reason': stringValue(entry.reason) }),
      ...(stringValue(entry.snapshot_kind) && { 'xiaoba.context.snapshot.kind': stringValue(entry.snapshot_kind) }),
      ...(stringValue(entry.snapshot_status) && { 'xiaoba.context.snapshot.status': stringValue(entry.snapshot_status) }),
      ...(numberValue(entry.turn) !== undefined && { 'xiaoba.turn': numberValue(entry.turn) }),
    };
    observability.recordMetric('xiaoba.context.compaction', 1, attrs);
    const tokensBefore = numberValue(entry.tokens_before);
    if (tokensBefore !== undefined) {
      observability.recordMetric('xiaoba.context.compaction.tokens_before', tokensBefore, attrs, 'token');
    }
    const tokensAfter = numberValue(entry.tokens_after);
    if (tokensAfter !== undefined) {
      observability.recordMetric('xiaoba.context.compaction.tokens_after', tokensAfter, attrs, 'token');
    }
    observability.recordLog('xiaoba.context.compaction', attrs, stringValue(entry.status) === 'failed' ? 'ERROR' : 'INFO');
    return;
  }

  observability.recordLog(`xiaoba.runtime_event.${eventType}`, baseAttrs, 'INFO');
}

function projectRuntimeLogEntry(entry: Extract<SessionLogEntry, { entry_type: 'runtime' }>): void {
  const observability = getObservability();
  const severity = runtimeSeverity(entry.level);
  observability.recordLog('xiaoba.runtime.log', baseAttributes(entry.session_id, entry.session_type), severity);
}

function projectDeliveryEvidence(
  tool: Record<string, unknown>,
  baseAttrs: ObservabilityAttributes,
): void {
  const observability = getObservability();
  const deliveries = Array.isArray(tool.delivery_evidence)
    ? tool.delivery_evidence as Array<Record<string, unknown>>
    : [];
  for (const delivery of deliveries) {
    const attrs: ObservabilityAttributes = {
      ...baseAttrs,
      ...(stringValue(delivery.delivery_type) && { 'xiaoba.delivery.type': stringValue(delivery.delivery_type) }),
      ...(stringValue(delivery.status) && { 'xiaoba.delivery.status': stringValue(delivery.status) }),
      ...(stringValue(delivery.surface) && { 'xiaoba.surface': stringValue(delivery.surface) }),
    };
    observability.recordMetric('xiaoba.delivery.evidence', 1, attrs);
    observability.recordLog(
      'xiaoba.delivery.evidence',
      attrs,
      stringValue(delivery.status) === 'delivered' ? 'INFO' : 'WARN',
    );
  }
}

function baseAttributes(sessionId: string | undefined, sessionType: string | undefined): ObservabilityAttributes {
  const observability = getObservability();
  return {
    'xiaoba.observability.source': OBSERVABILITY_SOURCE,
    ...(sessionId && { 'xiaoba.session.id_hash': observability.sessionIdHash(sessionId) }),
    ...(sessionType && {
      'xiaoba.session.type': sessionType,
      'xiaoba.surface': sessionType,
    }),
  };
}

function traceAttributes(entry: SessionTurnLogEntry): ObservabilityAttributes {
  const observability = getObservability();
  const traceId = stringValue((entry as any).trace_id)
    || stringValue(entry.episode_id)
    || stringValue(entry.turn_id);
  const traceIndex = numberValue((entry as any).trace_index)
    ?? numberValue(entry.episode_index)
    ?? numberValue(entry.turn);
  return {
    ...(traceId && { 'xiaoba.trace.id_hash': observability.sessionIdHash(traceId) }),
    ...(traceIndex !== undefined && { 'xiaoba.trace.index': traceIndex }),
  };
}

function visibilityAttributes(entry: SessionTurnLogEntry): ObservabilityAttributes {
  const visibility = Array.isArray(entry.tool_visibility) ? entry.tool_visibility : [];
  const firstRole = visibility.map(item => stringValue(item.roleName)).find(Boolean);
  const firstSkill = visibility.map(item => stringValue(item.activeSkillName)).find(Boolean);
  return {
    ...(firstRole && { 'xiaoba.role.name': firstRole }),
    ...(firstSkill && { 'xiaoba.skill.name': firstSkill }),
  };
}

function runtimeEventAttributes(entry: SessionRuntimeEventLogEntry): ObservabilityAttributes {
  return {
    ...(stringValue(entry.surface) && { 'xiaoba.surface': stringValue(entry.surface) }),
    ...(stringValue(entry.status) && { 'xiaoba.session.status': stringValue(entry.status) }),
    ...(stringValue(entry.error_code) && { 'xiaoba.error_code': stringValue(entry.error_code) }),
    ...(stringValue(entry.blocked_reason) && { 'xiaoba.blocked_reason': stringValue(entry.blocked_reason) }),
    ...(booleanValue(entry.visible_to_user) !== undefined && { 'xiaoba.session.visible_to_user': booleanValue(entry.visible_to_user) }),
    ...(booleanValue(entry.final_response_visible) !== undefined && { 'xiaoba.session.final_response_visible': booleanValue(entry.final_response_visible) }),
  };
}

function providerAttributes(value: unknown): ObservabilityAttributes {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  return {
    ...(stringValue(record.provider) && { 'xiaoba.provider.name': stringValue(record.provider) }),
    ...(stringValue(record.model) && { 'xiaoba.provider.model': stringValue(record.model) }),
  };
}

function stringValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function numberValue(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

function runtimeSeverity(level: string | undefined): ObservabilitySeverity {
  const normalized = String(level || '').toUpperCase();
  if (normalized === 'ERROR') return 'ERROR';
  if (normalized === 'WARN' || normalized === 'WARNING') return 'WARN';
  if (normalized === 'DEBUG') return 'DEBUG';
  return 'INFO';
}
