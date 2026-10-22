import {
  ROOT_CONTEXT,
  SpanStatusCode,
  TraceFlags,
  createTraceState,
  isSpanContextValid,
  trace,
} from '@opentelemetry/api';
import type {
  Attributes,
  Span as ApiSpan,
  SpanContext,
  Tracer,
} from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  BasicTracerProvider,
  BatchSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import type { SpanExporter } from '@opentelemetry/sdk-trace-base';
import {
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';
import type {
  ObservabilityAttributes,
  ObservabilitySpanContext,
  ObservabilitySpanStatus,
} from './';

const INSTRUMENTATION_NAME = 'xiaoba-cli';
const MAX_EXTERNAL_STRING_LENGTH = 256;

const SAFE_EXTERNAL_STRING_ATTRIBUTES = new Set([
  'xiaoba.context.compaction.source',
  'xiaoba.context.snapshot.kind',
  'xiaoba.context.snapshot.status',
  'xiaoba.delivery.status',
  'xiaoba.delivery.type',
  'xiaoba.error_code',
  'xiaoba.job.kind',
  'xiaoba.job.operation',
  'xiaoba.model.name',
  'xiaoba.model.status',
  'xiaoba.observability.source',
  'xiaoba.provider.model',
  'xiaoba.provider.name',
  'xiaoba.role.name',
  'xiaoba.session.id_hash',
  'xiaoba.session.status',
  'xiaoba.session.type',
  'xiaoba.skill.name',
  'xiaoba.subagent.role',
  'xiaoba.surface',
  'xiaoba.tool.name',
  'xiaoba.tool.status',
  'xiaoba.trace.id_hash',
  'xiaoba.trace.parent_source',
]);

export interface OtelTraceConfig {
  serviceName: string;
  serviceVersion: string;
  environment?: string;
  endpoint: string;
  headers: Record<string, string>;
  exportTimeoutMs: number;
}

export interface OtelTraceHealth {
  sdkStarted: boolean;
  status: 'disabled' | 'ready' | 'ok' | 'error' | 'stopped';
  exportedSpanCount: number;
  exportErrorCount: number;
  lastExportAt?: string;
}

export interface OtelStartedSpan {
  span: ApiSpan;
  context: ObservabilitySpanContext;
}

export class OtelTraceBridge {
  private provider?: BasicTracerProvider;
  private tracer?: Tracer;
  private stopped = false;
  private healthState: OtelTraceHealth = {
    sdkStarted: false,
    status: 'disabled',
    exportedSpanCount: 0,
    exportErrorCount: 0,
  };

  constructor(config: OtelTraceConfig, exporter?: SpanExporter) {
    try {
      const trackedExporter = new HealthTrackingSpanExporter(
        exporter || createOtlpExporter(config),
        count => this.recordExportSuccess(count),
        () => this.recordExportFailure(),
      );
      const processor = new BatchSpanProcessor(trackedExporter, {
        scheduledDelayMillis: 1000,
        exportTimeoutMillis: config.exportTimeoutMs,
        maxQueueSize: 2048,
        maxExportBatchSize: 512,
      });
      this.provider = new BasicTracerProvider({
        resource: resourceFromAttributes({
          [ATTR_SERVICE_NAME]: config.serviceName,
          [ATTR_SERVICE_VERSION]: config.serviceVersion,
          ...(config.environment && {
            [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: config.environment,
          }),
        }),
        spanProcessors: [processor],
      });
      this.tracer = this.provider.getTracer(INSTRUMENTATION_NAME, config.serviceVersion);
      this.healthState = {
        ...this.healthState,
        sdkStarted: true,
        status: 'ready',
      };
    } catch {
      this.recordExportFailure();
    }
  }

  get health(): OtelTraceHealth {
    return { ...this.healthState };
  }

  startSpan(
    name: string,
    attributes: ObservabilityAttributes,
    parent: ObservabilitySpanContext | undefined,
    startedAtMs: number,
  ): OtelStartedSpan | undefined {
    if (!this.tracer || this.stopped) return undefined;
    try {
      const span = this.tracer.startSpan(name, {
        attributes: externalSpanAttributes(attributes),
        startTime: startedAtMs,
      }, parentOtelContext(parent));
      return {
        span,
        context: fromOtelSpanContext(span.spanContext()),
      };
    } catch {
      this.recordExportFailure();
      return undefined;
    }
  }

  endSpan(
    span: ApiSpan,
    status: ObservabilitySpanStatus,
    attributes: ObservabilityAttributes,
    endedAtMs: number,
  ): void {
    try {
      span.setAttributes(externalSpanAttributes(attributes));
      span.setStatus({
        code: status === 'ok'
          ? SpanStatusCode.OK
          : status === 'error'
            ? SpanStatusCode.ERROR
            : SpanStatusCode.UNSET,
      });
      span.end(endedAtMs);
    } catch {
      this.recordExportFailure();
    }
  }

  async shutdown(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    let failed = false;
    try {
      await this.provider?.forceFlush();
    } catch {
      failed = true;
      this.recordExportFailure();
    }
    try {
      await this.provider?.shutdown();
    } catch {
      failed = true;
      this.recordExportFailure();
    }
    this.healthState = {
      ...this.healthState,
      status: failed || this.healthState.status === 'error' ? 'error' : 'stopped',
    };
  }

  private recordExportSuccess(count: number): void {
    this.healthState = {
      ...this.healthState,
      status: 'ok',
      exportedSpanCount: this.healthState.exportedSpanCount + count,
      lastExportAt: new Date().toISOString(),
    };
  }

  private recordExportFailure(): void {
    this.healthState = {
      ...this.healthState,
      status: 'error',
      exportErrorCount: this.healthState.exportErrorCount + 1,
    };
  }
}

class HealthTrackingSpanExporter implements SpanExporter {
  constructor(
    private readonly delegate: SpanExporter,
    private readonly onSuccess: (count: number) => void,
    private readonly onFailure: () => void,
  ) {}

  export(...args: Parameters<SpanExporter['export']>): void {
    const [spans, resultCallback] = args;
    this.delegate.export(spans, result => {
      if (result.code === 0) {
        this.onSuccess(spans.length);
      } else {
        this.onFailure();
      }
      resultCallback(result);
    });
  }

  async forceFlush(): Promise<void> {
    await this.delegate.forceFlush?.();
  }

  async shutdown(): Promise<void> {
    await this.delegate.shutdown();
  }
}

function createOtlpExporter(config: OtelTraceConfig): SpanExporter {
  const endpoint = new URL(config.endpoint);
  if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') {
    throw new Error('OTLP trace endpoint must use HTTP or HTTPS.');
  }
  return new OTLPTraceExporter({
    url: endpoint.toString(),
    headers: config.headers,
    timeoutMillis: config.exportTimeoutMs,
  });
}

function externalSpanAttributes(attributes: ObservabilityAttributes): Attributes {
  const safe: Attributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (typeof value === 'number' || typeof value === 'boolean') {
      safe[key] = value;
      continue;
    }
    if (typeof value === 'string' && SAFE_EXTERNAL_STRING_ATTRIBUTES.has(key)) {
      safe[key] = value.slice(0, MAX_EXTERNAL_STRING_LENGTH);
    }
  }
  return safe;
}

function parentOtelContext(parent: ObservabilitySpanContext | undefined) {
  if (!parent) return ROOT_CONTEXT;
  const spanContext: SpanContext = {
    traceId: parent.traceId,
    spanId: parent.spanId,
    traceFlags: parent.traceFlags ?? TraceFlags.SAMPLED,
    isRemote: true,
    ...(parent.traceState && { traceState: createTraceState(parent.traceState) }),
  };
  if (!isSpanContextValid(spanContext)) return ROOT_CONTEXT;
  return trace.setSpanContext(ROOT_CONTEXT, spanContext);
}

function fromOtelSpanContext(spanContext: SpanContext): ObservabilitySpanContext {
  const context: ObservabilitySpanContext = {
    traceId: spanContext.traceId,
    spanId: spanContext.spanId,
    traceFlags: spanContext.traceFlags,
    ...(spanContext.traceState && { traceState: spanContext.traceState.serialize() }),
  };
  return {
    ...context,
    traceparent: toTraceparent(context),
  };
}

function toTraceparent(spanContext: ObservabilitySpanContext): string {
  const traceFlags = (spanContext.traceFlags ?? TraceFlags.SAMPLED).toString(16).padStart(2, '0');
  return `00-${spanContext.traceId}-${spanContext.spanId}-${traceFlags}`;
}
