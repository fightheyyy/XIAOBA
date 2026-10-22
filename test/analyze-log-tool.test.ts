import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AnalyzeLogTool } from '../src/capabilities/roles/inspector-cat/tools/analyze-log-tool';

describe('AnalyzeLogTool runtime logs', () => {
  let testRoot: string;

  beforeEach(() => {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-analyze-log-'));
  });

  afterEach(() => {
    if (testRoot && fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  test('长 runtime log 中重复的 Turn 编号会按交互正确拆分，并提取 review 关键信号', async () => {
    const logPath = path.join(testRoot, 'runtime.log');
    const logContent = [
      '[2026-02-25 22:04:29.680] [INFO] 正在启动飞书机器人...',
      '[2026-02-25 22:05:58.704] [INFO] 新建飞书会话: user:ou_demo',
      '[2026-02-25 22:05:58.705] [INFO] [user:ou_demo] 收到消息: 在吗...',
      '[2026-02-25 22:05:58.727] [INFO] [Turn 1] 调用AI推理 (可用工具: 27个)',
      '[2026-02-25 22:06:03.134] [INFO] [Turn 1] AI返回 tokens: 10+5=15',
      '[2026-02-25 22:06:03.135] [INFO] [Turn 1] AI文本: Let me inspect the folder first.',
      '[2026-02-25 22:06:03.136] [INFO] [Turn 1] 执行工具: execute_shell | 参数: {"command":"find \\"E:/demo\\" -maxdepth 2 -type f | head -20"}',
      '[2026-02-25 22:06:03.461] [ERROR] ✗ 命令执行失败 (耗时: 70ms)',
      '[2026-02-25 22:06:03.462] [ERROR]   错误: Command failed: find "E:/demo" -maxdepth 2 -type f | head -20',
      "[2026-02-25 22:06:03.463] [INFO] [Turn 1] 工具完成: execute_shell | 耗时: 75ms | 结果: 命令执行失败: 'head' 不是内部或外部命令",
      '[2026-02-25 22:06:03.464] [WARN] [Turn 1] execute_shell 触发限流 (429)，5000ms 后重试 (1/2)',
      '[2026-02-25 22:06:03.778] [INFO] [Turn 2] 调用AI推理 (可用工具: 27个)',
      '[2026-02-25 22:06:06.206] [INFO] [Turn 2] AI返回 tokens: 10+1=11',
      '[2026-02-25 22:06:06.207] [INFO] [Turn 2] AI最终回复: (empty)',
      '[2026-02-25 22:06:06.208] [INFO] [Metrics] AI调用: 2次, tokens: 20+6=26, 工具调用: 1次, 工具耗时: 75ms',
      '[2026-02-25 22:08:39.642] [INFO] [user:ou_demo] 收到消息: 继续看一下 paper',
      '[2026-02-25 22:08:39.644] [INFO] [Turn 1] 调用AI推理 (可用工具: 27个)',
      '[2026-02-25 22:08:44.448] [INFO] [Turn 1] AI返回 tokens: 12+2=14',
      '[2026-02-25 22:08:44.449] [INFO] [Turn 1] 执行工具: read_file | 参数: {"file_path":"E:\\\\demo\\\\paper.pdf","pages":"1-3"}',
      '[2026-02-25 22:08:44.450] [INFO] [Turn 1] 工具完成: read_file | 耗时: 1ms | 结果: 执行被阻止: 读取路径超出工作目录。设置 XIAOBA_FS_ALLOW_OUTSIDE_READ=true 可解除限制',
      '[2026-02-25 22:08:44.451] [ERROR] API调用失败 | Provider: anthropic | Model: claude-opus-4-6 | Endpoint: primary',
      '[2026-02-25 22:08:44.452] [ERROR] [会话 user:ou_demo] 处理失败: 请求失败: Connection error.',
      '[2026-02-25 22:08:44.453] [ERROR] 飞书消息发送失败: getaddrinfo ENOTFOUND open.feishu.cn',
      '[2026-02-25 22:08:44.454] [INFO] [Metrics] AI调用: 1次, tokens: 12+2=14, 工具调用: 1次, 工具耗时: 1ms',
    ].join('\n');
    fs.writeFileSync(logPath, logContent, 'utf-8');

    const tool = new AnalyzeLogTool();
    const raw = await tool.execute(
      { log_source: logPath, analysis_depth: 'deep' },
      { workingDirectory: testRoot, conversationHistory: [] },
    );
    const result = JSON.parse(raw as string);

    assert.strictEqual(result.summary.totalTurns, 3);
    assert.strictEqual(result.summary.interactionCount, 2);
    assert.strictEqual(result.summary.totalTokens, 40);
    assert.strictEqual(result.summary.toolCalls, 2);
    assert.strictEqual(result.turns.length, 3);
    assert.deepStrictEqual(
      result.turns.map((turn: any) => [turn.interactionId, turn.turn]),
      [
        [1, 1],
        [1, 2],
        [2, 1],
      ],
    );

    const issueTypes = new Set(result.issues.map((issue: any) => issue.type));
    assert.ok(issueTypes.has('platform_command_mismatch'));
    assert.ok(issueTypes.has('rate_limited_retry'));
    assert.ok(issueTypes.has('empty_reply'));
    assert.ok(issueTypes.has('outside_read_blocked'));
    assert.ok(issueTypes.has('api_or_network_failure'));
    assert.strictEqual(result.summary.signalQuality, 'actionable');
    assert.match(result.summary.recommendedIntakeAction, /issue profile/);

    const secondInteractionTurn = result.turns.find((turn: any) => turn.interactionId === 2 && turn.turn === 1);
    assert.ok(secondInteractionTurn);
    assert.ok(secondInteractionTurn.issueTypes.includes('outside_read_blocked'));

    const platformProfile = result.issueProfiles.find((profile: any) => profile.issue_type === 'platform_command_mismatch');
    const boundaryProfile = result.issueProfiles.find((profile: any) => profile.issue_type === 'outside_read_blocked');
    assert.ok(platformProfile);
    assert.strictEqual(platformProfile.category, 'runtime_bug');
    assert.strictEqual(platformProfile.route_to_role, 'engineer-cat');
    assert.strictEqual(platformProfile.recommended_next_action, 'runtime_fix');
    assert.ok(platformProfile.evidence_refs.some((ref: string) => ref.startsWith('session:')));
    assert.ok(boundaryProfile);
    assert.strictEqual(boundaryProfile.category, 'tool_policy_boundary');
    assert.strictEqual(boundaryProfile.route_to_role, 'reviewer-cat');
    assert.strictEqual(boundaryProfile.recommended_next_action, 'review_boundary');

    const executeShell = result.toolStats.find((toolStat: any) => toolStat.name === 'execute_shell');
    const readFile = result.toolStats.find((toolStat: any) => toolStat.name === 'read_file');
    assert.ok(executeShell);
    assert.ok(readFile);
    assert.strictEqual(executeShell.failures, 1);
    assert.strictEqual(readFile.failures, 1);
  });

  test('能解析当前飞书 runtime 的 [user:xxx Turn n] 同 bracket 日志格式', async () => {
    const logPath = path.join(testRoot, 'feishu-inline-turn.log');
    const logContent = [
      '[2026-04-13 15:11:19.277] [INFO] 新建会话: user:ou_demo',
      '[2026-04-13 15:11:19.278] [INFO] [user:ou_demo] 收到消息: 把最近日志交给督察猫分析...',
      '[2026-04-13 15:11:19.293] [INFO] [user:ou_demo Turn 1] 调用AI推理 (可用工具: 14个)',
      '[2026-04-13 15:11:41.499] [INFO] [user:ou_demo Turn 1] AI返回 tokens: 4063+166=4229',
      '[2026-04-13 15:11:41.499] [INFO] [user:ou_demo Turn 1] 执行工具: send_to_inspector | 参数: {"analysis_type":"auto","user_request":"用户请求分析最近日志"}',
      '[2026-04-13 15:11:41.542] [INFO] [user:ou_demo Turn 1] 工具完成: send_to_inspector | 耗时: 43ms | 结果: 已上传 Inspector 诊断包。',
      '[2026-04-13 15:11:41.543] [INFO] [user:ou_demo Turn 2] 调用AI推理 (可用工具: 14个)',
      '[2026-04-13 15:11:45.231] [INFO] [user:ou_demo Turn 2] AI返回 tokens: 170+81=251',
      '[2026-04-13 15:11:45.231] [INFO] [user:ou_demo Turn 2] AI最终回复: 已交给督察猫分析',
      '[2026-04-13 15:11:46.739] [INFO] [Metrics] AI调用: 2次, tokens: 4233+247=4480, 工具调用: 1次, 工具耗时: 43ms',
    ].join('\n');
    fs.writeFileSync(logPath, logContent, 'utf-8');

    const tool = new AnalyzeLogTool();
    const raw = await tool.execute(
      { log_source: logPath, analysis_depth: 'deep' },
      { workingDirectory: testRoot, conversationHistory: [] },
    );
    const result = JSON.parse(raw as string);

    assert.strictEqual(result.summary.totalTurns, 2);
    assert.strictEqual(result.summary.interactionCount, 1);
    assert.strictEqual(result.summary.toolCalls, 1);
    assert.strictEqual(result.summary.signalQuality, 'actionable');
    assert.strictEqual(result.turns.length, 2);
    assert.strictEqual(result.turns[0].sessionId, 'user:ou_demo');
    assert.strictEqual(result.turns[0].tools[0].name, 'send_to_inspector');
  });

  test('deep 模式会对超长 runtime log 的 turns 输出做截断', async () => {
    const logPath = path.join(testRoot, 'long-runtime.log');
    const lines: string[] = [
      '[2026-02-25 22:04:29.680] [INFO] 新建飞书会话: user:ou_long',
      '[2026-02-25 22:04:29.681] [INFO] [user:ou_long] 收到消息: 做一次超长日志分析',
    ];
    const baseTime = new Date('2026-02-25T22:05:00.000');

    for (let turn = 1; turn <= 140; turn++) {
      const callTime = new Date(baseTime.getTime() + turn * 1000);
      const tokenTime = new Date(callTime.getTime() + 500);
      const callStamp = `${callTime.getFullYear()}-${String(callTime.getMonth() + 1).padStart(2, '0')}-${String(callTime.getDate()).padStart(2, '0')} ${String(callTime.getHours()).padStart(2, '0')}:${String(callTime.getMinutes()).padStart(2, '0')}:${String(callTime.getSeconds()).padStart(2, '0')}.${String(callTime.getMilliseconds()).padStart(3, '0')}`;
      const tokenStamp = `${tokenTime.getFullYear()}-${String(tokenTime.getMonth() + 1).padStart(2, '0')}-${String(tokenTime.getDate()).padStart(2, '0')} ${String(tokenTime.getHours()).padStart(2, '0')}:${String(tokenTime.getMinutes()).padStart(2, '0')}:${String(tokenTime.getSeconds()).padStart(2, '0')}.${String(tokenTime.getMilliseconds()).padStart(3, '0')}`;
      lines.push(`[${callStamp}] [INFO] [Turn ${turn}] 调用AI推理 (可用工具: 27个)`);
      lines.push(`[${tokenStamp}] [INFO] [Turn ${turn}] AI返回 tokens: 2+2=4`);
      lines.push(`[${tokenStamp}] [INFO] [Turn ${turn}] AI文本: turn-${turn}`);
    }
    lines.push('[2026-02-25 22:06:59.999] [INFO] [Metrics] AI调用: 140次, tokens: 280+280=560, 工具调用: 0次, 工具耗时: 0ms');

    fs.writeFileSync(logPath, lines.join('\n'), 'utf-8');

    const tool = new AnalyzeLogTool();
    const raw = await tool.execute(
      { log_source: logPath, analysis_depth: 'deep' },
      { workingDirectory: testRoot, conversationHistory: [] },
    );
    const result = JSON.parse(raw as string);

    assert.strictEqual(result.summary.totalTurns, 140);
    assert.strictEqual(result.summary.truncatedTurns, true);
    assert.ok(result.summary.returnedTurns <= 120);
    assert.ok(result.turns.length <= 120);
  });

  test('JSONL 会话日志也能重建 interaction、识别 runtime 问题并返回 deep turns', async () => {
    const logPath = path.join(testRoot, 'session.jsonl');
    const entries = [
      {
        turn: 1,
        timestamp: '2026-04-12T10:00:00.000Z',
        session_id: 'feishu:chat-a',
        session_type: 'feishu',
        user: { text: '看一下项目结构' },
        assistant: {
          text: '先看目录',
          tool_calls: [
            {
              id: 'tool-1',
              name: 'execute_shell',
              arguments: { command: 'find "E:/demo" -maxdepth 2 -type f | head -20' },
              result: "命令执行失败: 'head' 不是内部或外部命令",
              duration_ms: 85,
            },
          ],
        },
        tokens: { prompt: 10, completion: 5 },
      },
      {
        turn: 2,
        timestamp: '2026-04-12T10:01:00.000Z',
        session_id: 'feishu:chat-a',
        session_type: 'feishu',
        user: { text: '继续' },
        assistant: {
          text: '',
          tool_calls: [
            {
              id: 'tool-2',
              name: 'read_file',
              arguments: { file_path: 'E:\\demo\\paper.pdf' },
              result: '执行被阻止: 读取路径超出工作目录。设置 XIAOBA_FS_ALLOW_OUTSIDE_READ=true 可解除限制',
              duration_ms: 2,
            },
            {
              id: 'tool-3',
              name: 'send_text',
              arguments: { text: 'done' },
              result: '工具执行错误: 429 Too Many Requests',
              duration_ms: 100,
            },
          ],
        },
        tokens: { prompt: 12, completion: 1 },
      },
      {
        turn: 1,
        timestamp: '2026-04-12T10:02:00.000Z',
        session_id: 'feishu:chat-b',
        session_type: 'feishu',
        user: { text: '检查网络' },
        assistant: {
          text: '请求失败: Connection error.',
          tool_calls: [
            {
              id: 'tool-4',
              name: 'read_file',
              arguments: { file_path: 'a.txt' },
              result: '工具执行错误: getaddrinfo ENOTFOUND open.feishu.cn',
              duration_ms: 15050,
            },
          ],
        },
        tokens: { prompt: 8, completion: 2 },
      },
    ];
    fs.writeFileSync(logPath, entries.map(entry => JSON.stringify(entry)).join('\n'), 'utf-8');

    const tool = new AnalyzeLogTool();
    const raw = await tool.execute(
      { log_source: logPath, analysis_depth: 'deep' },
      { workingDirectory: testRoot, conversationHistory: [] },
    );
    const result = JSON.parse(raw as string);

    assert.strictEqual(result.summary.totalTurns, 3);
    assert.strictEqual(result.summary.sessionCount, 2);
    assert.strictEqual(result.summary.interactionCount, 2);
    assert.strictEqual(result.summary.totalTokens, 38);
    assert.strictEqual(result.summary.toolCalls, 4);
    assert.strictEqual(result.turns.length, 3);

    const issueTypes = new Set(result.issues.map((issue: any) => issue.type));
    assert.ok(issueTypes.has('platform_command_mismatch'));
    assert.ok(issueTypes.has('outside_read_blocked'));
    assert.ok(issueTypes.has('rate_limited_retry'));
    assert.ok(issueTypes.has('api_or_network_failure'));
    assert.ok(issueTypes.has('slow_tool'));
    assert.ok(issueTypes.has('empty_reply'));
    assert.strictEqual(result.summary.signalQuality, 'actionable');
    assert.ok(result.issueProfiles.some((profile: any) => profile.route_to_role === 'engineer-cat'));
    assert.ok(result.issueProfiles.some((profile: any) => profile.route_to_role === 'reviewer-cat'));

    const firstTurn = result.turns.find((turn: any) => turn.sessionId === 'feishu:chat-a' && turn.turn === 1);
    const secondSessionTurn = result.turns.find((turn: any) => turn.sessionId === 'feishu:chat-b');
    assert.ok(firstTurn);
    assert.ok(secondSessionTurn);
    const secondTurn = result.turns.find((turn: any) => turn.sessionId === 'feishu:chat-a' && turn.turn === 2);
    assert.strictEqual(firstTurn.interactionId, 1);
    assert.strictEqual(secondTurn.interactionId, 1);
    assert.strictEqual(secondSessionTurn.interactionId, 1);
    assert.ok(firstTurn.issueTypes.includes('platform_command_mismatch'));
    assert.ok(secondSessionTurn.issueTypes.includes('api_or_network_failure'));

    const readFile = result.toolStats.find((toolStat: any) => toolStat.name === 'read_file');
    assert.ok(readFile);
    assert.strictEqual(readFile.failures, 2);
    assert.ok(readFile.avgDuration > 0);
  });

  test('JSONL channel trace 会把成功 send_text 当作可见回复而不是 empty_reply', async () => {
    const logPath = path.join(testRoot, 'channel-delivery.jsonl');
    const entries = [
      {
        entry_type: 'trace',
        trace_id: 'trace-channel-1',
        trace_index: 1,
        turn: 1,
        timestamp: '2026-06-30T10:00:00.000Z',
        session_id: 'pet:xiaoba:role-base',
        session_type: 'pet',
        user: { text: '所以产物在哪' },
        assistant: {
          text: '',
          tool_calls: [
            {
              id: 'tool-shell-1',
              name: 'execute_shell',
              arguments: { command: 'python3 - <<PY\nurllib.request.urlopen(url, timeout=10)\nprint("cdn_error=", err)\nPY' },
              result: '命令执行成功: $ python3 - <<PY\nurllib.request.urlopen(url, timeout=10)\nprint("cdn_error=", err)\nPY\ncdn_status= 200',
              status: 'success',
              duration_ms: 1264,
            },
            {
              id: 'tool-send-1',
              name: 'send_text',
              arguments: { text: '产物在 workspace/output/gsap/demo.html，可以直接打开。' },
              result: '已发送',
              status: 'success',
              duration_ms: 4,
            },
          ],
        },
        tokens: { prompt: 5, completion: 1 },
      },
    ];
    fs.writeFileSync(logPath, `${entries.map(entry => JSON.stringify(entry)).join('\n')}\n`, 'utf-8');

    const tool = new AnalyzeLogTool();
    const raw = await tool.execute(
      { log_source: logPath, analysis_depth: 'deep' },
      { workingDirectory: testRoot, conversationHistory: [] },
    );
    const result = JSON.parse(raw as string);

    const issueTypes = new Set(result.issues.map((issue: any) => issue.type));
    assert.strictEqual(result.summary.totalTurns, 1);
    assert.strictEqual(result.summary.issueCount, 0);
    assert.strictEqual(result.summary.toolCalls, 2);
    assert.strictEqual(result.turns[0].aiResponse, '产物在 workspace/output/gsap/demo.html，可以直接打开。');
    assert.ok(!issueTypes.has('empty_reply'));
    assert.ok(!issueTypes.has('timeout'));
    assert.ok(!issueTypes.has('tool_failure'));
  });

  test('空闲样本会标记为 insufficient signal，而不是生产 issue 路由', async () => {
    const logPath = path.join(testRoot, 'idle.log');
    fs.writeFileSync(logPath, '[2026-04-12 10:00:00.000] [INFO] 正在启动服务...\n', 'utf-8');

    const tool = new AnalyzeLogTool();
    const raw = await tool.execute(
      { log_source: logPath, analysis_depth: 'deep' },
      { workingDirectory: testRoot, conversationHistory: [] },
    );
    const result = JSON.parse(raw as string);

    assert.strictEqual(result.summary.totalTurns, 0);
    assert.strictEqual(result.summary.issueCount, 0);
    assert.strictEqual(result.summary.signalQuality, 'insufficient');
    assert.strictEqual(result.issueProfiles.length, 1);
    assert.strictEqual(result.issueProfiles[0].category, 'insufficient_signal');
    assert.strictEqual(result.issueProfiles[0].recommended_next_action, 'collect_more_signal');
  });
});
