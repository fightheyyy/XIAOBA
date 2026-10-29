import express from 'express';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { DashboardChatChannel } from '../../src/surfaces/dashboard/chat-channel';
import { McpAppsConnector } from '../../src/connectors/mcp-apps';
import { createRoleAwareToolManager } from '../../src/capabilities/tools/create-tool-manager';
import { SkillManager } from '../../src/capabilities/skills/skill-manager';
import { resetConversationJournalForTests } from '../../src/runtime/delivery/conversation-journal';
import { CATALOG_ID, A2UI_VERSION } from '../../src/surfaces/dashboard/a2ui';

export function formMessages() {
  return [
    { version: A2UI_VERSION, createSurface: { surfaceId: 'scope', catalogId: CATALOG_ID, sendDataModel: true } },
    { version: A2UI_VERSION, updateComponents: { surfaceId: 'scope', components: [
      { id: 'root', component: 'Column', children: ['form', 'metrics'] },
      { id: 'form', component: 'Card', title: '分析范围', child: 'fields' },
      { id: 'fields', component: 'Row', children: ['project', 'period', 'submit'] },
      { id: 'project', component: 'TextField', label: '项目', value: { path: '/project' }, required: true },
      { id: 'period', component: 'ChoicePicker', label: '时间', value: { path: '/period' }, options: [{ label: '本周', value: 'week' }, { label: '本月', value: 'month' }] },
      { id: 'submit', component: 'Button', text: '更新分析', action: { event: { name: 'update_scope', context: { project: { path: '/project' }, period: { path: '/period' } } } } },
      { id: 'metrics', component: 'Card', title: '本周概览', child: 'numbers' },
      { id: 'numbers', component: 'Row', children: ['done', 'active', 'review'] },
      { id: 'done', component: 'Metric', label: '项完成', value: '12' },
      { id: 'active', component: 'Metric', label: '项进行中', value: '4' },
      { id: 'review', component: 'Metric', label: '项待确认', value: '2' },
    ] } },
    { version: A2UI_VERSION, updateDataModel: { surfaceId: 'scope', value: { project: 'xiaobaOS', period: 'week' } } },
  ];
}
const call = (name: string, args: any) => ({ content: null, toolCalls: [{ id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
export class ChatFixtureAI {
  requests: any[] = [];
  private steps = new Map<string, number>();
  async chatStream(messages: any[], tools: any[] = []) {
    this.requests.push({ messages: structuredClone(messages), tools });
    const text = String([...messages].reverse().find(message => message.role === 'user')?.content || '');
    const step = this.steps.get(text) || 0; this.steps.set(text, step + 1);
    if (text.startsWith('界面操作')) return step === 0 ? call('send_text', { text: '范围已更新，我会按你提交的项目与时间继续分析。' }) : { content: 'done' };
    if (text.startsWith('[子智能体')) return step === 0 ? call('send_text', { text: '检查已经完成，关键结论已核对。' }) : { content: 'done' };
    if (step === 0) return call('send_text', { text: '我来整理项目资料，并核对关键结论。你可以在下面调整分析范围。' });
    if (step === 1) return call('send_ui', { messages: formMessages() });
    if (step === 2) return call('mcp_read', { server: 'projects', tool: 'project_progress', arguments: {} });
    if (step === 3) return call('spawn_subagent', { task_description: '核对项目进展', user_message: '核对资料并返回结论，不向用户直接发送消息。' });
    if (step === 4) return call('send_text', { text: '当前进展已整理好，后台核验仍在继续。你可以调整范围，或继续告诉我下一步。' });
    return { content: 'hidden provider final' };
  }
  chat(messages: any[], tools: any[]) { return this.chatStream(messages, tools); }
}

export async function createChatFixture(prepareRoot?: (root: string) => void) {
  const originalCwd = process.cwd(), root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-intelligent-chat-'));
  process.chdir(root);
  prepareRoot?.(root);
  fs.mkdirSync(path.join(root, 'prompts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'prompts/system-prompt.md'), 'You are XiaoBa, the only user-facing Main Agent.');
  resetConversationJournalForTests({ workingDirectory: root, env: { XIAOBA_CONVERSATION_RECORDING_ENABLED: 'true' } });
  const counters = { reads: 0, writes: 0, resources: 0 };
  const appScript = await build({ stdin: { contents: `
    import { App } from '@modelcontextprotocol/ext-apps';
    const app = new App({name:'Progress',version:'1.0.0'});
    const render = result => { document.querySelector('#data').textContent = result.structuredContent?.label || '项目进度'; };
    app.ontoolresult = render;
    document.querySelector('#refresh').onclick = async () => { try { render(await app.callServerTool({name:'project_progress',arguments:{}})); } catch(error) {document.querySelector('#status').textContent=error.message;} };
    document.querySelector('#write').onclick = async () => { try { await app.callServerTool({name:'project_update',arguments:{}}); } catch(error) {document.querySelector('#status').textContent='写操作已被阻止';} };
    document.querySelector('#context').onclick = () => app.updateModelContext({structuredContent:{selectedModule:'Surface'}});
    await app.connect();
    const context = app.getHostContext();
    document.documentElement.dataset.hostTheme = context?.theme || '';
    for (const [name,value] of Object.entries(context?.styles?.variables || {})) if (typeof value === 'string') document.documentElement.style.setProperty(name,value);
  `, resolveDir: originalCwd }, bundle: true, format: 'esm', platform: 'browser', write: false });
  const html = `<!doctype html><html lang="zh"><meta charset="utf-8"><style>body{font:13px system-ui;color:#415266;margin:8px}h3{font-size:13px}p{font-size:12px;color:#7e8b99}.row{display:grid;grid-template-columns:70px 1fr 36px;gap:12px;align-items:center;margin:16px 0}.bar{height:8px;background:#edf1f6;border-radius:4px}.fill{height:8px;background:#9bbbe5;border-radius:4px}button{border:1px solid #dfe6ef;background:white;color:#67809b;border-radius:7px;padding:7px 10px;margin-right:6px;font-size:11px}</style><body><h3 id="data">项目进度</h3><div class="row">Surface<div class="bar"><div class="fill" style="width:80%"></div></div>80%</div><div class="row">Runtime<div class="bar"><div class="fill" style="width:65%"></div></div>65%</div><div class="row">Tools<div class="bar"><div class="fill" style="width:90%"></div></div>90%</div><button id="refresh">刷新数据</button><button id="context">选择 Surface</button><button id="write">写入测试</button><p id="status"></p><script type="module">${appScript.outputFiles[0].text.replace(/<\/script/gi, '<\\/script')}</script></body></html>`;
  const mcpServer = new McpServer({ name: 'Projects', version: '1.0.0' });
  mcpServer.registerTool('project_progress', { title: '项目进度', annotations: { readOnlyHint: true }, _meta: { ui: { resourceUri: 'ui://projects/progress' } } }, async () => {
    counters.reads++; return { content: [{ type: 'text', text: '12 completed, 4 active, 2 to review' }], structuredContent: { label: '项目进度', completed: 12, active: 4, review: 2 } };
  });
  mcpServer.registerTool('project_update', { annotations: { readOnlyHint: false, destructiveHint: true } }, async () => { counters.writes++; return { content: [{ type: 'text', text: 'updated' }] }; });
  mcpServer.registerResource('progress', 'ui://projects/progress', { mimeType: 'text/html;profile=mcp-app' }, async uri => {
    counters.resources++; return { contents: [{ uri: uri.href, mimeType: 'text/html;profile=mcp-app', text: html }] };
  });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
  await mcpServer.connect(transport);
  const mcpExpress = express(); mcpExpress.use(express.json()); mcpExpress.all('/mcp', async (req, res) => { await transport.handleRequest(req, res, req.body); });
  const mcpHttp = await new Promise<any>(resolve => { const server = mcpExpress.listen(0, '127.0.0.1', () => resolve(server)); });
  const mcp = new McpAppsConnector({ environment: { XIAOBA_MCP_SERVERS: JSON.stringify({ projects: { url: `http://127.0.0.1:${mcpHttp.address().port}/mcp` } }) } });
  const ai = new ChatFixtureAI(), toolManager = createRoleAwareToolManager(root, { roleName: 'base' }, 'base');
  toolManager.setContextDefaults({ subAgentServiceFactory: () => ({
    aiService: { chatStream: async () => { await new Promise(resolve => setTimeout(resolve, 300)); return { content: '资料核验完成，数据一致。' }; }, chat: async () => ({ content: '资料核验完成，数据一致。' }) },
    skillManager: new SkillManager('base'),
  }) });
  const channel = new DashboardChatChannel({ root, mcp, services: { aiService: ai as any, toolManager, skillManager: new SkillManager('base') } });
  const app = express(); app.use(express.json()); app.use('/api/chat', channel.router);
  app.get('/api/status', (_req, res) => res.json({ services: [], role: null }));
  app.get(['/api/skills', '/api/store', '/api/roles'], (_req, res) => res.json([])); app.get('/api/config', (_req, res) => res.json({}));
  app.get('/api/navigation/pending', (_req, res) => res.json({}));
  app.use(express.static(path.join(originalCwd, 'desktop/dashboard')));
  const server = await new Promise<any>(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
  return {
    root, ai, channel, counters, toolManager, url: `http://127.0.0.1:${server.address().port}`,
    async close() {
      await channel.destroy(); await mcpServer.close();
      server.closeAllConnections(); mcpHttp.closeAllConnections();
      await Promise.all([new Promise<void>(resolve => server.close(() => resolve())), new Promise<void>(resolve => mcpHttp.close(() => resolve()))]);
      process.chdir(originalCwd); resetConversationJournalForTests(); fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

export async function until(check: () => boolean | Promise<boolean>, timeout = 15_000) {
  const start = Date.now();
  while (!await check()) { if (Date.now() - start > timeout) throw new Error('Timed out waiting for fixture'); await new Promise(resolve => setTimeout(resolve, 25)); }
}
