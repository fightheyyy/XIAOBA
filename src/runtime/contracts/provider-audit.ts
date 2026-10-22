import type { ChatConfig, ChatResponse, Message } from './index';
import type { ToolDefinition } from './tool';

export type ProviderCallComponent = 'target' | 'usercat' | 'inspector' | 'reviewer' | 'replay';

export interface AuditedProviderCallInput {
  component?: ProviderCallComponent;
  scopeId?: string;
  provider: string;
  model: string;
  requestedOutputLimit: number;
  messages: Message[];
  tools?: ToolDefinition[];
  invoke: () => Promise<ChatResponse>;
}

/** An execution adapter can enforce accounting without owning the model loop. */
export interface ProviderAudit {
  enabled(): boolean;
  providerConfig(): Partial<ChatConfig> | undefined;
  invoke(input: AuditedProviderCallInput): Promise<ChatResponse>;
}
