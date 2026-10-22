import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import { AnthropicProvider } from '../src/runtime/harness/models/anthropic-provider';
import { Message } from '../src/runtime/contracts';

describe('AnthropicProvider - Tool Result Block Order Bug', () => {
  test('should place all tool_result blocks before image blocks', () => {
    // 模拟多个工具调用，其中一些返回图片
    const messages: Message[] = [
      {
        role: 'system',
        content: 'You are a helpful assistant.'
      },
      {
        role: 'user',
        content: '读取两张图片'
      },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'read_image', arguments: '{"path":"img1.jpg"}' }
          },
          {
            id: 'call_2',
            type: 'function',
            function: { name: 'read_image', arguments: '{"path":"img2.jpg"}' }
          }
        ]
      },
      // 第一个工具返回图片
      {
        role: 'tool',
        tool_call_id: 'call_1',
        name: 'read_image',
        content: [
          { type: 'text', text: '图片1已读取' },
          { 
            type: 'image', 
            source: { 
              type: 'base64', 
              media_type: 'image/jpeg', 
              data: 'fake-image-1-data' 
            }
          }
        ]
      },
      // 第二个工具也返回图片
      {
        role: 'tool',
        tool_call_id: 'call_2',
        name: 'read_image',
        content: [
          { type: 'text', text: '图片2已读取' },
          { 
            type: 'image', 
            source: { 
              type: 'base64', 
              media_type: 'image/png', 
              data: 'fake-image-2-data' 
            }
          }
        ]
      }
    ];

    const provider = new AnthropicProvider({
      apiKey: 'fake-key',
      apiUrl: 'https://api.anthropic.com/v1/messages',
      model: 'claude-sonnet-4-20250514'
    });

    const transformMessages = (provider as any).transformMessages.bind(provider);
    const result = transformMessages(messages);

    // 找到包含 tool results 的 user 消息
    const userMsg = result.messages.find((m: any) => 
      m.role === 'user' && Array.isArray(m.content)
    );
    
    assert.ok(userMsg, 'Should have user message with tool results');
    
    const content = userMsg.content as any[];
    
    // 验证 content 数组的结构
    console.log('Content blocks order:', content.map(b => b.type));
    
    // 找到所有 tool_result 和 image 的索引
    const toolResultIndices: number[] = [];
    const imageIndices: number[] = [];
    
    content.forEach((block, index) => {
      if (block.type === 'tool_result') {
        toolResultIndices.push(index);
      } else if (block.type === 'image') {
        imageIndices.push(index);
      }
    });
    
    assert.strictEqual(toolResultIndices.length, 2, 
      'Should have 2 tool_result blocks');
    assert.strictEqual(imageIndices.length, 2, 
      'Should have 2 image blocks');
    
    // 关键验证：所有 tool_result 的索引必须小于所有 image 的索引
    const maxToolResultIndex = Math.max(...toolResultIndices);
    const minImageIndex = Math.min(...imageIndices);
    
    assert.ok(maxToolResultIndex < minImageIndex,
      `All tool_result blocks (max index: ${maxToolResultIndex}) must come before image blocks (min index: ${minImageIndex}). ` +
      `Current order: ${content.map(b => b.type).join(', ')}`);
  });

  test('should handle mixed tool results (some with images, some without)', () => {
    // 更复杂的场景：3个工具，只有部分返回图片
    const messages: Message[] = [
      {
        role: 'system',
        content: 'You are a helpful assistant.'
      },
      {
        role: 'user',
        content: '执行多个操作'
      },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'read_file', arguments: '{}' }
          },
          {
            id: 'call_2',
            type: 'function',
            function: { name: 'read_image', arguments: '{}' }
          },
          {
            id: 'call_3',
            type: 'function',
            function: { name: 'execute_shell', arguments: '{}' }
          }
        ]
      },
      // 第一个工具：纯文本
      {
        role: 'tool',
        tool_call_id: 'call_1',
        name: 'read_file',
        content: 'File content here'
      },
      // 第二个工具：返回图片
      {
        role: 'tool',
        tool_call_id: 'call_2',
        name: 'read_image',
        content: [
          { type: 'text', text: '图片已读取' },
          { 
            type: 'image', 
            source: { 
              type: 'base64', 
              media_type: 'image/jpeg', 
              data: 'fake-data' 
            }
          }
        ]
      },
      // 第三个工具：纯文本
      {
        role: 'tool',
        tool_call_id: 'call_3',
        name: 'execute_shell',
        content: 'Command output'
      }
    ];

    const provider = new AnthropicProvider({
      apiKey: 'fake-key',
      apiUrl: 'https://api.anthropic.com/v1/messages',
      model: 'claude-sonnet-4-20250514'
    });

    const transformMessages = (provider as any).transformMessages.bind(provider);
    const result = transformMessages(messages);

    const userMsg = result.messages.find((m: any) => 
      m.role === 'user' && Array.isArray(m.content)
    );
    
    assert.ok(userMsg);
    const content = userMsg.content as any[];
    
    // 验证顺序
    const toolResultIndices: number[] = [];
    const imageIndices: number[] = [];
    
    content.forEach((block, index) => {
      if (block.type === 'tool_result') toolResultIndices.push(index);
      if (block.type === 'image') imageIndices.push(index);
    });
    
    assert.strictEqual(toolResultIndices.length, 3, 'Should have 3 tool_result blocks');
    assert.strictEqual(imageIndices.length, 1, 'Should have 1 image block');
    
    if (imageIndices.length > 0) {
      const maxToolResultIndex = Math.max(...toolResultIndices);
      const minImageIndex = Math.min(...imageIndices);
      
      assert.ok(maxToolResultIndex < minImageIndex,
        `Tool results must come before images. Order: ${content.map(b => b.type).join(', ')}`);
    }
  });
});
