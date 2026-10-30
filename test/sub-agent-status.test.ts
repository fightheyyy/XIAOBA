import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentSession } from '../src/runtime/sessions/agent-session';
import { SubAgentSession } from '../src/runtime/subagents/sub-agent-session';
import { SubAgentManager } from '../src/runtime/subagents/sub-agent-manager';
import { ToolManager } from '../src/capabilities/tools/tool-manager';
import { ChatResponse, Message, Skill } from '../src/runtime/contracts';
import { ToolDefinition } from '../src/runtime/contracts/tool';
import { AnalyzeLogTool } from '../src/capabilities/roles/inspector-cat/tools/analyze-log-tool';

const statusSkill: Skill = {
  metadata: {
    name: 'status-worker',
    description: 'Sub-agent status test skill',
    maxTurns: 3,
  },
  content: 'Status worker test skill.',
  filePath: path.join(process.cwd(), 'tests', 'fixtures', 'status-worker', 'SKILL.md'),
};

class FakeSkillManager {
  async loadSkills(): Promise<void> {}

  getSkill(name: string): Skill | undefined {
    return name === statusSkill.metadata.name ? statusSkill : undefined;
  }

  getAllSkills(): Skill[] {
    return [statusSkill];
  }

  getUserInvocableSkills(): Skill[] {
    return [statusSkill];
  }

  findAutoInvocableSkillByText(): undefined {
    return undefined;
  }
}

class ImmediateAIService {
  readonly requests: Array<{ messages: Message[]; tools: ToolDefinition[] }> = [];

  async chatStream(_messages: Message[], _tools: ToolDefinition[]): Promise<ChatResponse> {
    this.requests.push({ messages: _messages, tools: _tools });
    return { content: 'status worker completed' };
  }

  async chat(messages: Message[], tools: ToolDefinition[]): Promise<ChatResponse> {
    return this.chatStream(messages, tools);
  }
}

class ToolCallingAIService {
  private requestIndex = 0;

  async chatStream(_messages: Message[], _tools: ToolDefinition[]): Promise<ChatResponse> {
    if (this.requestIndex++ === 0) {
      return {
        content: null,
        toolCalls: [{
          id: 'abortable-analyze-log',
          type: 'function',
          function: {
            name: 'analyze_log',
            arguments: JSON.stringify({
              log_source: 'logs/sessions/runtime.log',
              analysis_depth: 'quick',
            }),
          },
        }],
      };
    }
    return { content: 'tool completed' };
  }

  async chat(messages: Message[], tools: ToolDefinition[]): Promise<ChatResponse> {
    return this.chatStream(messages, tools);
  }
}

class WriteFileAIService {
  private requestIndex = 0;

  async chatStream(_messages: Message[], _tools: ToolDefinition[]): Promise<ChatResponse> {
    if (this.requestIndex++ === 0) {
      return {
        content: null,
        toolCalls: [{
          id: 'write-subagent-artifact',
          type: 'function',
          function: {
            name: 'write_file',
            arguments: JSON.stringify({
              file_path: 'output/subagent-artifact.md',
              content: '# Subagent artifact\n',
            }),
          },
        }],
      };
    }
    return { content: 'artifact completed' };
  }

  async chat(messages: Message[], tools: ToolDefinition[]): Promise<ChatResponse> {
    return this.chatStream(messages, tools);
  }
}

class AskParentAIService {
  private requestIndex = 0;

  async chatStream(_messages: Message[], _tools: ToolDefinition[]): Promise<ChatResponse> {
    if (this.requestIndex++ === 0) {
      return {
        content: null,
        toolCalls: [{
          id: 'ask-parent-before-stop',
          type: 'function',
          function: {
            name: 'ask_parent',
            arguments: JSON.stringify({ question: 'Should this BrowserCat task continue?' }),
          },
        }],
      };
    }
    return { content: 'continued after parent input' };
  }

  async chat(messages: Message[], tools: ToolDefinition[]): Promise<ChatResponse> {
    return this.chatStream(messages, tools);
  }
}

class FailingAIService {
  async chatStream(): Promise<ChatResponse> {
    throw new Error('non-retryable status failure');
  }

  async chat(): Promise<ChatResponse> {
    return this.chatStream();
  }
}

class RetryBackoffAIService {
  requestCount = 0;
  private firstRequestSeen!: () => void;
  readonly firstRequestPromise = new Promise<void>(resolve => {
    this.firstRequestSeen = resolve;
  });

  async chatStream(): Promise<ChatResponse> {
    this.requestCount += 1;
    this.firstRequestSeen();
    throw new Error('429 retryable provider rate limit');
  }

  async chat(): Promise<ChatResponse> {
    return this.chatStream();
  }
}

class DeferredAIService {
  private requestSeen!: () => void;
  private responseReady!: (response: ChatResponse) => void;
  readonly requestPromise = new Promise<void>(resolve => {
    this.requestSeen = resolve;
  });
  private readonly responsePromise = new Promise<ChatResponse>(resolve => {
    this.responseReady = resolve;
  });

  async chatStream(_messages: Message[], _tools: ToolDefinition[]): Promise<ChatResponse> {
    this.requestSeen();
    return this.responsePromise;
  }

  async chat(messages: Message[], tools: ToolDefinition[]): Promise<ChatResponse> {
    return this.chatStream(messages, tools);
  }

  resolve(response: ChatResponse): void {
    this.responseReady(response);
  }
}

function createSession(aiService: unknown, id = `sub-status-${Math.random().toString(16).slice(2)}`): SubAgentSession {
  return new SubAgentSession(
    id,
    aiService as any,
    new FakeSkillManager() as any,
    {
      skillName: statusSkill.metadata.name,
      taskDescription: 'status test task',
      userMessage: 'run status test task',
      workingDirectory: process.cwd(),
      notifyParent: async () => undefined,
    },
  );
}

describe('SubAgentSession status lifecycle', () => {
  test('writes a terminal child trace with parent and role lineage', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-subagent-trace-'));
    const originalCwd = process.cwd();
    const originalAppRoot = process.env.XIAOBA_APP_ROOT;
    try {
      process.env.XIAOBA_APP_ROOT = originalCwd;
      process.chdir(root);
      const session = new SubAgentSession(
        'sub-trace-lineage',
        new ImmediateAIService() as any,
        new FakeSkillManager() as any,
        {
          skillName: statusSkill.metadata.name,
          taskDescription: 'trace lineage task',
          userMessage: 'run trace lineage task',
          workingDirectory: root,
          roleName: 'evolution-cat',
          parentSessionId: 'pet:xiaoba',
          notifyParent: async () => undefined,
        },
      );

      await session.run();
      const traceFiles = listFiles(path.join(root, 'logs')).filter(file => file.endsWith('traces.jsonl'));
      assert.equal(traceFiles.length, 1);
      const [entry] = fs.readFileSync(traceFiles[0], 'utf-8').trim().split('\n').map(line => JSON.parse(line));
      assert.equal(entry.session_type, 'subagent');
      assert.equal(entry.session_id, 'subagent:sub-trace-lineage');
      assert.equal(entry.user.text, 'run trace lineage task');
      const started = entry.events.find((event: any) => event.event_type === 'session_started');
      const completed = entry.events.find((event: any) => event.event_type === 'session_completed');
      assert.equal(started.parent_session_id, 'pet:xiaoba');
      assert.equal(started.role_name, 'evolution-cat');
      assert.equal(started.subagent_id, 'sub-trace-lineage');
      assert.equal(completed.status, 'success');
    } finally {
      process.chdir(originalCwd);
      if (originalAppRoot === undefined) {
        delete process.env.XIAOBA_APP_ROOT;
      } else {
        process.env.XIAOBA_APP_ROOT = originalAppRoot;
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('starts in running while background execution is in flight', async () => {
    const ai = new DeferredAIService();
    const session = createSession(ai);
    const run = session.run();

    await ai.requestPromise;

    assert.strictEqual(session.getInfo().status, 'running');

    ai.resolve({ content: 'status worker completed' });
    await run;
    assert.strictEqual(session.getInfo().status, 'completed');
  });

  test('moves to completed after a successful run', async () => {
    const session = createSession(new ImmediateAIService());

    await session.run();
    const info = session.getInfo();

    assert.strictEqual(info.status, 'completed');
    assert.strictEqual(info.resultSummary, 'status worker completed');
    assert.ok(info.completedAt);
  });

  test('captures the real tool result rather than the tool call id for output files', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-subagent-artifact-'));
    try {
      const session = new SubAgentSession(
        'sub-status-artifact-result',
        new WriteFileAIService() as any,
        new FakeSkillManager() as any,
        {
          skillName: statusSkill.metadata.name,
          taskDescription: 'write an artifact',
          userMessage: 'write the artifact',
          workingDirectory: root,
          notifyParent: async () => undefined,
        },
      );

      await session.run();
      const info = session.getInfo();
      assert.strictEqual(info.status, 'completed');
      assert.deepStrictEqual(info.outputFiles, ['output/subagent-artifact.md']);
      assert.strictEqual(fs.existsSync(path.join(root, 'output', 'subagent-artifact.md')), true);
      assert.strictEqual(info.outputFiles.includes('write-subagent-artifact'), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('role-only run lets sub-agent choose a role-local skill', async () => {
    const ai = new ImmediateAIService();
    const session = new SubAgentSession(
      'sub-status-role-only',
      ai as any,
      new FakeSkillManager() as any,
      {
        roleName: 'reviewer-cat',
        taskDescription: 'role-only status test task',
        userMessage: 'choose the best skill for this task',
        workingDirectory: process.cwd(),
        notifyParent: async () => undefined,
      },
    );

    await session.run();
    const info = session.getInfo();
    const request = ai.requests[0];

    assert.strictEqual(info.status, 'completed');
    assert.strictEqual(info.skillSelectionMode, 'subagent_decides');
    assert.ok(request.tools.some(tool => tool.name === 'skill'));
    assert.ok(request.messages.some(message => (
      message.role === 'system'
      && typeof message.content === 'string'
      && message.content.includes('[subagent-skill-selection]')
      && message.content.includes('status-worker')
    )));
  });

  test('no-skill run hides skill tool and executes directly', async () => {
    const ai = new ImmediateAIService();
    const session = new SubAgentSession(
      'sub-status-no-skill',
      ai as any,
      new FakeSkillManager() as any,
      {
        taskDescription: 'no-skill status test task',
        userMessage: 'run directly without a skill',
        workingDirectory: process.cwd(),
        notifyParent: async () => undefined,
      },
    );

    await session.run();
    const info = session.getInfo();
    const request = ai.requests[0];

    assert.strictEqual(info.status, 'completed');
    assert.strictEqual(info.skillSelectionMode, 'none');
    assert.strictEqual(request.tools.some(tool => tool.name === 'skill'), false);
    assert.ok(request.messages.some(message => (
      message.role === 'system'
      && typeof message.content === 'string'
      && message.content.includes('[subagent-no-skill]')
    )));
  });

  test('moves to failed after a non-retryable execution error', async () => {
    const session = createSession(new FailingAIService());

    await session.run();
    const info = session.getInfo();

    assert.strictEqual(info.status, 'failed');
    assert.match(info.resultSummary || '', /non-retryable status failure/);
    assert.ok(info.completedAt);
  });

  test('stays stopped when stopped during an in-flight run', async () => {
    const ai = new DeferredAIService();
    const session = createSession(ai);
    const run = session.run();

    await ai.requestPromise;
    session.stop();
    ai.resolve({ content: 'should not overwrite stopped' });
    await run;

    assert.strictEqual(session.getInfo().status, 'stopped');
  });

  test('stop interrupts retry backoff before another model request is sent', async () => {
    const ai = new RetryBackoffAIService();
    const session = createSession(ai);
    const run = session.run();

    await ai.firstRequestPromise;
    await new Promise(resolve => setTimeout(resolve, 0));
    session.stop();

    await Promise.race([
      run,
      new Promise((_, reject) => setTimeout(() => reject(new Error('retry backoff did not stop')), 500)),
    ]);
    assert.strictEqual(ai.requestCount, 1);
    assert.strictEqual(session.getInfo().status, 'stopped');
  });

  test('stop aborts the in-flight role tool and preserves trusted parent session context', async () => {
    const originalExecute = AnalyzeLogTool.prototype.execute;
    let toolStarted!: () => void;
    const started = new Promise<void>(resolve => {
      toolStarted = resolve;
    });
    let capturedContext: any;

    (AnalyzeLogTool.prototype as any).execute = async (_args: unknown, context: any) => {
      capturedContext = context;
      toolStarted();
      return new Promise<string>(resolve => {
        if (context.abortSignal?.aborted) {
          resolve('aborted');
          return;
        }
        context.abortSignal?.addEventListener('abort', () => resolve('aborted'), { once: true });
      });
    };

    try {
      const session = new SubAgentSession(
        'sub-status-abort-tool',
        new ToolCallingAIService() as any,
        new FakeSkillManager() as any,
        {
          skillName: statusSkill.metadata.name,
          roleName: 'inspector-cat',
          parentSessionId: 'cli-parent-session',
          taskDescription: 'abort an in-flight tool',
          userMessage: 'run the abortable tool',
          workingDirectory: process.cwd(),
          notifyParent: async () => undefined,
        },
      );

      const run = session.run();
      await started;

      assert.strictEqual(capturedContext.parentSessionId, 'cli-parent-session');
      assert.ok(capturedContext.abortSignal instanceof AbortSignal);
      assert.strictEqual(capturedContext.abortSignal.aborted, false);

      session.stop();
      assert.strictEqual(capturedContext.abortSignal.aborted, true);
      await run;

      assert.strictEqual(session.getInfo().status, 'stopped');
    } finally {
      AnalyzeLogTool.prototype.execute = originalExecute;
    }
  });

  test('moves to waiting_for_input and resumes to running', async () => {
    const session = createSession(new ImmediateAIService());
    const question = '需要主会话确认吗？';
    const wait = session.waitForParentInput(question);

    let info = session.getInfo();
    assert.strictEqual(info.status, 'waiting_for_input');
    assert.strictEqual(info.pendingQuestion, question);

    assert.strictEqual(session.resume('继续'), true);
    info = session.getInfo();
    assert.strictEqual(info.status, 'running');
    assert.strictEqual(info.pendingQuestion, undefined);
    await assert.doesNotReject(wait);
  });

  test('manager can stop a sub-agent while it is waiting for parent input', async () => {
    const manager = SubAgentManager.getInstance();
    const parentSessionKey = `waiting-stop-parent-${Math.random().toString(16).slice(2)}`;
    let parentWasNotified = false;
    manager.registerPlatformCallbacks(parentSessionKey, {
      injectMessage: async () => {
        parentWasNotified = true;
      },
    });

    const spawned = manager.spawn(
      parentSessionKey,
      undefined,
      'wait for parent before continuing',
      'ask the parent before continuing',
      process.cwd(),
      new AskParentAIService() as any,
      new FakeSkillManager() as any,
      { parentSessionId: parentSessionKey },
    );
    assert.ok(!('error' in spawned));
    if ('error' in spawned) return;

    await waitForStatus(manager, parentSessionKey, spawned.id, 'waiting_for_input');
    assert.strictEqual(parentWasNotified, true);
    assert.strictEqual(manager.stopForParent(parentSessionKey, spawned.id), 'stopped');
    assert.strictEqual(manager.getInfoForParent(parentSessionKey, spawned.id)?.status, 'stopped');
  });

  test('parent runtime state includes waiting tasks and their pending question', async () => {
    const manager = SubAgentManager.getInstance();
    const parentSessionKey = `waiting-context-parent-${Math.random().toString(16).slice(2)}`;
    manager.registerPlatformCallbacks(parentSessionKey, {
      injectMessage: async () => undefined,
    });
    const spawned = manager.spawn(
      parentSessionKey,
      undefined,
      'waiting context task',
      'ask the parent before continuing',
      process.cwd(),
      new AskParentAIService() as any,
      new FakeSkillManager() as any,
      { parentSessionId: parentSessionKey },
    );
    assert.ok(!('error' in spawned));
    if ('error' in spawned) return;
    await waitForStatus(manager, parentSessionKey, spawned.id, 'waiting_for_input');

    const parentAI = new ImmediateAIService();
    const parentSession = new AgentSession(parentSessionKey, {
      aiService: parentAI as any,
      toolManager: new ToolManager(process.cwd()),
      skillManager: new FakeSkillManager() as any,
    }, 'cli');
    await parentSession.handleMessage('show task status', { surface: 'cli' });

    const transient = parentAI.requests[0].messages.find(message => (
      message.__subagentState
      && typeof message.content === 'string'
      && message.content.startsWith('[subagent_state]')
    ));
    assert.ok(transient && typeof transient.content === 'string');
    assert.match(transient.content, /waiting context task/);
    assert.match(transient.content, /waiting_for_input/);
    assert.match(transient.content, /Should this BrowserCat task continue\?/);
    assert.doesNotMatch(transient.content, /waiting context task \(已停止\)/);

    assert.strictEqual(manager.stopForParent(parentSessionKey, spawned.id), 'stopped');
  });

  test('waiting sub-agents still consume concurrency slots and can be stopped through the public API', async () => {
    const manager = SubAgentManager.getInstance();
    const parentSessionKey = `waiting-limit-parent-${Math.random().toString(16).slice(2)}`;
    manager.registerPlatformCallbacks(parentSessionKey, {
      injectMessage: async () => undefined,
    });

    const spawnedIds: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const spawned = manager.spawn(
        parentSessionKey,
        undefined,
        `waiting task ${index + 1}`,
        'ask the parent before continuing',
        process.cwd(),
        new AskParentAIService() as any,
        new FakeSkillManager() as any,
        { parentSessionId: parentSessionKey },
      );
      assert.ok(!('error' in spawned));
      if ('error' in spawned) return;
      spawnedIds.push(spawned.id);
      await waitForStatus(manager, parentSessionKey, spawned.id, 'waiting_for_input');
    }

    const overflow = manager.spawn(
      parentSessionKey,
      undefined,
      'overflow waiting task',
      'this fourth active task must be rejected',
      process.cwd(),
      new AskParentAIService() as any,
      new FakeSkillManager() as any,
      { parentSessionId: parentSessionKey },
    );
    assert.ok('error' in overflow);
    if ('error' in overflow) {
      assert.match(overflow.error, /最多同时运行 3 个子任务/);
    }

    assert.strictEqual(manager.stop(spawnedIds[0]), true);
    assert.strictEqual(manager.getInfoForParent(parentSessionKey, spawnedIds[0])?.status, 'stopped');
    for (const subAgentId of spawnedIds.slice(1)) {
      assert.strictEqual(manager.stopForParent(parentSessionKey, subAgentId), 'stopped');
    }
  });
});

function listFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const entryPath = path.join(root, entry.name);
    return entry.isDirectory() ? listFiles(entryPath) : [entryPath];
  });
}

async function waitForStatus(
  manager: SubAgentManager,
  parentSessionKey: string,
  subAgentId: string,
  expected: string,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (manager.getInfoForParent(parentSessionKey, subAgentId)?.status === expected) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out waiting for sub-agent status ${expected}`);
}
