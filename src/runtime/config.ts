import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as dotenv from 'dotenv';
import { ChatConfig } from './contracts';

// 加载环境变量（静默模式）
dotenv.config({
  path: process.env.DOTENV_CONFIG_PATH || '.env',
  quiet: true,
  override: process.env.DOTENV_CONFIG_OVERRIDE === 'true',
});

const CONFIG_DIR = path.join(os.homedir(), '.xiaoba');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

export class ConfigManager {
  private static mergeConfig(base: ChatConfig, override?: Partial<ChatConfig>): ChatConfig {
    if (!override) {
      return base;
    }

    return {
      ...base,
      ...override,
      feishu: {
        ...(base.feishu || {}),
        ...(override.feishu || {}),
      },
      weixin: {
        ...(base.weixin || {}),
        ...(override.weixin || {}),
      },
      ollama: {
        ...(base.ollama || {}),
        ...(override.ollama || {}),
      },
    };
  }

  private static ensureConfigDir(): void {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
  }

  private static loadUserConfigFile(strict = false): Partial<ChatConfig> {
    try {
      const content = fs.readFileSync(CONFIG_FILE, 'utf-8');
      return JSON.parse(content);
    } catch (error: any) {
      if (error?.code === 'ENOENT') {
        return {};
      }
      if (strict) {
        throw new Error(`Failed to read ${CONFIG_FILE}: ${error?.message || String(error)}`);
      }
      return {};
    }
  }

  static peekConfig(): ChatConfig {
    return this.mergeConfig(this.getDefaultConfig(), this.loadUserConfigFile(true));
  }

  static getConfig(): ChatConfig {
    this.ensureConfigDir();
    return this.mergeConfig(this.getDefaultConfig(), this.loadUserConfigFile());
  }

  static saveConfig(config: ChatConfig): void {
    this.ensureConfigDir();
    const merged = this.mergeConfig(this.loadUserConfigFile() as ChatConfig, config);
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2));
  }

  static getDefaultConfig(): ChatConfig {
    const apiUrl = process.env.XIAOBA_LLM_API_BASE || 'https://api.openai.com/v1';
    const model = process.env.XIAOBA_LLM_MODEL || 'gpt-3.5-turbo';
    const maxTokens = this.parsePositiveInt(process.env.XIAOBA_LLM_MAX_TOKENS);

    // 自动检测 provider
    let provider: 'openai' | 'anthropic' | 'ollama' = 'openai';
    if (process.env.XIAOBA_LLM_PROVIDER) {
      provider = process.env.XIAOBA_LLM_PROVIDER as 'openai' | 'anthropic' | 'ollama';
    } else if (apiUrl.includes('anthropic') || apiUrl.includes('claude') || model.includes('claude')) {
      provider = 'anthropic';
    } else if (apiUrl.includes('ollama') || apiUrl.includes(':11434') || apiUrl.endsWith('/api/chat')) {
      provider = 'ollama';
    }

    return {
      apiUrl,
      apiKey: process.env.XIAOBA_LLM_API_KEY,
      model,
      temperature: 0.7,
      maxTokens,
      provider,
      ollama: {
        think: this.parseBoolean(process.env.XIAOBA_OLLAMA_THINK, false),
        keepAlive: process.env.XIAOBA_OLLAMA_KEEP_ALIVE || '30m',
        numCtx: this.parsePositiveInt(process.env.XIAOBA_OLLAMA_NUM_CTX) ?? 8192,
      },
      feishu: {
        appId: process.env.FEISHU_APP_ID,
        appSecret: process.env.FEISHU_APP_SECRET,
        botOpenId: process.env.FEISHU_BOT_OPEN_ID,
        botAliases: (process.env.FEISHU_BOT_ALIASES || '小八,xiaoba')
          .split(',')
          .map(item => item.trim())
          .filter(Boolean),
      },
    };
  }

  private static parsePositiveInt(value?: string): number | undefined {
    if (!value) {
      return undefined;
    }
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  }

  private static parseBoolean(value: string | undefined, fallback: boolean): boolean {
    if (value === undefined || value.trim() === '') {
      return fallback;
    }
    return value.trim().toLowerCase() === 'true';
  }
}
