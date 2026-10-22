import inquirer from 'inquirer';
import { Logger } from '../../../runtime/observability/logger';
import { ConfigManager } from '../../../runtime/config';
import { styles } from '../../../runtime/observability/colors';

export async function configCommand(): Promise<void> {
  Logger.title('XiaoBa 配置');

  const currentConfig = ConfigManager.getConfig();

  const answers = await inquirer.prompt([
    {
      type: 'list',
      name: 'provider',
      message: styles.text('Provider:'),
      choices: ['openai', 'anthropic', 'ollama'],
      default: currentConfig.provider || 'openai',
      prefix: styles.highlight('?'),
    },
    {
      type: 'input',
      name: 'apiUrl',
      message: styles.text('API地址:'),
      default: currentConfig.apiUrl,
      prefix: styles.highlight('?'),
    },
    {
      type: 'input',
      name: 'apiKey',
      message: styles.text('API密钥（本地 Ollama 可留空）:'),
      default: currentConfig.apiKey || '',
      prefix: styles.highlight('?'),
    },
    {
      type: 'input',
      name: 'model',
      message: styles.text('模型名称:'),
      default: currentConfig.model,
      prefix: styles.highlight('?'),
    },
    {
      type: 'number',
      name: 'temperature',
      message: styles.text('温度参数 (0-2):'),
      default: currentConfig.temperature,
      prefix: styles.highlight('?'),
    },
    {
      type: 'number',
      name: 'maxTokens',
      message: styles.text('最大输出 tokens（Ollama num_predict，可留空）:'),
      default: currentConfig.maxTokens ?? 1024,
      prefix: styles.highlight('?'),
    },
    {
      type: 'confirm',
      name: 'ollamaThink',
      message: styles.text('Ollama 是否启用 thinking:'),
      default: currentConfig.ollama?.think ?? false,
      prefix: styles.highlight('?'),
    },
    {
      type: 'input',
      name: 'ollamaKeepAlive',
      message: styles.text('Ollama keep_alive:'),
      default: currentConfig.ollama?.keepAlive || '30m',
      prefix: styles.highlight('?'),
    },
    {
      type: 'number',
      name: 'ollamaNumCtx',
      message: styles.text('Ollama num_ctx:'),
      default: currentConfig.ollama?.numCtx ?? 8192,
      prefix: styles.highlight('?'),
    },
  ]);

  const finalConfig = {
    provider: answers.provider,
    apiUrl: answers.apiUrl,
    apiKey: answers.apiKey,
    model: answers.model,
    temperature: answers.temperature,
    maxTokens: Number.isFinite(answers.maxTokens) && answers.maxTokens > 0 ? answers.maxTokens : undefined,
    ollama: {
      think: answers.ollamaThink,
      keepAlive: answers.ollamaKeepAlive,
      numCtx: Number.isFinite(answers.ollamaNumCtx) && answers.ollamaNumCtx > 0 ? answers.ollamaNumCtx : 8192,
    },
  };

  ConfigManager.saveConfig(finalConfig);
  Logger.success('配置已保存！');
}
