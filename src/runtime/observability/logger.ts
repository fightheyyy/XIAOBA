import { AsyncLocalStorage } from 'node:async_hooks';
import { styles } from './colors';
import ora, { Ora } from 'ora';
import type { SessionTurnLogger } from './session-turn-logger';

interface LoggerContextStore {
  sessionId?: string;
  sessionLogger?: SessionTurnLogger;
}

export interface RuntimeLogEntry {
  level: string;
  message: string;
  line: string;
  sessionId?: string;
  timestamp: number;
}

const MAX_RUNTIME_LOG_LINES = 1000;

export class Logger {
  private static spinner: Ora | null = null;
  private static silentMode: boolean = false;
  private static logContext = new AsyncLocalStorage<LoggerContextStore>();
  private static runtimeLogs: RuntimeLogEntry[] = [];

  private static stripAnsi(str: string): string {
    // eslint-disable-next-line no-control-regex
    return str.replace(/\x1B\[[0-9;]*m/g, '');
  }

  private static writeToSessionLog(level: string, message: string): void {
    const store = this.logContext.getStore();
    if (store?.sessionLogger) {
      store.sessionLogger.logRuntime(level, this.stripAnsi(message));
    }
  }

  private static recordRuntimeLog(level: string, message: string): void {
    const store = this.logContext.getStore();
    const cleanMessage = this.stripAnsi(message);
    this.runtimeLogs.push({
      level,
      message: cleanMessage,
      line: this.formatRuntimeLine(level, cleanMessage),
      sessionId: store?.sessionId,
      timestamp: Date.now(),
    });
    if (this.runtimeLogs.length > MAX_RUNTIME_LOG_LINES) {
      this.runtimeLogs = this.runtimeLogs.slice(-MAX_RUNTIME_LOG_LINES);
    }
  }

  private static formatRuntimeLine(level: string, message: string): string {
    switch (level) {
      case 'SUCCESS':
        return `✓ ${message}`;
      case 'ERROR':
        return `✗ ${message}`;
      case 'WARN':
        return `⚠ ${message}`;
      case 'INFO':
        return `ℹ ${message}`;
      default:
        return message;
    }
  }

  static getRuntimeLogs(options: {
    lines?: number;
    sessionPrefix?: string;
  } = {}): string[] {
    const lines = options.lines ?? 100;
    const logs = options.sessionPrefix
      ? this.runtimeLogs.filter(entry => entry.sessionId?.startsWith(options.sessionPrefix!))
      : this.runtimeLogs;
    return logs.slice(-lines).map(entry => entry.line);
  }

  static clearRuntimeLogs(): void {
    this.runtimeLogs = [];
  }

  static withSessionContext<T>(sessionId: string | undefined, fn: () => T): T;
  static withSessionContext<T>(sessionId: string | undefined, sessionLogger: SessionTurnLogger, fn: () => T): T;
  static withSessionContext<T>(
    sessionId: string | undefined,
    sessionLoggerOrFn: SessionTurnLogger | (() => T),
    maybeFn?: () => T,
  ): T {
    const normalizedSessionId = typeof sessionId === 'string'
      ? sessionId.replace(/\s+/g, ' ').trim()
      : '';
    const sessionLogger = typeof sessionLoggerOrFn === 'function' ? undefined : sessionLoggerOrFn;
    const fn = typeof sessionLoggerOrFn === 'function' ? sessionLoggerOrFn : maybeFn;
    if (!fn) {
      throw new Error('Logger.withSessionContext missing callback');
    }
    if (!normalizedSessionId) {
      return fn();
    }
    return this.logContext.run({ sessionId: normalizedSessionId, sessionLogger }, fn);
  }

  static setSilentMode(silent: boolean): void {
    this.silentMode = silent;
  }

  static isSilentMode(): boolean {
    return this.silentMode;
  }

  static success(message: string): void {
    this.writeToSessionLog('SUCCESS', message);
    this.recordRuntimeLog('SUCCESS', message);
    if (!this.silentMode) {
      console.log(styles.success(message));
    }
  }

  static error(message: string): void {
    this.writeToSessionLog('ERROR', message);
    this.recordRuntimeLog('ERROR', message);
    console.error(styles.error(message));
  }

  static warning(message: string): void {
    this.writeToSessionLog('WARN', message);
    this.recordRuntimeLog('WARN', message);
    console.warn(styles.warning(message));
  }

  static info(message: string): void {
    this.writeToSessionLog('INFO', message);
    this.recordRuntimeLog('INFO', message);
    if (!this.silentMode) {
      console.log(styles.info(message));
    }
  }

  static title(message: string): void {
    this.writeToSessionLog('INFO', message);
    this.recordRuntimeLog('INFO', message);
    console.log('\n' + styles.title(message) + '\n');
  }

  static text(message: string): void {
    this.writeToSessionLog('TEXT', message);
    this.recordRuntimeLog('TEXT', message);
    console.log(styles.text(message));
  }

  static highlight(message: string): void {
    this.writeToSessionLog('TEXT', message);
    this.recordRuntimeLog('TEXT', message);
    console.log(styles.highlight(message));
  }

  /**
   * 启动进度指示器
   * @param message 进度消息
   */
  static startProgress(message: string): void {
    if (this.spinner) {
      this.spinner.stop();
    }
    this.spinner = ora(styles.text(message)).start();
  }

  /**
   * 更新进度消息
   * @param message 新的进度消息
   */
  static updateProgress(message: string): void {
    if (this.spinner) {
      this.spinner.text = styles.text(message);
    }
  }

  /**
   * 停止进度指示器
   * @param success 是否成功（true=成功, false=失败, undefined=仅停止）
   * @param message 最终消息（可选）
   */
  static stopProgress(success?: boolean, message?: string): void {
    if (!this.spinner) {
      return;
    }

    if (success === true) {
      this.spinner.succeed(message ? styles.success(message) : undefined);
    } else if (success === false) {
      this.spinner.fail(message ? styles.error(message) : undefined);
    } else {
      this.spinner.stop();
      if (message) {
        console.log(message);
      }
    }

    this.spinner = null;
  }

  /**
   * 显示百分比进度条
   * @param current 当前进度
   * @param total 总数
   * @param message 进度消息（可选）
   */
  static progressBar(current: number, total: number, message?: string): void {
    const percentage = Math.round((current / total) * 100);
    const barLength = 30;
    const filledLength = Math.round((barLength * current) / total);
    const bar = '█'.repeat(filledLength) + '░'.repeat(barLength - filledLength);

    const progressText = `[${bar}] ${percentage}% (${current}/${total})`;
    const fullMessage = message ? `${message} ${progressText}` : progressText;

    if (this.spinner) {
      this.spinner.text = styles.text(fullMessage);
    } else {
      // 使用 \r 实现同行更新
      process.stdout.write('\r' + styles.text(fullMessage));
    }
  }

  /**
   * 清除进度条（换行）
   */
  static clearProgress(): void {
    if (!this.spinner) {
      process.stdout.write('\n');
    }
  }

  static brand(): void {
    const GAP = "   ";    // 左右两边的间距
    const CAT_WIDTH = 35; // ⚡️关键：左侧猫的占位宽度，必须固定！

    // 1. 左侧：猫 (纯文本)
    const leftRaw = [
      '       ▄████▄             ▄████▄',
      '      ████████▄▄▄▄▄▄▄▄▄▄▄████████',
      '      ███████████████████████████',
      '      ▐██▀  ▀██▀  ▀██▀  ▀██▀  ██▌',
      '      ██ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ ██',
      '      ██ ▓▓▓▓██▓▓▓▓▓▓▓▓▓██▓▓▓▓ ██',
      '      ██ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ ██',
      '      ██ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ ██',
      '       ██▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓██',
      '        ▀██▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄██▀'
    ];

    // 2. 右侧：XIAO BA (纯文本，已校对)
    // 包含顶部空行以实现垂直居中
    const rightRaw = [
      '', 
      '   ██╗  ██╗██╗ █████╗  ██████╗     ██████╗  █████╗',
      '   ╚██╗██╔╝██║██╔══██╗██╔═══██╗    ██╔══██╗██╔══██╗',
      '    ╚███╔╝ ██║███████║██║   ██║    ██████╔╝███████║',
      '    ██╔██╗ ██║██╔══██║██║   ██║    ██╔══██╗██╔══██║',
      '   ██╔╝ ██╗██║██║  ██║╚██████╔╝    ██████╔╝██║  ██║',
      '   ╚═╝  ╚═╝╚═╝╚═╝  ╚═╝ ╚═════╝     ╚═════╝ ╚═╝  ╚═╝',
      '',
      '      < Your AI Assistant !!! Meow Meow !!! >'
    ];

    // 3. 循环拼接输出
    console.log('\n'); // 顶部留白

    const maxLines = Math.max(leftRaw.length, rightRaw.length);

    for (let i = 0; i < maxLines; i++) {
      const leftText = leftRaw[i] || '';
      const rightText = rightRaw[i] || '';

      // 核心逻辑：先用空格填满左侧宽度，再上色
      const leftPadded = leftText.padEnd(CAT_WIDTH, ' ');

      // --- 左侧上色 ---
      let leftFinal = styles.brandDeep(leftPadded);
      if (i === 1 || i === 2) leftFinal = styles.brand(leftPadded); // 头顶亮色
      if (i >= 3 && i <= 5)   leftFinal = styles.brandDark(leftPadded); // 眼睛深色

      // --- 右侧上色 ---
      let rightFinal = styles.brandDeep(rightText);
      if (i >= 1 && i <= 6) rightFinal = styles.brand(rightText);   // XIAO BA 亮色
      if (i === 8)          rightFinal = styles.subtitle(rightText); // Slogan 灰色

      // 输出
      console.log(leftFinal + GAP + rightFinal);
    }

    console.log('\n'); // 底部留白
  }
}
