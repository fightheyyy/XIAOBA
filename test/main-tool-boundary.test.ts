import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRoleAwareToolManager } from '../src/capabilities/tools/create-tool-manager';
import { createSubAgentToolExecutor } from '../src/runtime/subagents/sub-agent-session';
import { AgentSession } from '../src/runtime/sessions/agent-session';
import { SkillManager } from '../src/capabilities/skills/skill-manager';
import { McpAppsConnector } from '../src/connectors/mcp-apps';
import { AgentConnectorService } from '../src/connectors/service';
import { createConnectorTools } from '../src/capabilities/tools/connector-tools';
import type { ToolDefinition, ToolExecutionContext } from '../src/runtime/contracts/tool';

const executionTools = ['write_file', 'edit_file', 'glob', 'grep', 'execute_shell'];
const call = (name: string) => ({ id: name, type: 'function' as const, function: { name, arguments: '{}' } });
const mainContext: Partial<ToolExecutionContext> = {
  roleName: 'base', sessionId: 'chat:main', surface: 'pet',
  channel: { chatId: 'chat:main', reply: async () => {}, sendFile: async () => {}, sendUI: async () => {} },
};

describe('Main tool boundary', () => {
  const originalCwd = process.cwd();
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-main-tools-'));
    process.chdir(root);
  });
  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('Main exposes conversation and child controls, rejecting hidden execution even through aliases', async () => {
    const manager = createRoleAwareToolManager(root, {}, 'base');
    const names = manager.getToolDefinitions(mainContext).map(tool => tool.name);
    for (const name of ['read_file', 'send_text', 'send_file', 'send_ui', 'spawn_subagent',
      'check_subagent', 'steer_subagent', 'resume_subagent', 'stop_subagent', 'schedule_reminder']) {
      assert.ok(names.includes(name), name);
    }
    for (const name of [...executionTools, 'ask_parent', 'skill']) {
      assert.ok(!names.includes(name), name);
      assert.equal((await manager.executeTool(call(name), [], mainContext)).status, 'blocked', name);
    }
    for (const alias of ['Bash', 'Write', 'Edit']) {
      assert.equal((await manager.executeTool(call(alias), [], mainContext)).status, 'blocked', alias);
    }
    // Stale active-Skill metadata cannot reopen tools after the installed snapshot is empty.
    assert.equal((await manager.executeTool(call('execute_shell'), [], {
      ...mainContext, activeSkillName: 'removed', availableSkillNames: [],
    })).status, 'blocked');
  });

  test('a no-role child retains a complete execution harness without Main controls', () => {
    const child = createSubAgentToolExecutor(root, 'worker', undefined, { parentSessionId: 'chat:main' });
    const names = child.getToolDefinitions().map(tool => tool.name);
    for (const name of [...executionTools, 'read_file', 'ask_parent']) assert.ok(names.includes(name), name);
    for (const name of ['spawn_subagent', 'steer_subagent', 'send_text', 'send_ui']) assert.ok(!names.includes(name), name);
  });

  test('installed Skill activation opens execution only while the real Session still has that Skill', async () => {
    const manager = createRoleAwareToolManager(root, {}, 'base');
    const requests: string[][] = [];
    const ai = { chatStream: async (_messages: unknown, tools: ToolDefinition[]) => {
      requests.push(tools.map(tool => tool.name));
      return { content: 'handled' };
    } };
    const session = new AgentSession('chat:skill-boundary', {
      aiService: ai as any, toolManager: manager, skillManager: new SkillManager('base'), roleName: 'base',
    });
    try {
      await session.handleMessage('hello');
      assert.ok(!requests[0].includes('skill'));
      const directory = path.join(root, 'skills', 'local-audit');
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, 'SKILL.md'), '---\nname: local-audit\ndescription: Read a local report\n---\nInspect the report.');
      await session.handleMessage('hello again');
      assert.ok(requests[1].includes('skill'));
      for (const name of executionTools) assert.ok(!requests[1].includes(name), name);
      assert.equal(await session.activateSkill('local-audit'), true);
      await session.handleMessage('continue');
      for (const name of executionTools) assert.ok(requests[2].includes(name), name);
      assert.ok(!requests[2].includes('ask_parent'));
      fs.rmSync(directory, { recursive: true });
      await session.handleMessage('continue after removal');
      for (const name of [...executionTools, 'skill']) assert.ok(!requests[3].includes(name), name);
    } finally { await session.cleanup({ finalizeMemory: false, checkWakeup: false }); }
  });

  test('app discovery follows configured connections and remains unavailable to children', async () => {
    const service = new AgentConnectorService(root, { environment: { XIAOBA_GITHUB_TOKEN: 'test-only' } });
    service.config.configure('github', false);
    const manager = createRoleAwareToolManager(root, {}, 'base');
    for (const tool of createConnectorTools(service)) manager.registerTool(tool, 'base');
    assert.ok(!manager.getToolDefinitions(mainContext).some(tool => tool.name === 'connector_describe'));
    assert.equal((await manager.executeTool(call('connector_describe'), [], mainContext)).status, 'blocked');
    service.config.configure('github', true);
    assert.ok(manager.getToolDefinitions(mainContext).some(tool => tool.name === 'connector_describe'));
    const result = await manager.executeTool(call('connector_describe'), [], mainContext);
    assert.equal(result.status, 'success');
    assert.ok(!JSON.stringify(result).includes('test-only'));
    assert.ok(!manager.getToolDefinitions({ ...mainContext, parentSessionId: 'parent' }).some(tool => tool.name === 'connector_describe'));
  });

  test('MCP discovery is local and empty, malformed or child configurations never open a client', async () => {
    const environment = { XIAOBA_MCP_SERVERS: '{}' };
    let connections = 0;
    const mcp = new McpAppsConnector({ environment, clientFactory: async () => { connections++; throw new Error('must not connect'); } });
    const manager = createRoleAwareToolManager(root, {}, 'base');
    for (const tool of mcp.createTools()) manager.registerTool(tool, 'surface');
    const names = (context = mainContext) => manager.getToolDefinitions(context).map(tool => tool.name);
    for (const name of ['mcp_list', 'mcp_read', 'mcp_write']) {
      assert.ok(!names().includes(name));
      assert.equal((await manager.executeTool(call(name), [], mainContext)).status, 'blocked');
    }
    environment.XIAOBA_MCP_SERVERS = JSON.stringify({ local: { url: 'http://127.0.0.1:9876/mcp' } });
    assert.ok(names().includes('mcp_list'));
    assert.ok(names().includes('mcp_read'));
    assert.ok(!names().includes('mcp_write')); // Still gated by explicit action confirmation.
    assert.ok(!names({ ...mainContext, parentSessionId: 'parent' }).includes('mcp_read'));
    environment.XIAOBA_MCP_SERVERS = '{broken';
    assert.ok(!names().includes('mcp_list'));
    assert.equal(connections, 0);
    await mcp.close();
  });
});
