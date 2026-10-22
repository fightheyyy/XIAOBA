import { ReadTool } from '../../capabilities/tools/read-tool';
import { WriteTool } from '../../capabilities/tools/write-tool';
import { EditTool } from '../../capabilities/tools/edit-tool';
import { GlobTool } from '../../capabilities/tools/glob-tool';
import { GrepTool } from '../../capabilities/tools/grep-tool';
import type { Tool } from '../contracts/tool';
import { Logger } from '../observability/logger';

Logger.setSilentMode(true);

const tools = new Map<string, Tool>([new ReadTool(), new WriteTool(), new EditTool(), new GlobTool(), new GrepTool()].map(tool => [tool.definition.name, tool]));
const chunks: Buffer[] = [];
let bytes = 0;
process.stdin.on('data', chunk => {
  bytes += chunk.length;
  if (bytes > 10 * 1024 * 1024) throw new Error('File tool input limit exceeded.');
  chunks.push(Buffer.from(chunk));
});
process.stdin.on('end', async () => {
  try {
    const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const tool = tools.get(request.name);
    if (!tool) throw new Error('Unknown sandbox file tool.');
    const result = await tool.execute(request.args, { workingDirectory: request.workingDirectory, conversationHistory: [] });
    process.stdout.write(JSON.stringify(typeof result === 'string' || Array.isArray(result) ? { toolContent: result } : result));
  } catch (error) { process.stderr.write(String(error)); process.exitCode = 1; }
});
