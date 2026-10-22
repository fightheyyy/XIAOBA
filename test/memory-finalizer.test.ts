import { afterEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import { randomUUID } from 'crypto';
import { AgentSession } from '../src/runtime/sessions/agent-session';
import { MemoryFinalizer } from '../src/memory/memory-finalizer';
import { SessionStore } from '../src/runtime/sessions/session-store';
import type { Message } from '../src/runtime/contracts';

function system(content: string): Message {
  return { role: 'system', content };
}

function user(content: string): Message {
  return { role: 'user', content };
}

function assistant(content: string): Message {
  return { role: 'assistant', content };
}

describe('MemoryFinalizer', () => {
  const sessionKeys: string[] = [];

  afterEach(() => {
    const store = SessionStore.getInstance();
    for (const key of sessionKeys.splice(0)) {
      store.deleteSession(key);
      fs.rmSync(MemoryFinalizer.getSessionDir(key), { recursive: true, force: true });
    }
  });

  test('cleanup extracts conservative long-term memory into markdown', async () => {
    const key = `test-memory-finalizer-${randomUUID()}`;
    sessionKeys.push(key);
    const session = new AgentSession(key, {} as any, 'feishu');
    (session as any).messages = [
      system('[session_memory]\n用户偏好回答简洁。当前任务：优化 runtime harness。下一步：补测试。'),
      user('以后都用中文回复，回答尽量简洁。'),
      user('我习惯默认使用 pnpm。'),
      user('继续实现 TTL memory，刚才测试失败了。'),
      assistant('已更新 /Users/guowei/XiaoBa-CLI/src/runtime/sessions/agent-session.ts，并会运行 npm test。'),
    ];

    await session.cleanup({ finalizeMemory: true, finalizationReason: 'ttl_cleanup' });

    const memoryPath = MemoryFinalizer.getMemoryPath(key);
    assert.ok(fs.existsSync(memoryPath), '应写入 MEMORY.md');
    const markdown = fs.readFileSync(memoryPath, 'utf-8');

    assert.match(markdown, /loadPolicy: on_demand/);
    assert.match(markdown, /# Long-Term Memory/);
    assert.match(markdown, /用户希望以后都用中文回复，回答尽量简洁。/);
    assert.match(markdown, /用户习惯默认使用 pnpm。/);
    assert.match(markdown, /用户偏好回答简洁。/);
    assert.ok(!markdown.includes(key), 'long-term memory 不应包含明文 session key');
    assert.ok(!markdown.includes('刚才测试失败'), '临时任务状态不应进入长期 memory');
    assert.ok(!markdown.includes('agent-session.ts'), '临时文件路径不应进入长期 memory');
    assert.deepEqual((session as any).messages, []);

    const loaded = MemoryFinalizer.loadSessionMemory(key);
    assert.ok(loaded);
    assert.equal(loaded!.loadPolicy, 'on_demand');
    assert.ok(loaded!.records.some(record => record.kind === 'instruction' && record.text.includes('中文回复')));
    assert.ok(loaded!.records.some(record => record.kind === 'habit' && record.text.includes('pnpm')));
  });

  test('finalizer failure does not block restorable transcript save', async () => {
    const key = `test-memory-finalizer-failure-${randomUUID()}`;
    sessionKeys.push(key);
    const session = new AgentSession(key, {} as any, 'feishu');
    (session as any).messages = [
      system('[session_memory]\n当前任务：验证失败隔离。'),
      user('保存 transcript'),
      assistant('好的'),
    ];

    const original = MemoryFinalizer.finalizeSession;
    (MemoryFinalizer as any).finalizeSession = () => {
      throw new Error('finalizer boom');
    };

    try {
      await session.cleanup({ finalizeMemory: true, finalizationReason: 'ttl_cleanup' });
    } finally {
      (MemoryFinalizer as any).finalizeSession = original;
    }

    const loaded = SessionStore.getInstance().loadContext(key, 'feishu');
    assert.ok(loaded.some(message => message.role === 'user' && message.content === '保存 transcript'));
    assert.deepEqual((session as any).messages, []);
    assert.ok(!fs.existsSync(MemoryFinalizer.getMemoryPath(key)));
  });

  test('restore uses data sessions and does not inject long-term memory by default', async () => {
    const key = `test-memory-on-demand-${randomUUID()}`;
    sessionKeys.push(key);
    SessionStore.getInstance().saveContext(key, [
      user('恢复上次上下文'),
      assistant('会从 data/sessions 读取。'),
    ], 'cli');
    MemoryFinalizer.finalizeSession(key, [
      user('以后都用中文回复。'),
      assistant('已记录。'),
    ], { reason: 'ttl_cleanup', sessionType: 'cli' });

    const session = new AgentSession(key, {} as any, 'cli');
    assert.equal(session.restoreFromStore(), true);
    await session.init();

    const messages = (session as any).messages as Message[];
    assert.ok(messages.some(message => message.role === 'user' && message.content === '恢复上次上下文'));
    assert.ok(!messages.some(message =>
      message.role === 'system' && String(message.content).includes('[session_archive_memory]')
    ));
    assert.ok(!messages.some(message =>
      message.role === 'system' && String(message.content).includes('[long_term_memory]')
    ));
    assert.ok(!messages.some(message =>
      message.role === 'system' && String(message.content).includes('以后都用中文回复')
    ));
  });

  test('memory-only sessions do not restore without data session context', async () => {
    const key = `test-memory-only-${randomUUID()}`;
    sessionKeys.push(key);
    MemoryFinalizer.finalizeSession(key, [
      user('以后默认叫我小八。'),
      assistant('记住了。'),
    ], { reason: 'ttl_cleanup', sessionType: 'cli' });

    const session = new AgentSession(key, {} as any, 'cli');
    assert.equal(session.restoreFromStore(), false);
  });

  test('summarizeAndDestroy updates CLI long-term markdown memory', async () => {
    const key = `test-cli-session-close-${randomUUID()}`;
    sessionKeys.push(key);
    const aiService = {
      chat: async () => ({ content: '归档摘要：CLI 会话结束。' }),
    };
    const session = new AgentSession(key, { aiService } as any, 'cli');
    (session as any).messages = [
      system('[session_memory]\n用户偏好直接给结论。当前任务：CLI 退出时保存 context。'),
      user('以后记住我喜欢先给结论。'),
      assistant('好的。'),
    ];

    const ok = await session.summarizeAndDestroy();

    assert.equal(ok, true);
    const markdown = fs.readFileSync(MemoryFinalizer.getMemoryPath(key), 'utf-8');
    assert.match(markdown, /先给结论。/);
    assert.match(markdown, /用户偏好直接给结论。/);
    assert.ok(!markdown.includes('CLI 退出时保存 context'));
    const loaded = SessionStore.getInstance().loadContext(key, 'cli');
    assert.ok(loaded.some(message => message.role === 'user' && message.content === '以后记住我喜欢先给结论。'));
    assert.deepEqual((session as any).messages, []);
  });
});
