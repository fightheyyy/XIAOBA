import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import { AnthropicProvider } from '../src/runtime/harness/models/anthropic-provider';
import { Message } from '../src/runtime/contracts';

describe('AnthropicProvider - Image in Assistant Message Bug', () => {
  test('should not drop assistant messages with ContentBlock[] content', () => {
    // 模拟压缩后的消息序列，包含一个 assistant 消息带图片
    const messages: Message[] = [
      {
        role: 'system',
        content: 'You are a helpful assistant.'
      },
      {
        role: 'user',
        content: '请分析这张图片'
      },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '这是分析结果' },
          { 
            type: 'image', 
            source: { 
              type: 'base64', 
              media_type: 'image/png', 
              data: 'fake-base64-data' 
            } 
          }
        ]
      },
      {
        role: 'user',
        content: '继续'
      }
    ];

    const provider = new AnthropicProvider({
      apiKey: 'fake-key',
      apiUrl: 'https://api.anthropic.com/v1/messages',
      model: 'claude-sonnet-4-20250514'
    });

    // 使用反射访问私有方法 transformMessages
    const transformMessages = (provider as any).transformMessages.bind(provider);
    const result = transformMessages(messages);

    // 验证转换后的消息数量
    // 期望：system 被提取，剩下 3 条非 system 消息（user, assistant, user）
    assert.strictEqual(result.messages.length, 3, 
      `Expected 3 messages but got ${result.messages.length}`);

    // 验证消息角色序列正确（user -> assistant -> user）
    assert.strictEqual(result.messages[0].role, 'user');
    assert.strictEqual(result.messages[1].role, 'assistant');
    assert.strictEqual(result.messages[2].role, 'user');

    // 验证 assistant 消息没有被丢弃
    const assistantMsg = result.messages[1];
    assert.ok(assistantMsg.content, 'Assistant message content should not be empty');
    
    // 验证 assistant 消息的 content 是数组且包含图片
    assert.ok(Array.isArray(assistantMsg.content), 
      'Assistant message content should be an array');
    assert.ok((assistantMsg.content as any[]).length > 0, 
      'Assistant message content array should not be empty');
  });

  test('should handle assistant message with only image ContentBlock', () => {
    // 极端情况：assistant 消息只有图片，没有文本
    const messages: Message[] = [
      {
        role: 'system',
        content: 'You are a helpful assistant.'
      },
      {
        role: 'user',
        content: '生成一张图'
      },
      {
        role: 'assistant',
        content: [
          { 
            type: 'image', 
            source: { 
              type: 'base64', 
              media_type: 'image/png', 
              data: 'fake-base64-data' 
            } 
          }
        ]
      },
      {
        role: 'user',
        content: '很好'
      }
    ];

    const provider = new AnthropicProvider({
      apiKey: 'fake-key',
      apiUrl: 'https://api.anthropic.com/v1/messages',
      model: 'claude-sonnet-4-20250514'
    });

    const transformMessages = (provider as any).transformMessages.bind(provider);
    const result = transformMessages(messages);

    // 验证 assistant 消息没有被丢弃
    assert.strictEqual(result.messages.length, 3, 
      'Should have 3 messages (user, assistant, user)');
    assert.strictEqual(result.messages[1].role, 'assistant',
      'Second message should be assistant');
    assert.ok(result.messages[1].content,
      'Assistant message with only image should not be dropped');
  });
});
