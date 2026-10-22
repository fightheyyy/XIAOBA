export interface ObservabilitySpanContext {
  traceId: string;
  spanId: string;
  traceFlags?: number;
  traceState?: string;
  traceparent?: string;
}
