import { after, afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRoleAwareToolManager } from '../src/capabilities/tools/create-tool-manager';
import { AgentSession } from '../src/runtime/sessions/agent-session';
import { SkillManager } from '../src/capabilities/skills/skill-manager';
import { ChatResponse, Message } from '../src/runtime/contracts';
import { ToolDefinition } from '../src/runtime/contracts/tool';
import { Logger } from '../src/runtime/observability/logger';
import { RoleResolver } from '../src/capabilities/roles/role-resolver';

const originalCwd = process.cwd();
const originalAppRoot = process.env.XIAOBA_APP_ROOT;
const originalRolesRoot = process.env.XIAOBA_ROLES_ROOT;
const originalRole = process.env.XIAOBA_ROLE;
const originalCurrentRole = process.env.CURRENT_ROLE;
const originalCurrentRoleDisplayName = process.env.CURRENT_ROLE_DISPLAY_NAME;
const describeResearcherLiveRole = fs.existsSync(path.join(process.cwd(), 'roles', 'researcher-cat', 'role.json'))
  ? describe
  : describe.skip;

class LiveResearcherAIService {
  requests: Array<{ messages: Message[]; toolNames: string[] }> = [];

  async chatStream(messages: Message[], tools: ToolDefinition[]): Promise<ChatResponse> {
    this.requests.push({
      messages: messages.map(message => ({ ...message })),
      toolNames: tools.map(tool => tool.name),
    });

    if (this.requests.length === 1) {
      return {
        content: '我先把这个项目恢复成 Research Board，再继续判断证据。',
        toolCalls: [
          {
            id: 'research-board-live-update',
            type: 'function',
            function: {
              name: 'research_board_update',
              arguments: JSON.stringify({
                project: 'Live Rice EPT',
                task_type: 'state_recovery',
                goal: 'recover EPT experiment state before manuscript sync',
                current_storyline: 'DTS may improve early rice prediction, but the result still needs seed aggregation.',
                claim_board: [
                  {
                    claim: 'DTS improves Rice F1 at T=12.',
                    status: 'unsupported',
                    evidence: ['metrics/seed-42.json'],
                  },
                ],
                evidence_board: [
                  'Only seed 42 is visible; seed inventory is incomplete.',
                ],
                experiment_queue: [
                  {
                    text: 'Run missing seeds 123 and 2026 before manuscript sync.',
                    status: 'planned',
                  },
                ],
                artifact_board: [
                  {
                    path: 'reports/rice-ept-live.md',
                    type: 'report',
                    status: 'planned',
                    note: 'Draft report should cite the seed inventory.',
                  },
                ],
                risk_board: [
                  {
                    text: 'Single-seed result cannot support submission claim.',
                    status: 'unsupported',
                  },
                ],
                handoffs: [
                  {
                    target_role: 'reviewer-cat',
                    reason: 'Verify seed aggregation before accepting the manuscript claim.',
                    status: 'planned',
                    evidence: ['metrics/seed-42.json'],
                  },
                ],
                next_actions: [
                  'Build seed inventory',
                  'Run missing seeds',
                ],
                run_registry: [
                  {
                    run_id: 'dts-seed-42',
                    method: 'DTS',
                    split: 'year-out',
                    seed: '42',
                    status: 'completed',
                    log_path: 'logs/dts-seed-42.log',
                    output_path: 'metrics/seed-42.json',
                    manuscript_target: 'Table 2',
                  },
                ],
              }),
            },
          },
        ],
        usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
      };
    }

    return {
      content: 'Research Board 已更新；当前结论仍是 unsupported，下一步先补 seed inventory 和缺失 seeds。',
      usage: { promptTokens: 80, completionTokens: 15, totalTokens: 95 },
    };
  }

  async chat(messages: Message[], tools: ToolDefinition[]): Promise<ChatResponse> {
    return this.chatStream(messages, tools);
  }
}

describeResearcherLiveRole('ResearcherCat live AgentSession board smoke', () => {
  let testRoot: string;

  beforeEach(() => {
    RoleResolver.clearActiveRole();
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-researcher-live-'));
    process.chdir(testRoot);
    process.env.XIAOBA_APP_ROOT = originalCwd;
    delete process.env.XIAOBA_ROLES_ROOT;
    Logger.setSilentMode(true);
  });

  afterEach(() => {
    Logger.setSilentMode(false);
    process.chdir(originalCwd);
    fs.rmSync(testRoot, { recursive: true, force: true });
    RoleResolver.clearActiveRole();
  });

  after(() => {
    process.chdir(originalCwd);
    restoreEnv('XIAOBA_APP_ROOT', originalAppRoot);
    restoreEnv('XIAOBA_ROLES_ROOT', originalRolesRoot);
    restoreEnv('XIAOBA_ROLE', originalRole);
    restoreEnv('CURRENT_ROLE', originalCurrentRole);
    restoreEnv('CURRENT_ROLE_DISPLAY_NAME', originalCurrentRoleDisplayName);
  });

  test('loads ResearcherCat prompt and executes real board update tool through AgentSession', async () => {
    const aiService = new LiveResearcherAIService();
    const toolManager = createRoleAwareToolManager(
      testRoot,
      {
        roleName: 'researcher-cat',
        runId: 'researcher-live-001',
      },
      'researcher-cat',
    );
    const session = new AgentSession('cli:researcher-live', {
      aiService: aiService as any,
      toolManager,
      skillManager: new SkillManager('researcher-cat'),
      roleName: 'researcher-cat',
    }, 'cli');

    const result = await session.handleMessage('继续 Rice EPT 项目，先恢复研究状态再告诉我下一步。', {
      surface: 'cli',
    });

    assert.equal(result.visibleToUser, true);
    assert.match(result.text, /Research Board 已更新/);
    assert.equal(aiService.requests.length, 2);

    const firstRequest = aiService.requests[0];
    assert.ok(firstRequest.toolNames.includes('auto_research_run'));
    assert.ok(firstRequest.toolNames.includes('research_board_update'));
    assert.ok(firstRequest.toolNames.includes('research_board_read'));
    const systemPrompt = firstRequest.messages
      .filter(message => message.role === 'system')
      .map(message => String(message.content || ''))
      .join('\n');
    assert.match(systemPrompt, /ResearcherCat/);
    assert.match(systemPrompt, /auto_research_run/);
    assert.match(systemPrompt, /research_board_update/);
    assert.match(systemPrompt, /research_board_read/);

    const boardPath = path.join(testRoot, 'data', 'researcher-cat', 'boards', 'live-rice-ept', 'board.json');
    const eventsPath = path.join(testRoot, 'data', 'researcher-cat', 'boards', 'live-rice-ept', 'events.jsonl');
    const markdownPath = path.join(testRoot, 'output', 'researcher-cat', 'boards', 'live-rice-ept', 'research-board.md');
    assert.ok(fs.existsSync(boardPath));
    assert.ok(fs.existsSync(eventsPath));
    assert.ok(fs.existsSync(markdownPath));

    const board = JSON.parse(fs.readFileSync(boardPath, 'utf-8'));
    assert.equal(board.project, 'Live Rice EPT');
    assert.equal(board.project_goal, 'recover EPT experiment state before manuscript sync');
    assert.equal(board.claim_board[0].status, 'unsupported');
    assert.equal(board.run_registry[0].id, 'dts-seed-42');
    assert.equal(board.next_actions[0].text, 'Build seed inventory');
    assert.equal(board.handoffs[0].target_role, 'reviewer-cat');

    const markdown = fs.readFileSync(markdownPath, 'utf-8');
    assert.match(markdown, /DTS improves Rice F1 at T=12/);
    assert.match(markdown, /Run Registry/);

    const events = fs.readFileSync(eventsPath, 'utf-8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(events.length, 1);
    assert.equal(events[0].event_type, 'research_board_update');

    const sessionLogFiles = collectFiles(path.join(testRoot, 'logs', 'sessions', 'cli')).filter(file => path.basename(file) === 'traces.jsonl');
    assert.equal(sessionLogFiles.length, 1);
    const sessionEntries = fs.readFileSync(sessionLogFiles[0], 'utf-8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line));
    const turn = sessionEntries.find(entry => entry.entry_type === 'trace' || entry.entry_type === 'turn');
    assert.ok(turn);
    assert.equal(turn.assistant.tool_calls[0].name, 'research_board_update');
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

function collectFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const result: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      result.push(...collectFiles(fullPath));
    } else {
      result.push(fullPath);
    }
  }
  return result;
}
