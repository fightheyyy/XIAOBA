export interface CommandOptions {
  interactive?: boolean;
  message?: string;
  config?: string;
  skill?: string;
  role?: string;
  resume?: boolean;
  verbose?: boolean;
  /** Internal one-shot session identity; normal CLI callers should omit it. */
  sessionKey?: string;
  /** Internal one-shot durable session bucket; normal CLI callers should omit it. */
  sessionType?: string;
  /** Internal jobs can disable transcript-derived long-term memory finalization. */
  finalizeMemory?: boolean;
}
