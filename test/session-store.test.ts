import { afterEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { SessionStore } from '../src/runtime/sessions/session-store';
import type { Message } from '../src/runtime/contracts';

function system(content: string): Message {
  return { role: 'system', content };
}

describe('SessionStore', () => {
  const sessionKeys: string[] = [];

  afterEach(() => {
    const store = SessionStore.getInstance();
    for (const key of sessionKeys.splice(0)) {
      store.deleteSession(key);
    }
  });

  test('persists compacted runtime memory while dropping regenerated system prompts', () => {
    const key = `test-session-store-${randomUUID()}`;
    sessionKeys.push(key);
    const store = SessionStore.getInstance();
    const messages: Message[] = [
      system('base system prompt regenerated at startup'),
      system('[surface:feishu:private] regenerated surface prompt'),
      system('[skill:demo]\nturn scoped skill prompt'),
      system('[compact_boundary] 10 older messages summarized.'),
      system('[session_memory]\n用户正在排查 runtime harness。'),
      system('[im_visible_transcript]\n最近用户已经看到的 IM 输出事实。'),
      system('[last_turn_anchor]\nUser Input:\n继续上次任务'),
      { role: 'user', content: '继续' },
      { role: 'user', content: 'transient', __injected: true },
    ];

    store.saveContext(key, messages);
    const loaded = store.loadContext(key);
    const loadedContent = loaded.map(message => String(message.content));

    assert.deepStrictEqual(
      loadedContent,
      [
        '[compact_boundary] 10 older messages summarized.',
        '[session_memory]\n用户正在排查 runtime harness。',
        '[im_visible_transcript]\n最近用户已经看到的 IM 输出事实。',
        '[last_turn_anchor]\nUser Input:\n继续上次任务',
        '继续',
      ],
    );
  });

  test('separates same session key by surface namespace', () => {
    const key = `user:${randomUUID()}`;
    sessionKeys.push(key);
    const store = SessionStore.getInstance();

    store.saveContext(key, [{ role: 'user', content: 'from feishu' }], 'feishu');
    store.saveContext(key, [{ role: 'user', content: 'from weixin' }], 'weixin');

    assert.deepStrictEqual(
      store.loadContext(key, 'feishu').map(message => message.content),
      ['from feishu'],
    );
    assert.deepStrictEqual(
      store.loadContext(key, 'weixin').map(message => message.content),
      ['from weixin'],
    );
  });

  test('loads legacy flat session file as migration fallback', () => {
    const key = `legacy-session-${randomUUID()}`;
    sessionKeys.push(key);
    const legacyDir = path.join(process.cwd(), 'data', 'sessions');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(
      path.join(legacyDir, `${key}.jsonl`),
      `${JSON.stringify({ role: 'user', content: 'legacy context' })}\n`,
      'utf-8',
    );

    const loaded = SessionStore.getInstance().loadContext(key, 'cli');

    assert.deepStrictEqual(loaded.map(message => message.content), ['legacy context']);
  });
});
