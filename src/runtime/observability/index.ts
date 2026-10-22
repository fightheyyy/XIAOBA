import * as crypto from 'crypto';
import type { Span as ApiSpan } from '@opentelemetry/api';
import type { SpanExporter } from '@opentelemetry/sdk-trace-base';
import { APP_VERSION } from '../../version';
import { OtelTraceBridge } from './otel-trace-exporter';

export type ObservabilityExporter = 'none' | 'otlp';
export type ObservabilitySpanStatus = 'ok' | 'error' | 'unset';
export type ObservabilitySeverity = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

export type ObservabilityAttributeValue = string | number | boolean | undefined | null;
export type ObservabilityAttributes = Record<string, ObservabilityAttributeValue>;

export interface ObservabilityConfig {
  enabled: boolean;
  serviceName: string;
  serviceVersion: string;
  environment?: string;
  tracesExporter: ObservabilityExporter;
  metricsExporter: ObservabilityExporter;
  logsExporter: ObservabilityExporter;
  otlpTracesEndpoint: string;
  otlpHeaders: Record<string, string>;
  otlpExportTimeoutMs: number;
  localSummaryEnabled: boolean;
  localSummaryLimit: number;
  logPrompts: boolean;
  logToolArgs: boolean;
  logFileContent: boolean;
}

export type { ObservabilitySpanContext } from '../contracts/observability';
import type { ObservabilitySpanContext } from '../contracts/observability';

export interface ObservabilitySpan {
  name: string;
  context: ObservabilitySpanContext;
  parentContext?: ObservabilitySpanContext;
  attributes: ObservabilityAttributes;
  startedAtMs: number;
}

export interface EndSpanOptions {
  status?: ObservabilitySpanStatus;
  message?: string;
  attributes?: ObservabilityAttributes;
}

export type ObservabilityLocalMetricKind = 'counter' | 'histogram';

export interface ObservabilityLocalMetric {
  timestamp: string;
  name: string;
  value: number;
  unit: string;
  kind: ObservabilityLocalMetricKind;
  attributes: Record<string, string | number | boolean>;
}

export interface ObservabilityLocalTraceSpan {
  traceIdHash: string;
  spanIdHash: string;
  parentSpanIdHash?: string;
  name: string;
  status: ObservabilitySpanStatus;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  attributes: Record<string, string | number | boolean>;
}

export interface ObservabilityLocalTraceSummary {
  traceIdHash: string;
  rootName: string;
  status: ObservabilitySpanStatus;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  spanCount: number;
  spans: ObservabilityLocalTraceSpan[];
}

export interface ObservabilityLatencySummary {
  count: number;
  avgMs?: number;
  p50Ms?: number;
  p95Ms?: number;
  maxMs?: number;
}

export interface ObservabilityDimensionSummary {
  name: string;
  count: number;
  successCount: number;
  errorCount: number;
  blockedCount: number;
  successRate: number | null;
  errorRate: number | null;
  blockedRate: number | null;
  latency: ObservabilityLatencySummary;
  lastSeenAt?: string;
}

export interface ObservabilityDrilldownSummary {
  recentErrors: ObservabilityLocalMetric[];
  blockedReasons: ObservabilityDimensionSummary[];
  policyDecisions: Array<{ ruleId: string; action: string; count: number }>;
}

export interface ObservabilityLocalSummary {
  local: {
    enabled: boolean;
    startedAt: string;
    lastUpdatedAt?: string;
    eventCount: number;
    eventLimit: number;
  };
  external: {
    enabled: boolean;
    sdkStarted: boolean;
    tracesExporter: ObservabilityExporter;
    metricsExporter: ObservabilityExporter;
    logsExporter: ObservabilityExporter;
    status: 'disabled' | 'ready' | 'ok' | 'error' | 'stopped';
    exportedSpanCount: number;
    exportErrorCount: number;
    lastExportAt?: string;
  };
  totals: {
    metricEvents: number;
    modelCalls: number;
    toolCalls: number;
    toolResults: number;
    sessions: number;
    errors: number;
    blocked: number;
  };
  slo: {
    modelErrorRate: number | null;
    toolSuccessRate: number | null;
    sessionSuccessRate: number | null;
    byRole: ObservabilityDimensionSummary[];
    bySkill: ObservabilityDimensionSummary[];
    byTool: ObservabilityDimensionSummary[];
    bySurface: ObservabilityDimensionSummary[];
  };
  latency: {
    model: ObservabilityLatencySummary;
    tool: ObservabilityLatencySummary;
    session: ObservabilityLatencySummary;
  };
  top: {
    roles: ObservabilityDimensionSummary[];
    skills: ObservabilityDimensionSummary[];
    tools: ObservabilityDimensionSummary[];
    surfaces: ObservabilityDimensionSummary[];
    errors: ObservabilityDimensionSummary[];
  };
  drilldown: ObservabilityDrilldownSummary;
  traces: {
    spanCount: number;
    traceCount: number;
    rawTraceparentExported: false;
    recent: ObservabilityLocalTraceSummary[];
  };
  recent: ObservabilityLocalMetric[];
}

const DEFAULT_SERVICE_NAME = 'xiaoba-cli';
const DEFAULT_SERVICE_VERSION = APP_VERSION;
const DEFAULT_LOCAL_SUMMARY_LIMIT = 2000;
const MAX_PREVIEW_CHARS = 500;
const TRACE_FLAGS_SAMPLED = 1;

export class Observability {
  private readonly localMetrics: ObservabilityLocalMetric[] = [];
  private readonly localTraceSpans: ObservabilityLocalTraceSpan[] = [];
  private readonly localStartedAt = new Date().toISOString();
  private readonly externalSpans = new WeakMap<ObservabilitySpan, ApiSpan>();
  private readonly otelTrace?: OtelTraceBridge;
  private localLastUpdatedAt?: string;
  private shutdownPromise?: Promise<void>;

  constructor(public readonly config: ObservabilityConfig, traceExporter?: SpanExporter) {
    if (config.enabled && config.tracesExporter === 'otlp') {
      this.otelTrace = new OtelTraceBridge({
        serviceName: config.serviceName,
        serviceVersion: config.serviceVersion,
        environment: config.environment,
        endpoint: config.otlpTracesEndpoint,
        headers: config.otlpHeaders,
        exportTimeoutMs: config.otlpExportTimeoutMs,
      }, traceExporter);
    }
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env, traceExporter?: SpanExporter): Observability {
    const requested = parseBoolean(env.XIAOBA_OBSERVABILITY_ENABLED, false)
      && !parseBoolean(env.OTEL_SDK_DISABLED, false);
    const tracesExporter = requested
      ? parseExporter(env.XIAOBA_OBSERVABILITY_TRACES_EXPORTER || env.OTEL_TRACES_EXPORTER || 'otlp')
      : 'none';
    return new Observability({
      enabled: requested && tracesExporter === 'otlp',
      serviceName: env.XIAOBA_OBSERVABILITY_SERVICE_NAME || env.OTEL_SERVICE_NAME || DEFAULT_SERVICE_NAME,
      serviceVersion: env.XIAOBA_VERSION || DEFAULT_SERVICE_VERSION,
      environment: env.NODE_ENV,
      tracesExporter,
      metricsExporter: 'none',
      logsExporter: 'none',
      otlpTracesEndpoint: resolveOtlpTracesEndpoint(env),
      otlpHeaders: parseOtlpHeaders(
        env.OTEL_EXPORTER_OTLP_HEADERS,
        env.OTEL_EXPORTER_OTLP_TRACES_HEADERS,
      ),
      otlpExportTimeoutMs: parsePositiveInt(
        env.OTEL_EXPORTER_OTLP_TRACES_TIMEOUT || env.OTEL_EXPORTER_OTLP_TIMEOUT,
        10_000,
      ),
      localSummaryEnabled: parseBoolean(env.XIAOBA_OBSERVABILITY_LOCAL_ENABLED, true),
      localSummaryLimit: parsePositiveInt(env.XIAOBA_OBSERVABILITY_LOCAL_LIMIT, DEFAULT_LOCAL_SUMMARY_LIMIT),
      logPrompts: parseBoolean(env.XIAOBA_OBSERVABILITY_LOG_PROMPTS, false),
      logToolArgs: parseBoolean(env.XIAOBA_OBSERVABILITY_LOG_TOOL_ARGS, false),
      logFileContent: parseBoolean(env.XIAOBA_OBSERVABILITY_LOG_FILE_CONTENT, false),
    }, traceExporter);
  }

  isEnabled(): boolean {
    return this.otelTrace?.health.sdkStarted === true;
  }

  startSpan(name: string, attributes: ObservabilityAttributes = {}, parent?: ObservabilitySpanContext): ObservabilitySpan {
    const startedAtMs = Date.now();
    const externalSpan = this.otelTrace?.startSpan(name, attributes, parent, startedAtMs);
    const span: ObservabilitySpan = {
      name,
      context: externalSpan?.context || childSpanContext(parent),
      parentContext: parent,
      attributes: normalizeAttributes(attributes),
      startedAtMs,
    };
    if (externalSpan) {
      this.externalSpans.set(span, externalSpan.span);
    }
    return span;
  }

  endSpan(span: ObservabilitySpan | undefined, options: EndSpanOptions = {}): void {
    if (!span) return;
    const endedAtMs = Date.now();
    this.recordLocalTraceSpan(span, options, endedAtMs);
    const externalSpan = this.externalSpans.get(span);
    if (externalSpan) {
      this.externalSpans.delete(span);
      this.otelTrace?.endSpan(
        externalSpan,
        options.status || 'unset',
        { ...span.attributes, ...(options.attributes || {}) },
        endedAtMs,
      );
    }
  }

  recordLog(
    _eventName: string,
    _attributes: ObservabilityAttributes = {},
    _severity: ObservabilitySeverity = 'INFO',
    _span?: ObservabilitySpanContext,
  ): void {
    // Logs stay in the session/runtime log files. Observability no longer mirrors them externally.
  }

  recordMetric(name: string, value = 1, attributes: ObservabilityAttributes = {}, unit = '1'): void {
    if (!Number.isFinite(value)) {
      return;
    }
    const kind = this.isHistogramMetric(name, unit) ? 'histogram' : 'counter';
    this.recordLocalMetric(name, value, attributes, unit, kind);
  }

  mirrorMetric(_name: string, _value = 1, _attributes: ObservabilityAttributes = {}, _unit = '1'): void {
    // External metric mirroring was removed for the local-first observability model.
  }

  recordHistogram(name: string, value: number, attributes: ObservabilityAttributes = {}, unit = '1'): void {
    if (!Number.isFinite(value)) {
      return;
    }
    this.recordLocalMetric(name, value, attributes, unit, 'histogram');
  }

  getLocalSummary(): ObservabilityLocalSummary {
    const events = this.localMetrics.slice();
    const modelCallEvents = events.filter(event => event.name === 'xiaoba.model.call');
    const toolCallEvents = events.filter(event => event.name === 'xiaoba.tool.call');
    const toolResultEvents = events.filter(event => event.name === 'xiaoba.tool.result');
    const sessionResultEvents = events.filter(event => event.name === 'xiaoba.session.result');
    const errorEvents = events.filter(isLocalErrorEvent);
    const blockedEvents = events.filter(isLocalBlockedEvent);
    const recentErrorEvents = events
      .filter(event => isLocalOutcomeEvent(event) && isLocalErrorEvent(event))
      .slice(-10)
      .reverse();
    const blockedOutcomeEvents = events
      .filter(event => isLocalOutcomeEvent(event) && isLocalBlockedEvent(event));
    const externalHealth = this.otelTrace?.health || {
      sdkStarted: false,
      status: 'disabled' as const,
      exportedSpanCount: 0,
      exportErrorCount: 0,
    };

    return {
      local: {
        enabled: this.config.localSummaryEnabled,
        startedAt: this.localStartedAt,
        lastUpdatedAt: this.localLastUpdatedAt,
        eventCount: events.length,
        eventLimit: this.config.localSummaryLimit,
      },
      external: {
        enabled: this.config.enabled,
        sdkStarted: externalHealth.sdkStarted,
        tracesExporter: this.config.tracesExporter,
        metricsExporter: this.config.metricsExporter,
        logsExporter: this.config.logsExporter,
        status: externalHealth.status,
        exportedSpanCount: externalHealth.exportedSpanCount,
        exportErrorCount: externalHealth.exportErrorCount,
        ...(externalHealth.lastExportAt && { lastExportAt: externalHealth.lastExportAt }),
      },
      totals: {
        metricEvents: events.length,
        modelCalls: sumValues(modelCallEvents),
        toolCalls: sumValues(toolCallEvents),
        toolResults: sumValues(toolResultEvents),
        sessions: sumValues(sessionResultEvents),
        errors: errorEvents.length,
        blocked: blockedEvents.length,
      },
      slo: {
        modelErrorRate: rate(modelCallEvents.filter(isLocalErrorEvent).length, modelCallEvents.length),
        toolSuccessRate: rate(toolResultEvents.filter(isLocalSuccessEvent).length, toolResultEvents.length),
        sessionSuccessRate: rate(sessionResultEvents.filter(isLocalSuccessEvent).length, sessionResultEvents.length),
        byRole: sloDimensionSummary(events, 'xiaoba.role.name'),
        bySkill: sloDimensionSummary(events, 'xiaoba.skill.name'),
        byTool: sloDimensionSummary(events, 'xiaoba.tool.name'),
        bySurface: sloDimensionSummary(events, 'xiaoba.surface'),
      },
      latency: {
        model: latencySummary(events.filter(event => event.name === 'xiaoba.model.duration_ms')),
        tool: latencySummary(events.filter(event => event.name === 'xiaoba.tool.duration_ms')),
        session: latencySummary(events.filter(event => event.name === 'xiaoba.session.duration_ms')),
      },
      top: {
        roles: dimensionSummary(events, 'xiaoba.role.name'),
        skills: dimensionSummary(events, 'xiaoba.skill.name'),
        tools: dimensionSummary(events, 'xiaoba.tool.name'),
        surfaces: dimensionSummary(events, 'xiaoba.surface'),
        errors: dimensionSummary(errorEvents, 'xiaoba.error_code'),
      },
      drilldown: {
        recentErrors: recentErrorEvents,
        blockedReasons: dimensionSummary(blockedOutcomeEvents, 'xiaoba.blocked_reason'),
        policyDecisions: [],
      },
      traces: {
        spanCount: this.localTraceSpans.length,
        traceCount: new Set(this.localTraceSpans.map(span => span.traceIdHash)).size,
        rawTraceparentExported: false,
        recent: buildTraceSummaries(this.localTraceSpans),
      },
      recent: events.slice(-20).reverse(),
    };
  }

  sessionIdHash(sessionId: string | undefined): string | undefined {
    if (!sessionId) return undefined;
    return crypto.createHash('sha256').update(sessionId).digest('hex').slice(0, 16);
  }

  userInputAttributes(input: string | unknown): ObservabilityAttributes {
    const text = typeof input === 'string' ? input : Array.isArray(input) ? '[content-blocks]' : '';
    return {
      'xiaoba.user_input.chars': text.length,
      ...(this.config.logPrompts && text ? { 'xiaoba.user_input.preview': text.slice(0, MAX_PREVIEW_CHARS) } : {}),
    };
  }

  toolArgumentAttributes(argumentsJson: string): ObservabilityAttributes {
    return {
      'xiaoba.tool.arguments.chars': argumentsJson.length,
      ...(this.config.logToolArgs && argumentsJson ? { 'xiaoba.tool.arguments.preview': argumentsJson.slice(0, MAX_PREVIEW_CHARS) } : {}),
    };
  }

  traceparent(spanContext: ObservabilitySpanContext | undefined): string | undefined {
    if (!spanContext) return undefined;
    return spanContext.traceparent || toTraceparent(spanContext);
  }

  parseTraceparent(value: string | undefined): ObservabilitySpanContext | undefined {
    return parseTraceparent(value);
  }

  async shutdown(): Promise<void> {
    if (!this.shutdownPromise) {
      this.shutdownPromise = this.otelTrace?.shutdown() || Promise.resolve();
    }
    await this.shutdownPromise;
  }

  private isHistogramMetric(name: string, unit: string): boolean {
    return unit === 'ms'
      || name.endsWith('.duration_ms')
      || name.endsWith('.latency_ms');
  }

  private recordLocalMetric(
    name: string,
    value: number,
    attributes: ObservabilityAttributes,
    unit: string,
    kind: ObservabilityLocalMetricKind,
  ): void {
    if (!this.config.localSummaryEnabled) return;
    const timestamp = new Date().toISOString();
    this.localLastUpdatedAt = timestamp;
    this.localMetrics.push({
      timestamp,
      name,
      value,
      unit,
      kind,
      attributes: normalizeAttributes(attributes),
    });
    const limit = Math.max(1, this.config.localSummaryLimit);
    if (this.localMetrics.length > limit) {
      this.localMetrics.splice(0, this.localMetrics.length - limit);
    }
  }

  private recordLocalTraceSpan(
    span: ObservabilitySpan,
    options: EndSpanOptions,
    endedAtMs: number,
  ): void {
    if (!this.config.localSummaryEnabled) return;
    const durationMs = Math.max(0, endedAtMs - span.startedAtMs);
    const timestamp = new Date(endedAtMs).toISOString();
    this.localLastUpdatedAt = timestamp;
    this.localTraceSpans.push({
      traceIdHash: hashIdentifier(span.context.traceId),
      spanIdHash: hashIdentifier(`${span.context.traceId}:${span.context.spanId}`),
      ...(span.parentContext?.spanId && {
        parentSpanIdHash: hashIdentifier(`${span.context.traceId}:${span.parentContext.spanId}`),
      }),
      name: span.name,
      status: options.status || 'unset',
      startedAt: new Date(span.startedAtMs).toISOString(),
      endedAt: timestamp,
      durationMs: round(durationMs),
      attributes: normalizeAttributes({
        ...span.attributes,
        ...(options.attributes || {}),
      }),
    });
    const limit = Math.max(1, this.config.localSummaryLimit);
    if (this.localTraceSpans.length > limit) {
      this.localTraceSpans.splice(0, this.localTraceSpans.length - limit);
    }
  }
}

let singleton: Observability | undefined;
let beforeExitHookInstalled = false;
const flushObservabilityBeforeExit = () => {
  void singleton?.shutdown();
};

export function getObservability(): Observability {
  if (!singleton) {
    singleton = Observability.fromEnv();
  }
  if (singleton.isEnabled() && !beforeExitHookInstalled) {
    beforeExitHookInstalled = true;
    process.once('beforeExit', flushObservabilityBeforeExit);
  }
  return singleton;
}

export function resetObservabilityForTests(observability?: Observability): void {
  if (beforeExitHookInstalled) {
    process.off('beforeExit', flushObservabilityBeforeExit);
    beforeExitHookInstalled = false;
  }
  singleton = observability;
}

export async function shutdownObservability(): Promise<void> {
  await singleton?.shutdown();
}

export async function shutdownObservabilityForTests(): Promise<void> {
  await shutdownObservability();
  if (beforeExitHookInstalled) {
    process.off('beforeExit', flushObservabilityBeforeExit);
    beforeExitHookInstalled = false;
  }
  singleton = undefined;
}

function normalizeAttributes(attributes: ObservabilityAttributes): Record<string, string | number | boolean> {
  const normalized: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      normalized[key] = value;
    }
  }
  return normalized;
}

function sumValues(events: ObservabilityLocalMetric[]): number {
  return events.reduce((total, event) => total + event.value, 0);
}

function rate(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return round(numerator / denominator);
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function latencySummary(events: ObservabilityLocalMetric[]): ObservabilityLatencySummary {
  const values = events
    .map(event => event.value)
    .filter(value => Number.isFinite(value))
    .sort((a, b) => a - b);
  if (!values.length) {
    return { count: 0 };
  }
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    count: values.length,
    avgMs: round(total / values.length),
    p50Ms: round(percentile(values, 0.5)),
    p95Ms: round(percentile(values, 0.95)),
    maxMs: round(values[values.length - 1]),
  };
}

function buildTraceSummaries(spans: ObservabilityLocalTraceSpan[]): ObservabilityLocalTraceSummary[] {
  const groups = new Map<string, ObservabilityLocalTraceSpan[]>();
  for (const span of spans) {
    const current = groups.get(span.traceIdHash) || [];
    current.push(span);
    groups.set(span.traceIdHash, current);
  }
  return Array.from(groups.entries())
    .map(([traceIdHash, group]) => {
      const sortedSpans = group
        .slice()
        .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt) || a.name.localeCompare(b.name));
      const startMs = Math.min(...sortedSpans.map(span => Date.parse(span.startedAt)).filter(Number.isFinite));
      const endMs = Math.max(...sortedSpans.map(span => Date.parse(span.endedAt)).filter(Number.isFinite));
      const rootSpan = sortedSpans.find(span => !span.parentSpanIdHash) || sortedSpans[0];
      return {
        traceIdHash,
        rootName: rootSpan?.name || 'unknown',
        status: traceStatus(sortedSpans),
        startedAt: Number.isFinite(startMs) ? new Date(startMs).toISOString() : sortedSpans[0]?.startedAt || '',
        endedAt: Number.isFinite(endMs) ? new Date(endMs).toISOString() : sortedSpans[sortedSpans.length - 1]?.endedAt || '',
        durationMs: Number.isFinite(startMs) && Number.isFinite(endMs) ? round(Math.max(0, endMs - startMs)) : 0,
        spanCount: sortedSpans.length,
        spans: sortedSpans.slice(0, 12),
      };
    })
    .sort((a, b) => Date.parse(b.endedAt) - Date.parse(a.endedAt))
    .slice(0, 6);
}

function traceStatus(spans: ObservabilityLocalTraceSpan[]): ObservabilitySpanStatus {
  if (spans.some(span => span.status === 'error')) return 'error';
  if (spans.some(span => span.status === 'unset')) return 'unset';
  return spans.length ? 'ok' : 'unset';
}

function percentile(sortedValues: number[], p: number): number {
  if (sortedValues.length === 1) return sortedValues[0];
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil(sortedValues.length * p) - 1));
  return sortedValues[index];
}

function dimensionSummary(events: ObservabilityLocalMetric[], attributeKey: string): ObservabilityDimensionSummary[] {
  const groups = new Map<string, ObservabilityLocalMetric[]>();
  for (const event of events) {
    const raw = event.attributes[attributeKey];
    if (raw === undefined || raw === null || raw === '') continue;
    const name = String(raw);
    const current = groups.get(name) || [];
    current.push(event);
    groups.set(name, current);
  }
  return Array.from(groups.entries())
    .map(([name, group]) => {
      const successCount = group.filter(isLocalSuccessEvent).length;
      const errorCount = group.filter(isLocalErrorEvent).length;
      const blockedCount = group.filter(isLocalBlockedEvent).length;
      const durationEvents = group.filter(event => event.kind === 'histogram' && event.unit === 'ms');
      return {
        name,
        count: group.length,
        successCount,
        errorCount,
        blockedCount,
        successRate: rate(successCount, successCount + errorCount + blockedCount),
        errorRate: rate(errorCount + blockedCount, successCount + errorCount + blockedCount),
        blockedRate: rate(blockedCount, successCount + errorCount + blockedCount),
        latency: latencySummary(durationEvents),
        lastSeenAt: group[group.length - 1]?.timestamp,
      };
    })
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, 10);
}

function sloDimensionSummary(events: ObservabilityLocalMetric[], attributeKey: string): ObservabilityDimensionSummary[] {
  const groups = new Map<string, ObservabilityLocalMetric[]>();
  for (const event of events) {
    const raw = event.attributes[attributeKey];
    if (raw === undefined || raw === null || raw === '') continue;
    const name = String(raw);
    const current = groups.get(name) || [];
    current.push(event);
    groups.set(name, current);
  }
  return Array.from(groups.entries())
    .map(([name, group]) => {
      const outcomeEvents = group.filter(isLocalOutcomeEvent);
      const successCount = outcomeEvents.filter(isLocalSuccessEvent).length;
      const blockedCount = outcomeEvents.filter(isLocalBlockedEvent).length;
      const errorCount = outcomeEvents.filter(event => isLocalErrorEvent(event) && !isLocalBlockedEvent(event)).length;
      const terminalCount = successCount + errorCount + blockedCount;
      const durationEvents = group.filter(event => event.kind === 'histogram' && event.unit === 'ms');
      return {
        name,
        count: terminalCount,
        successCount,
        errorCount,
        blockedCount,
        successRate: rate(successCount, terminalCount),
        errorRate: rate(errorCount + blockedCount, terminalCount),
        blockedRate: rate(blockedCount, terminalCount),
        latency: latencySummary(durationEvents),
        lastSeenAt: group[group.length - 1]?.timestamp,
      };
    })
    .filter(item => item.count > 0 || item.latency.count > 0)
    .sort((a, b) => b.count - a.count || (b.latency.p95Ms ?? 0) - (a.latency.p95Ms ?? 0) || a.name.localeCompare(b.name))
    .slice(0, 10);
}

function isLocalOutcomeEvent(event: ObservabilityLocalMetric): boolean {
  if (event.kind === 'histogram') return false;
  return event.name === 'xiaoba.model.call'
    || event.name === 'xiaoba.tool.result'
    || event.name === 'xiaoba.session.result'
    || event.name === 'xiaoba.provider.error'
    || event.name === 'xiaoba.delivery.evidence'
    || Boolean(localStatus(event))
    || Boolean(event.attributes['xiaoba.error_code'])
    || Boolean(event.attributes['xiaoba.blocked_reason']);
}

function localStatus(event: ObservabilityLocalMetric): string | undefined {
  return firstString(
    event.attributes['xiaoba.tool.status'],
    event.attributes['xiaoba.model.status'],
    event.attributes['xiaoba.session.status'],
    event.attributes['xiaoba.delivery.status'],
  )?.toLowerCase();
}

function isLocalSuccessEvent(event: ObservabilityLocalMetric): boolean {
  const status = localStatus(event);
  return status === 'success' || status === 'delivered' || status === 'ok';
}

function isLocalErrorEvent(event: ObservabilityLocalMetric): boolean {
  const status = localStatus(event);
  return event.name === 'xiaoba.provider.error'
    || Boolean(event.attributes['xiaoba.error_code'])
    || status === 'failure'
    || status === 'error'
    || status === 'timeout'
    || status === 'cancelled'
    || status === 'blocked'
    || status === 'failed';
}

function isLocalBlockedEvent(event: ObservabilityLocalMetric): boolean {
  return localStatus(event) === 'blocked' || Boolean(event.attributes['xiaoba.blocked_reason']);
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseExporter(value: string): ObservabilityExporter {
  const exporters = value
    .split(',')
    .map(item => item.trim().toLowerCase())
    .filter(Boolean);
  return exporters.includes('otlp') ? 'otlp' : 'none';
}

function resolveOtlpTracesEndpoint(env: NodeJS.ProcessEnv): string {
  const explicit = env.XIAOBA_OBSERVABILITY_OTLP_TRACES_ENDPOINT
    || env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  if (explicit?.trim()) return explicit.trim();
  const shared = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  if (!shared) return 'http://localhost:4318/v1/traces';
  const base = shared.replace(/\/+$/, '');
  return base.endsWith('/v1/traces') ? base : `${base}/v1/traces`;
}

function parseOtlpHeaders(...values: Array<string | undefined>): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const value of values) {
    if (!value) continue;
    for (const entry of value.split(',')) {
      const separator = entry.indexOf('=');
      if (separator <= 0) continue;
      const key = decodeHeaderPart(entry.slice(0, separator)).trim();
      const headerValue = decodeHeaderPart(entry.slice(separator + 1)).trim();
      if (key && headerValue) headers[key] = headerValue;
    }
  }
  return headers;
}

function decodeHeaderPart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function childSpanContext(parent?: ObservabilitySpanContext): ObservabilitySpanContext {
  const contextValue: ObservabilitySpanContext = {
    traceId: parent?.traceId || crypto.randomBytes(16).toString('hex'),
    spanId: crypto.randomBytes(8).toString('hex'),
    traceFlags: parent?.traceFlags ?? TRACE_FLAGS_SAMPLED,
    ...(parent?.traceState && { traceState: parent.traceState }),
  };
  return {
    ...contextValue,
    traceparent: toTraceparent(contextValue),
  };
}

function hashIdentifier(value: string | undefined): string {
  return crypto.createHash('sha256').update(value || '').digest('hex').slice(0, 16);
}

function toTraceparent(spanContext: ObservabilitySpanContext): string {
  const traceFlags = (spanContext.traceFlags ?? TRACE_FLAGS_SAMPLED).toString(16).padStart(2, '0');
  return `00-${spanContext.traceId}-${spanContext.spanId}-${traceFlags}`;
}

function parseTraceparent(value: string | undefined): ObservabilitySpanContext | undefined {
  if (!value) return undefined;
  const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(?:-(.+))?$/i.exec(value.trim());
  if (!match) return undefined;
  const contextValue: ObservabilitySpanContext = {
    traceId: match[1].toLowerCase(),
    spanId: match[2].toLowerCase(),
    traceFlags: Number.parseInt(match[3], 16),
    ...(match[4] ? { traceState: match[4] } : {}),
  };
  return {
    ...contextValue,
    traceparent: toTraceparent(contextValue),
  };
}
