import { afterEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import express from 'express';
import * as http from 'http';
import { OllamaProvider } from '../src/runtime/harness/models/ollama-provider';
import { AIService } from '../src/runtime/harness/models/ai-service';
import { ConfigManager } from '../src/runtime/config';
import { ToolDefinition } from '../src/runtime/contracts/tool';

async function listen(app: express.Express): Promise<{ server: http.Server; baseUrl: string }> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

async function closeServer(server: http.Server | null): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server.close(err => err ? reject(err) : resolve());
  });
}

const readFileTool: ToolDefinition = {
  name: 'read_file',
  description: 'Read a file',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path' },
    },
    required: ['path'],
  },
};

describe('OllamaProvider', () => {
  let server: http.Server | null = null;

  afterEach(async () => {
    await closeServer(server);
    server = null;
  });

  test('normalizes common Ollama base URLs to native /api/chat', () => {
    const provider = new OllamaProvider({
      apiUrl: 'http://127.0.0.1:11434',
      model: 'qwen3:8b',
      provider: 'ollama',
    });

    assert.strictEqual((provider as any).apiUrl, 'http://127.0.0.1:11434/api/chat');
  });

  test('default config detects local Ollama base URLs', () => {
    const previousProvider = process.env.XIAOBA_LLM_PROVIDER;
    const previousBase = process.env.XIAOBA_LLM_API_BASE;
    const previousModel = process.env.XIAOBA_LLM_MODEL;
    const previousMaxTokens = process.env.XIAOBA_LLM_MAX_TOKENS;
    const previousThink = process.env.XIAOBA_OLLAMA_THINK;
    const previousKeepAlive = process.env.XIAOBA_OLLAMA_KEEP_ALIVE;
    const previousNumCtx = process.env.XIAOBA_OLLAMA_NUM_CTX;

    try {
      delete process.env.XIAOBA_LLM_PROVIDER;
      process.env.XIAOBA_LLM_API_BASE = 'http://localhost:11434';
      process.env.XIAOBA_LLM_MODEL = 'qwen3:8b';
      process.env.XIAOBA_LLM_MAX_TOKENS = '1024';
      process.env.XIAOBA_OLLAMA_THINK = 'false';
      process.env.XIAOBA_OLLAMA_KEEP_ALIVE = '30m';
      process.env.XIAOBA_OLLAMA_NUM_CTX = '8192';

      const config = ConfigManager.getDefaultConfig();
      assert.strictEqual(config.provider, 'ollama');
      assert.strictEqual(config.apiUrl, 'http://localhost:11434');
      assert.strictEqual(config.maxTokens, 1024);
      assert.deepStrictEqual(config.ollama, {
        think: false,
        keepAlive: '30m',
        numCtx: 8192,
      });
    } finally {
      if (previousProvider === undefined) delete process.env.XIAOBA_LLM_PROVIDER;
      else process.env.XIAOBA_LLM_PROVIDER = previousProvider;
      if (previousBase === undefined) delete process.env.XIAOBA_LLM_API_BASE;
      else process.env.XIAOBA_LLM_API_BASE = previousBase;
      if (previousModel === undefined) delete process.env.XIAOBA_LLM_MODEL;
      else process.env.XIAOBA_LLM_MODEL = previousModel;
      if (previousMaxTokens === undefined) delete process.env.XIAOBA_LLM_MAX_TOKENS;
      else process.env.XIAOBA_LLM_MAX_TOKENS = previousMaxTokens;
      if (previousThink === undefined) delete process.env.XIAOBA_OLLAMA_THINK;
      else process.env.XIAOBA_OLLAMA_THINK = previousThink;
      if (previousKeepAlive === undefined) delete process.env.XIAOBA_OLLAMA_KEEP_ALIVE;
      else process.env.XIAOBA_OLLAMA_KEEP_ALIVE = previousKeepAlive;
      if (previousNumCtx === undefined) delete process.env.XIAOBA_OLLAMA_NUM_CTX;
      else process.env.XIAOBA_OLLAMA_NUM_CTX = previousNumCtx;
    }
  });

  test('sends native chat requests and converts Ollama tool calls to runtime format', async () => {
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    let capturedBody: any;
    let capturedAuthorization = '';

    app.post('/api/chat', (req, res) => {
      capturedBody = req.body;
      capturedAuthorization = req.header('authorization') || '';
      res.json({
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            { function: { name: 'read_file', arguments: { path: 'README.md' } } },
          ],
        },
        done: true,
        prompt_eval_count: 7,
        eval_count: 3,
      });
    });

    const listening = await listen(app);
    server = listening.server;

    const provider = new OllamaProvider({
      apiUrl: listening.baseUrl,
      apiKey: 'sk-stale-openai-key',
      model: 'qwen3:8b',
      provider: 'ollama',
      temperature: 0.2,
      maxTokens: 128,
      ollama: {
        think: false,
        keepAlive: '30m',
        numCtx: 8192,
      },
    });

    const result = await provider.chat([
      { role: 'system', content: 'You are XiaoBa.' },
      { role: 'user', content: 'Read README.' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'read_file', arguments: JSON.stringify({ path: 'README.md' }) },
        }],
      },
      { role: 'tool', name: 'read_file', tool_call_id: 'call_1', content: 'README content' },
    ], [readFileTool]);

    assert.strictEqual(capturedAuthorization, '');
    assert.strictEqual(capturedBody.model, 'qwen3:8b');
    assert.strictEqual(capturedBody.stream, false);
    assert.strictEqual(capturedBody.think, false);
    assert.strictEqual(capturedBody.keep_alive, '30m');
    assert.deepStrictEqual(capturedBody.options, { temperature: 0.2, num_ctx: 8192, num_predict: 128 });
    assert.deepStrictEqual(capturedBody.tools, [{
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read a file',
        parameters: readFileTool.parameters,
      },
    }]);
    assert.strictEqual(capturedBody.messages[3].role, 'tool');
    assert.strictEqual(capturedBody.messages[3].tool_name, 'read_file');

    assert.strictEqual(result.content, null);
    assert.strictEqual(result.toolCalls?.[0].function.name, 'read_file');
    assert.deepStrictEqual(JSON.parse(result.toolCalls?.[0].function.arguments || '{}'), { path: 'README.md' });
    assert.deepStrictEqual(result.usage, { promptTokens: 7, completionTokens: 3, totalTokens: 10 });
  });

  test('parses NDJSON streaming responses and streamed tool calls', async () => {
    const app = express();
    app.use(express.json({ limit: '1mb' }));

    app.post('/api/chat', (_req, res) => {
      res.setHeader('Content-Type', 'application/x-ndjson');
      res.write(JSON.stringify({ message: { role: 'assistant', content: 'hi ' }, done: false }) + '\n');
      res.write(JSON.stringify({
        message: {
          role: 'assistant',
          tool_calls: [{ function: { name: 'read_file', arguments: { path: 'notes.md' } } }],
        },
        done: false,
      }) + '\n');
      res.end(JSON.stringify({
        message: { role: 'assistant', content: 'there' },
        done: true,
        prompt_eval_count: 2,
        eval_count: 5,
      }) + '\n');
    });

    const listening = await listen(app);
    server = listening.server;

    const provider = new OllamaProvider({
      apiUrl: listening.baseUrl,
      model: 'qwen3:8b',
      provider: 'ollama',
    });

    const textChunks: string[] = [];
    const result = await provider.chatStream(
      [{ role: 'user', content: 'hello' }],
      [readFileTool],
      { onText: text => textChunks.push(text) },
    );

    assert.deepStrictEqual(textChunks, ['hi ', 'there']);
    assert.strictEqual(result.content, 'hi there');
    assert.strictEqual(result.toolCalls?.[0].function.name, 'read_file');
    assert.deepStrictEqual(JSON.parse(result.toolCalls?.[0].function.arguments || '{}'), { path: 'notes.md' });
    assert.deepStrictEqual(result.usage, { promptTokens: 2, completionTokens: 5, totalTokens: 7 });
  });

  test('AIService allows local Ollama chat without an API key', async () => {
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    app.post('/api/chat', (_req, res) => {
      res.json({
        message: { role: 'assistant', content: 'local ok' },
        done: true,
      });
    });

    const listening = await listen(app);
    server = listening.server;

    const aiService = new AIService({
      provider: 'ollama',
      apiUrl: listening.baseUrl,
      apiKey: undefined,
      model: 'qwen3:8b',
    });

    const result = await aiService.chat([{ role: 'user', content: 'ping' }]);
    assert.strictEqual(result.content, 'local ok');
  });
});
