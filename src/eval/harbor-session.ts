import * as readline from 'readline';
import { AgentSession } from '../core/agent-session';
import { EventDispatcher } from '../events/dispatcher';
import { createAgentEvent } from '../events/event';
import { SkillManager } from '../skills/skill-manager';
import { ToolManager } from '../tools/tool-manager';
import { Tool, ToolDefinition, ToolExecutionContext, ToolExecutionOutput } from '../types/tool';
import { AIService } from '../utils/ai-service';
import { ConfigManager } from '../utils/config';
import { Logger } from '../utils/logger';

/** VibeLifeBench's English Harbor instruction envelope; unknown senders are internal. */
export async function dispatchHarborInstruction(
  session: AgentSession, dispatcher: EventDispatcher, instruction: string, index: number,
): Promise<{ text: string; internal: boolean }> {
  const user = /^\[[^\]\n]+\] User [^\n]+ says:\s*\n/.test(instruction);
  const event = createAgentEvent({
    type: user ? 'harbor.user_message' : 'harbor.notification',
    source: { kind: user ? 'surface' : 'runtime', id: 'vibelifebench' },
    sourceEventId: String(index),
    target: { sessionKey: session.key, surface: 'agent' },
    payload: { text: instruction },
  });
  let text = '';
  await dispatcher.dispatch(event, async () => {
    const result = await session.handleMessage(instruction, { surface: 'agent', internal: !user });
    if (result.failed) throw new Error('XIAOBA_HARBOR_SESSION_FAILED');
    text = result.text;
  });
  return { text, internal: !user };
}

async function main(): Promise<void> {
  // stdout belongs exclusively to the host/container tool bridge.
  Logger.setSilentMode(true);
  const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
  const pending = new Map<number, (value: ToolExecutionOutput) => void>();
  let nextId = 0;
  let session: AgentSession | undefined;
  const dispatcher = new EventDispatcher();
  const input = readline.createInterface({ input: process.stdin });
  input.on('line', line => {
    void (async () => {
      const message = JSON.parse(line);
      if (message.type === 'tool_result') {
        const resolve = pending.get(message.id);
        pending.delete(message.id);
        resolve?.(message.result);
        return;
      }
      if (message.type === 'init') {
        const config = ConfigManager.getConfig();
        if (!config.model || (config.provider !== 'ollama' && !config.apiKey)) {
          throw new Error('Configure XIAOBA_LLM_PROVIDER/API_BASE/API_KEY/MODEL before a live Harbor run');
        }
        const tools: Tool[] = message.tools.map((definition: ToolDefinition) => ({
          definition,
          execute: (args: unknown, context: ToolExecutionContext) => new Promise<ToolExecutionOutput>(resolve => {
            const id = ++nextId;
            pending.set(id, resolve);
            send({ type: 'tool', id, call_id: context.toolCallId, name: definition.name, args });
          }),
        }));
        session = new AgentSession('harbor:task', {
          aiService: new AIService(), skillManager: new SkillManager(),
          toolManager: new ToolManager(process.cwd(), { surface: 'agent' }, tools, {
            inheritBaseTools: false, baseToolAllowlist: [],
          }),
        }, 'harbor');
        send({ type: 'ready' });
      } else if (message.type === 'stage' && session) {
        const result = await dispatchHarborInstruction(session, dispatcher, message.instruction, message.index);
        send({ type: 'done', ...result });
      } else {
        throw new Error('Invalid Harbor bridge state');
      }
    })().catch(error => { send({ type: 'error', error: String(error.message || error) }); });
  });
  // One worker and one session for the whole trial; EOF also handles host exit.
  input.on('close', () => {
    void session?.cleanup({ checkWakeup: false, finalizeMemory: true })
      .finally(() => process.exit(0));
    if (!session) process.exit(0);
  });
}

if (require.main === module) void main();
