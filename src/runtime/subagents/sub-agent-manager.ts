import { SubAgentJournal } from './sub-agent-journal';
import { AIService } from '../harness/models/ai-service';
import { SkillManager } from '../../capabilities/skills/skill-manager';
import { Logger } from '../observability/logger';
import { SubAgentSession, SubAgentInfo, SubAgentSpawnOptions, SubAgentStatus } from './sub-agent-session';
import { randomUUID } from 'crypto';

// ─── 平台回调注册 ───────────────────────────────────────

export interface PlatformCallbacks {
  /** Promise resolves after parent handling, not merely queue acceptance; reject on failure. */
  injectMessage: (text: string, notice?: SubAgentFeedbackNotice) => Promise<void>;
  /** Read-only activity projection; cannot grant execution authority. */
  onStateChange?: (info: SubAgentInfo) => void;
}

export interface SubAgentFeedbackNotice {
  id: string;
  subagentId: string;
  workingDirectory: string;
  question?: string;
}

export type StopSubAgentResult = 'stopped' | 'not_found' | 'forbidden' | 'not_running';

// ─── SubAgentManager ────────────────────────────────────

/**
 * SubAgentManager - 子智能体管理器（单例）
 *
 * 管理所有后台运行的 SubAgentSession 的生命周期。
 * 按 parentSessionKey 隔离，每个主会话最多同时运行 MAX_CONCURRENT 个子任务。
 */
export class SubAgentManager {
  private static instance: SubAgentManager;

  /** 所有子智能体，key = subagent id */
  private subAgents = new Map<string, SubAgentSession>();
  /** 子智能体 → 父会话 key 的映射 */
  private parentMap = new Map<string, string>();
  /** 持久化的平台回调，key = 父会话 sessionKey */
  private platformCallbacks = new Map<string, PlatformCallbacks>();
  private callbackOwners = new Map<string, object>();
  private readonly deliveringResults = new Set<string>();
  private readonly childPlatforms = new Map<string, PlatformCallbacks>();

  private static readonly MAX_CONCURRENT_PER_SESSION = 3;
  /** 完成后保留信息的时间（ms） */
  private static readonly RETENTION_MS = 30 * 60 * 1000;

  private static isActiveStatus(status: SubAgentStatus): boolean {
    return status === 'running' || status === 'waiting_for_input';
  }

  private constructor() { }

  static getInstance(): SubAgentManager {
    if (!SubAgentManager.instance) {
      SubAgentManager.instance = new SubAgentManager();
    }
    return SubAgentManager.instance;
  }

  // ─── 平台回调注册（由 FeishuBot 等消息入口调用，持久化） ─

  /**
   * 注册平台回调。消息入口在创建/获取 session 时调用一次，
   * 不随 handleMessage 结束而注销，保证子智能体完成后能通知主 Agent。
   */
  registerPlatformCallbacks(sessionKey: string, callbacks: PlatformCallbacks, root = process.cwd()): void {
    this.platformCallbacks.set(sessionKey, callbacks);
    this.callbackOwners.delete(sessionKey);
    this.retryPendingResults(sessionKey, root);
  }

  /** New message in the SAME live Surface: keep child ownership, refresh its route. */
  refreshPlatformCallbacks(sessionKey: string, callbacks: PlatformCallbacks, owner?: object, root = process.cwd()): void {
    const current = this.platformCallbacks.get(sessionKey);
    if (current && this.callbackOwners.get(sessionKey) === owner) {
      current.injectMessage = callbacks.injectMessage;
      current.onStateChange = callbacks.onStateChange;
    }
    else {
      this.registerPlatformCallbacks(sessionKey, callbacks, root);
      if (owner) this.callbackOwners.set(sessionKey, owner);
    }
    this.retryPendingResults(sessionKey, root);
  }

  unregisterPlatformCallbacksForOwner(sessionKey: string, owner: object): void {
    if (this.callbackOwners.get(sessionKey) === owner) this.unregisterPlatformCallbacks(sessionKey);
  }

  /**
   * 注销平台回调。传入 expectedCallbacks 时只删除同一个注册实例，避免旧会话
   * 的迟到 cleanup 误删已经接管相同 session key 的新会话回调。
   */
  unregisterPlatformCallbacks(
    sessionKey: string,
    expectedCallbacks?: PlatformCallbacks,
  ): boolean {
    const current = this.platformCallbacks.get(sessionKey);
    if (!current || (expectedCallbacks && current !== expectedCallbacks)) {
      return false;
    }
    this.callbackOwners.delete(sessionKey);
    return this.platformCallbacks.delete(sessionKey);
  }

  // ─── 子智能体生命周期 ─────────────────────────────────

  /**
   * 派遣子智能体执行任务
   */
  spawn(
    parentSessionKey: string,
    skillName: string | undefined,
    taskDescription: string,
    userMessage: string,
    workingDirectory: string,
    aiService: AIService,
    skillManager: SkillManager,
    spawnOptions: Pick<SubAgentSpawnOptions, 'roleName' | 'allowSkillSelection' | 'observabilityContext' | 'parentSessionId' | 'parentToolCallId'> = {},
  ): SubAgentInfo | { error: string } {
    // 并发限制
    const active = this.listByParent(parentSessionKey,workingDirectory).filter(s => SubAgentManager.isActiveStatus(s.status));
    if (active.length >= SubAgentManager.MAX_CONCURRENT_PER_SESSION) {
      return { error: `最多同时运行 ${SubAgentManager.MAX_CONCURRENT_PER_SESSION} 个子任务，当前已有 ${active.length} 个在运行或等待输入` };
    }

    // 检查显式 skill 是否存在；没有预选 skill 时允许 role-only 或 no-skill 运行。
    const skill = skillName ? skillManager.getSkill(skillName) : undefined;
    if (skillName && !skill) {
      return { error: `Skill "${skillName}" 不存在` };
    }

    const id = `sub-${randomUUID()}`;

    // 获取平台回调（子智能体需要 injectMessage 向主 Agent 报告）
    const platform = this.platformCallbacks.get(parentSessionKey);
    if (!platform) {
      return { error: '平台回调未注册，无法派遣子智能体' };
    }

    const journal = new SubAgentJournal(workingDirectory);
    const recordState = (info: SubAgentInfo) => {
      journal.record(parentSessionKey, info);
      if (this.platformCallbacks.get(parentSessionKey) === platform) {
        try { platform.onStateChange?.(info); }
        catch (error: any) { Logger.warning(`[SubAgentManager] Activity projection failed: ${error.message}`); }
      }
    };
    const options: SubAgentSpawnOptions = {
      onStateChange: recordState,
      parentToolCallId: spawnOptions.parentToolCallId,
      skillName,
      taskDescription,
      userMessage,
      workingDirectory,
      roleName: spawnOptions.roleName,
      allowSkillSelection: spawnOptions.allowSkillSelection ?? Boolean(spawnOptions.roleName && !skillName),
      observabilityContext: spawnOptions.observabilityContext,
      parentSessionId: spawnOptions.parentSessionId ?? parentSessionKey,
      notifyParent: async (subAgentId, taskDesc, question) => {
        const msg = `[子智能体 ${subAgentId} 反馈]\n任务：${taskDesc}\n需要你的指示：${question}`;
        if(this.platformCallbacks.get(parentSessionKey)!==platform) throw new Error('Parent callback is no longer registered.');
        await platform.injectMessage(msg, {
          id: `question:${subAgentId}`, subagentId: subAgentId, workingDirectory, question,
        });
      },
    };

    const session = new SubAgentSession(id, aiService, skillManager, options);
    recordState(session.getInfo());
    this.subAgents.set(id, session);
    this.parentMap.set(id, parentSessionKey);
    this.childPlatforms.set(id, platform);

    // fire-and-forget
    session.run().finally(() => {
      if (session.status !== 'stopped') session.resultNotice = { id: `result:${id}` };
      recordState(session.getInfo());
      // Coalesce successful completion wakeups while this parent's other work is
      // still executing. Questions/failures remain immediate; chat never waits.
      // Even a stopped final child must release previously collected results.
      if (this.platformCallbacks.get(parentSessionKey)===platform) {
        this.retryPendingResults(parentSessionKey, workingDirectory);
      }

      // 完成后保留一段时间供查询，然后清理
      const retentionTimer = setTimeout(() => {
        if (session.resultNotice && !session.resultNotice.handledAt) return;
        this.cleanupReceivedResults(parentSessionKey, workingDirectory);
      }, SubAgentManager.RETENTION_MS);
      retentionTimer.unref?.();
    }).catch(error => Logger.warning(`[SubAgentManager] 子任务结束记录失败: ${error.message}`));

    const skillLabel = skillName || (options.allowSkillSelection ? 'role-selected skill' : 'no skill');
    Logger.info(`[SubAgentManager] 派遣 ${id} 执行 "${skillLabel}"${options.roleName ? ` as ${options.roleName}` : ''} (父会话: ${parentSessionKey})`);
    return session.getInfo();
  }

  /** Retain failed/offline notifications in the existing journal; no second scheduler. */
  retryPendingResults(parent: string, root = process.cwd()): void {
    const platform = this.platformCallbacks.get(parent);
    if (!platform) return;
    for (const info of this.listByParent(parent, root)) {
      if (this.childPlatforms.has(info.id) && this.childPlatforms.get(info.id) !== platform) continue;
      if (info.resultNotice && !info.resultNotice.handledAt) {
        void this.deliverResult(parent, info, root, platform);
      }
    }
  }

  isResultPending(parent: string, notice: SubAgentFeedbackNotice): boolean {
    const info = this.getInfoForParent(parent, notice.subagentId, notice.workingDirectory);
    return info?.resultNotice?.id === notice.id && !info.resultNotice.handledAt;
  }

  shouldHandleFeedback(parent: string, notice: SubAgentFeedbackNotice): boolean {
    if (notice.question === undefined) return this.isResultPending(parent, notice);
    const info = this.getInfoForParent(parent, notice.subagentId, notice.workingDirectory);
    return info?.status === 'waiting_for_input' && info.pendingQuestion === notice.question;
  }

  acknowledgeResult(parent: string, notice: SubAgentFeedbackNotice): void {
    if (!this.isResultPending(parent, notice)) return;
    const journal = new SubAgentJournal(notice.workingDirectory);
    if (!journal.acknowledge(parent, notice.subagentId, notice.id)) return;
    const session = this.subAgents.get(notice.subagentId);
    if (session?.resultNotice?.id === notice.id) session.resultNotice.handledAt = Date.now();
    this.cleanupReceivedResults(parent, notice.workingDirectory);
  }

  private cleanupReceivedResults(parent: string, root: string): void {
    const children = this.listByParent(parent, root);
    if (children.some(info => SubAgentManager.isActiveStatus(info.status)
      || info.status === 'interrupted' || info.resultNotice && !info.resultNotice.handledAt)) return;
    const journal = new SubAgentJournal(root);
    for (const [id, child] of this.subAgents) {
      if (this.parentMap.get(id) !== parent || !child.completedAt
        || Date.now() - child.completedAt < SubAgentManager.RETENTION_MS) continue;
      this.subAgents.delete(id);
      this.parentMap.delete(id);
      this.childPlatforms.delete(id);
      journal.remove(id);
    }
  }

  private async deliverResult(parent: string, info: SubAgentInfo, root: string, platform: PlatformCallbacks): Promise<void> {
    if (!info.resultNotice || info.resultNotice.handledAt) return;
    if (info.status === 'completed' && this.listByParent(parent, root).some(other => other.id !== info.id
      && (SubAgentManager.isActiveStatus(other.status)
        || ['completed', 'failed'].includes(other.status) && !other.resultNotice))) return;
    const key = `${root}:${info.resultNotice.id}`;
    if (this.deliveringResults.has(key)) return;
    this.deliveringResults.add(key);
    const notice = { id: info.resultNotice.id, subagentId: info.id, workingDirectory: root };
    try {
      if (this.platformCallbacks.get(parent) !== platform || !this.isResultPending(parent, notice)) return;
      const files = info.outputFiles.length ? `\n产出文件：\n${info.outputFiles.map(file => `- ${file}`).join('\n')}` : '';
      const missed = info.undeliveredMessages?.length ? `\n未送达补充要求：${JSON.stringify(info.undeliveredMessages)}` : '';
      const text = `[子智能体 ${info.id} ${info.status === 'completed' ? '执行已结束' : info.status}]\n通知：${notice.id}\n任务：${info.taskDescription}\n结果：${info.resultSummary || '（无结果）'}${files}${missed}`;
      await platform.injectMessage(text, notice);
      if (this.platformCallbacks.get(parent) === platform) this.acknowledgeResult(parent, notice);
    } catch (error: any) {
      Logger.warning(`[SubAgentManager] 结果交接未完成，已保留: ${error.message}`);
    } finally {
      this.deliveringResults.delete(key);
    }
  }

  /**
   * 停止子智能体
   */
  stop(subAgentId: string): boolean {
    const session = this.subAgents.get(subAgentId);
    if (!session || !SubAgentManager.isActiveStatus(session.status)) {
      return false;
    }
    session.stop();
    Logger.info(`[SubAgentManager] 已停止 ${subAgentId}`);
    return true;
  }

  /**
   * 按父会话停止子智能体（防止跨会话越权）
   */
  stopForParent(parentSessionKey: string, subAgentId: string): StopSubAgentResult {
    const owner = this.parentMap.get(subAgentId);
    if (!owner) {
      return 'not_found';
    }
    if (owner !== parentSessionKey) {
      return 'forbidden';
    }

    const session = this.subAgents.get(subAgentId);
    if (!session) {
      return 'not_found';
    }
    if (!SubAgentManager.isActiveStatus(session.status)) {
      return 'not_running';
    }

    session.stop();
    Logger.info(`[SubAgentManager] 已停止 ${subAgentId} (父会话: ${parentSessionKey})`);
    return 'stopped';
  }

  /**
   * 恢复挂起的子智能体（主 agent 提供答案）
   */
  resumeForParent(parentSessionKey: string, subAgentId: string, answer: string): 'resumed' | 'not_found' | 'forbidden' | 'not_waiting' {
    const owner = this.parentMap.get(subAgentId);
    if (!owner) return 'not_found';
    if (owner !== parentSessionKey) return 'forbidden';

    const session = this.subAgents.get(subAgentId);
    if (!session) return 'not_found';
    if (!session.resume(answer)) return 'not_waiting';

    Logger.info(`[SubAgentManager] 已恢复 ${subAgentId} (父会话: ${parentSessionKey})`);
    return 'resumed';
  }

  steerForParent(parent: string, id: string, text: string): 'accepted' | 'not_found' | 'forbidden' | 'not_running' {
    const owner = this.parentMap.get(id);
    if (!owner) return 'not_found';
    if (owner !== parent) return 'forbidden';
    return this.subAgents.get(id)?.steer(text) ? 'accepted' : 'not_running';
  }

  /**
   * 子智能体请求父会话输入。
   */
  async requestParentInput(subAgentId: string, question: string): Promise<string> {
    const session = this.subAgents.get(subAgentId);
    if (!session) {
      throw new Error(`未找到子智能体 ${subAgentId}`);
    }
    return session.waitForParentInput(question);
  }

  /**
   * 查询单个子智能体状态
   */
  getInfo(subAgentId: string): SubAgentInfo | undefined {
    return this.subAgents.get(subAgentId)?.getInfo();
  }

  /**
   * 按父会话查询子智能体（防止跨会话越权）
   */
  getInfoForParent(parentSessionKey: string, subAgentId: string, root = process.cwd()): SubAgentInfo | undefined {
    const owner = this.parentMap.get(subAgentId);
    if (!owner) return new SubAgentJournal(root).list(parentSessionKey).find(info=>info.id===subAgentId);
    if (owner !== parentSessionKey) return undefined;
    return this.subAgents.get(subAgentId)?.getInfo();
  }

  /**
   * 列出某个父会话下的所有子智能体
   */
  listByParent(parentSessionKey: string, root = process.cwd()): SubAgentInfo[] {
    const result: SubAgentInfo[] = [];
    for (const [id, session] of this.subAgents) {
      if (this.parentMap.get(id) === parentSessionKey) {
        result.push(session.getInfo());
      }
    }
    const known=new Set(result.map(info=>info.id));
    result.push(...new SubAgentJournal(root).list(parentSessionKey).filter(info=>!known.has(info.id)));
    return result;
  }
}
