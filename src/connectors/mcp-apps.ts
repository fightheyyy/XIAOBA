import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { randomUUID } from 'node:crypto';
import type { Tool, ToolExecutionContext } from '../runtime/contracts/tool';
import { toolBlocked, toolFailure, toolSuccess } from '../runtime/contracts/tool-result';

export interface McpServerConfig { url: string; tokenEnv?: string; allowedTools?: string[] }
export interface McpClient {
  listTools(params?: any, options?: any): Promise<any>;
  callTool(params: any, schema?: any, options?: any): Promise<any>;
  readResource(params: any, options?: any): Promise<any>;
  close(): Promise<void>;
}
export interface McpAppReference {
  kind: 'mcp'; appId: string; server: string; resourceUri: string; tool: string;
  title: string; arguments: Record<string, unknown>; result: any;
}
const MIME = 'text/html;profile=mcp-app';
const object = (value: any) => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const uiMeta = (tool: any) => tool._meta?.ui || {};

/** Deterministic MCP transport and app-resource ownership. Never an Agent loop. */
export class McpAppsConnector {
  private clients = new Map<string, Promise<McpClient>>();
  private apps = new Map<string, { threadId: string; reference: McpAppReference }>();
  constructor(private options: {
    environment?: NodeJS.ProcessEnv;
    clientFactory?: (server: string, config: McpServerConfig) => Promise<McpClient>;
  } = {}) {}

  config(): Record<string, McpServerConfig> {
    const value = JSON.parse((this.options.environment || process.env).XIAOBA_MCP_SERVERS || '{}');
    if (!object(value) || Object.keys(value).length > 12) throw new Error('Invalid XIAOBA_MCP_SERVERS');
    for (const [name, config] of Object.entries(value) as [string, any][]) {
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name) || !object(config) || typeof config.url !== 'string' || config.url.length > 2048
        || Object.keys(config).some(key => !['url', 'tokenEnv', 'allowedTools'].includes(key))) throw new Error('Invalid MCP server configuration');
      const url = new URL(config.url);
      if (url.username || url.password || url.hash || !(url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('MCP requires HTTPS or loopback HTTP');
      if (config.tokenEnv && !/^[A-Z_][A-Z0-9_]*$/.test(config.tokenEnv)) throw new Error('Invalid MCP token environment key');
      if (config.allowedTools !== undefined && (!Array.isArray(config.allowedTools) || config.allowedTools.some((name: any) => typeof name !== 'string'))) throw new Error('Invalid MCP tools allowlist');
    }
    return value;
  }
  private async client(server: string): Promise<McpClient> {
    const config = this.config()[server];
    if (!config) throw new Error('MCP server is not configured');
    const token = config.tokenEnv ? (this.options.environment || process.env)[config.tokenEnv] : undefined;
    if (config.tokenEnv && !token) throw new Error('MCP credential is unavailable');
    const key = JSON.stringify([server, config, token]);
    let pending = this.clients.get(key);
    if (!pending) {
      pending = this.options.clientFactory ? this.options.clientFactory(server, config) : (async () => {
        const client = new Client({ name: 'XiaoBa', version: '0.2.2' }, { capabilities: { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: [MIME] } } } as any });
        const transport = new StreamableHTTPClientTransport(new URL(config.url), {
          requestInit: { redirect: 'error', ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}) },
          fetch: (url, init) => fetch(url, { ...init, redirect: 'error', signal: init?.signal || AbortSignal.timeout(30_000) }),
        });
        await client.connect(transport);
        return client;
      })();
      this.clients.set(key, pending);
      pending.catch(() => this.clients.delete(key));
    }
    return pending;
  }
  private clean(value: any): any {
    let serialized = JSON.stringify(value);
    for (const config of Object.values(this.config())) {
      const secret = config.tokenEnv ? (this.options.environment || process.env)[config.tokenEnv] : undefined;
      if (secret) serialized = serialized.split(secret).join('<redacted>');
    }
    if (serialized.length > 512_000) throw new Error('MCP result limit exceeded');
    return JSON.parse(serialized);
  }
  async tools(server: string, audience: 'model' | 'app' = 'model'): Promise<any[]> {
    const client = await this.client(server), tools: any[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const result = await client.listTools(cursor ? { cursor } : {}, { timeout: 30_000 });
      tools.push(...result.tools);
      cursor = result.nextCursor;
      if (!cursor) break;
      if (page === 9) throw new Error('MCP tool pagination limit exceeded');
    }
    const allowed = this.config()[server].allowedTools;
    return tools.filter(tool => (!allowed || allowed.includes(tool.name)) && (!uiMeta(tool).visibility || uiMeta(tool).visibility.includes(audience)));
  }
  async list(): Promise<any[]> {
    return Promise.all(Object.keys(this.config()).map(async server => ({ server, tools: this.clean(await this.tools(server)) })));
  }
  async invoke(server: string, name: string, args: any, context: ToolExecutionContext, write = false): Promise<any> {
    if (!object(args) || JSON.stringify(args).length > 64_000) throw new Error('Invalid MCP arguments');
    const tool = (await this.tools(server)).find(tool => tool.name === name);
    if (!tool) throw new Error('MCP tool is not available');
    const readOnly = tool.annotations?.readOnlyHint === true && tool.annotations?.destructiveHint !== true;
    if (!readOnly && !write) throw new Error('MCP write requires mcp_write and explicit confirmation');
    const result = this.clean(await (await this.client(server)).callTool({ name, arguments: args }, undefined, { signal: context.abortSignal, timeout: 60_000 }));
    const resourceUri = uiMeta(tool).resourceUri || tool._meta?.['ui/resourceUri'];
    if (!result.isError && typeof resourceUri === 'string' && resourceUri.startsWith('ui://') && context.channel?.sendUI && context.sessionId) {
      const reference: McpAppReference = { kind: 'mcp', appId: randomUUID(), server, resourceUri, tool: name, title: tool.title || tool.name, arguments: this.clean(args), result };
      this.restore(context.sessionId, reference);
      await context.channel.sendUI(reference as unknown as Record<string, unknown>);
    }
    // Private app metadata belongs to the view, never to model context.
    const { _meta, ...modelResult } = result;
    return modelResult;
  }
  restore(threadId: string, reference: McpAppReference): void {
    if (reference.kind === 'mcp' && typeof reference.appId === 'string' && reference.resourceUri?.startsWith('ui://')) this.apps.set(reference.appId, { threadId, reference });
  }
  private app(threadId: string, appId: string): McpAppReference {
    const app = this.apps.get(appId);
    if (!app || app.threadId !== threadId || !this.config()[app.reference.server]) throw new Error('MCP app does not belong to this session');
    return app.reference;
  }
  async document(threadId: string, appId: string): Promise<{ html: string; csp: string }> {
    const app = this.app(threadId, appId), client = await this.client(app.server);
    const result = await client.readResource({ uri: app.resourceUri }, { timeout: 30_000 });
    const item = result.contents?.find((item: any) => item.uri === app.resourceUri && item.mimeType === MIME);
    if (!item) throw new Error('MCP App HTML resource missing');
    const html = typeof item.text === 'string' ? item.text : typeof item.blob === 'string' ? Buffer.from(item.blob, 'base64').toString('utf8') : '';
    if (!html || Buffer.byteLength(html) > 2_000_000) throw new Error('MCP App document limit exceeded');
    const declared = item._meta?.ui?.csp || {};
    const domains = (key: string): string => {
      if (declared[key] === undefined) return '';
      if (!Array.isArray(declared[key]) || declared[key].length > 30) throw new Error('Invalid MCP CSP');
      return declared[key].map((domain: any) => {
        if (typeof domain !== 'string') throw new Error('Invalid MCP CSP origin');
        const url = new URL(domain);
        if (url.origin !== domain || url.protocol !== 'https:') throw new Error('MCP CSP requires explicit HTTPS origins');
        return url.origin;
      }).join(' ');
    };
    const resources = domains('resourceDomains'), connections = domains('connectDomains');
    return { html, csp: `sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' ${resources}; style-src 'unsafe-inline' ${resources}; img-src data: ${resources}; font-src ${resources || "'none'"}; media-src ${resources || "'none'"}; connect-src ${connections || "'none'"}; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'` };
  }
  async appRequest(threadId: string, appId: string, method: string, params: any): Promise<any> {
    const app = this.app(threadId, appId);
    if (method === 'initial') return { arguments: app.arguments, result: app.result };
    if (method !== 'tools/call') throw new Error('Unsupported MCP App request');
    const tool = (await this.tools(app.server, 'app')).find(tool => tool.name === params?.name);
    if (!tool || tool.annotations?.readOnlyHint !== true || tool.annotations?.destructiveHint === true) throw new Error('此操作需要交由 XiaoBa 确认后执行。');
    if (!object(params.arguments || {}) || JSON.stringify(params).length > 64_000) throw new Error('Invalid MCP App arguments');
    return this.clean(await (await this.client(app.server)).callTool({ name: tool.name, arguments: params.arguments || {} }, undefined, { timeout: 30_000 }));
  }
  createTools(): Tool[] {
    const tools: Tool[] = [{
      definition: { name: 'mcp_list', description: '列出已配置的 MCP 服务器和模型可用工具（含参数 schema 与 UI 声明）。', parameters: { type: 'object', properties: {} } },
      execute: async () => { try { return toolSuccess(JSON.stringify(await this.list())); } catch { return toolFailure('MCP discovery failed. Check server configuration.', 'MCP_DISCOVERY_FAILED'); } },
    }];
    for (const write of [false, true]) tools.push({
      definition: { name: write ? 'mcp_write' : 'mcp_read', description: write ? '执行用户已明确确认的 MCP 写操作。先用 send_text 展示 server、tool、arguments 完整 JSON 提案，等待用户确认。' : '调用标记为只读的 MCP 工具；有 UI 声明时自动嵌入当前对话。先 mcp_list 取得工具 schema。',
        ...(write ? { requiresConfirmation: true, confirmationPayloadKeys: ['server', 'tool', 'arguments'] } : {}),
        parameters: { type: 'object', properties: { server: { type: 'string' }, tool: { type: 'string' }, arguments: { type: 'object' }, ...(write ? { confirmed: { type: 'boolean' } } : {}) }, required: ['server', 'tool', 'arguments'] } },
      execute: async (args, context) => {
        if (!context.channel?.sendUI || context.parentSessionId) return toolBlocked('Main Chat session required', 'MCP_FORBIDDEN', 'MCP Apps require the owning Main Chat session.');
        try {
          let delivered = false;
          const result = await this.invoke(args.server, args.tool, args.arguments, { ...context, channel: { ...context.channel!, sendUI: async content => { await context.channel!.sendUI!(content); delivered = true; } } }, write);
          return result.isError ? toolFailure(JSON.stringify(result), 'MCP_TOOL_ERROR') : toolSuccess(JSON.stringify(result), delivered ? { deliveryEvidence: [{ delivery_type: 'ui', status: 'delivered', surface: context.surface, timestamp: new Date().toISOString() }] } : {});
        }
        catch { return toolFailure('MCP request failed or was denied. Check server, tool, schema and write confirmation.', 'MCP_REQUEST_FAILED'); }
      },
    });
    return tools;
  }
  async close(): Promise<void> {
    await Promise.allSettled([...this.clients.values()].map(async client => (await client).close()));
    this.clients.clear(); this.apps.clear();
  }
}
