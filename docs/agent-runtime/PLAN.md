# Agent Runtime PLAN

状态：Active
最后更新：2026-10-31
Owner：Runtime maintainers

## Current Status

完成唤醒合并（2026-10-31，Owner: Runtime，已实现，持续真实模型验收）：实际使用暴露单靠 prompt 仍会逐项播报。现改为同父会话还有活动 child 时暂存成功结果，最后一项结束刷新待交接；失败/问题即时反馈、普通聊天不受影响，停止最后任务也释放已收材料。构建及相关 63/63 检查通过；同步前扩展检查 100/101，唯一失败是已有 macOS 沙箱产物断言。整仓 736/748，12 项均为先前已知失败（含当前环境缺少 npx 的 3 项），未标记全绿。真实模型一轮验证并行和一次综合汇报；后续一轮出现运行失败，尚不宣称稳定完成端到端验收。证据在 output/test/combined-research。下一步：继续验证模型响应质量和真实运行失败原因。

已收结果保留（2026-10-31，Owner: Runtime，已实现）：已确认结果继续进入现有任务视图，包含结果摘要、产物和 result_pending；确认仅表示内部接收。父会话仍有未完成/待接收工作时延长旧材料保留，全部处理后清理过期结果；不增加任务组或调度器。构建通过，相关 109/109 检查通过；另行生命周期/沙箱检查 17/19，剩余两项为原有 macOS 沙箱路径断言。新增回归验证两项真实 shared-loop child 重叠、首项静默接收、跨普通消息与压缩重建保留、超过 30 分钟仍可综合及完成后清理、只交付一次且不重放通知。真实模型 + Dashboard HTTP + 两个 BrowserCat 联网调研通过：39 次成功页面访问、项目先完成时零分项消息，论文完成后一次主动综合汇报，无额外催问，无替换模型输出。证据在 output/test/combined-research。下一步：持续不同任务组合/模型验证相关性和简洁度；本轮未重跑整仓 gate，原有跨进程执行恢复限制不变。

Main 工具面收敛（2026-10-30，Owner: Runtime，已实现）：默认 Main 保留交付、子任务控制、读取和提醒，隐藏通用修改/搜索/Shell 与 ask_parent；显式已安装并激活的 Base Skill 保留执行兼容。Session 使用已有 Skill 加载结果传递名称快照，不在每次工具筛选时扫描目录；显式 Base 不受全局 active role 污染。无连接器/Skill 的共享 Main 从 18 减至 10 个工具，工具 JSON 从 8756 减至 4636 字符（不含 system prompt）。构建通过，定向 87/88；唯一失败为既有 macOS 沙箱产物断言。真实模型 + Dashboard HTTP 验证普通聊天无多余派工、派工期间插话、steer、单次结果交接和 A2UI 交付，全程 Main 使用精简工具面。证据在 output/test/main-tools。整仓 731/743，9 项与先前失败相同，另 3 项因当前环境缺少 npx；对应 CLI 用本地入口补验通过（contract 9/9、单例 1/1、readiness 正常报告 blocked）。下一步：持续真实任务观察工具选择；未证明响应时延或自然度必然改善，原有沙箱/提醒失败仍待独立修复。

OpenAI-compatible 流式中文完整性（2026-10-30，Owner: Runtime）：真实对话暴露逐 Buffer.toString 造成的中文截断乱码，已改为 StringDecoder。新增逐字节分块回归覆盖中文、emoji 和工具参数；构建及相关 32/32 检查通过。对话策略验收由 Roles & Skills PLAN 持有，未改交付授权或执行状态机。

Main/Sub 状态与异步交接（2026-10-30，Owner: Runtime）：已实现 Map + Journal、按变化追加任务视图、Main/Sub 推理边界插话，以及持久化结果通知和成功处理回执。真实 gpt-5.6-luna + Dashboard/Chromium 验收通过：派工、用户插话、steer_subagent、后台期间继续聊天、Sub 按更新后的约束完成、Main 更新原卡片并确认结果；无遗漏插话或重复结果处理。真实代理 500 暴露的会话重试清空历史问题已修复；故障回归验证保留已消费要求和工具结果，ask_parent 不重放。构建、23/23 定向检查、2/2 Chromium 场景通过；整仓 728/737，9 项失败名称与原提交隔离基线一致。证据在 output/test/live-main-sub。下一步：持续真实任务使用，外部 driver/平台验收按各模块推进。限制：live steer inbox 为进程内状态，插话在推理边界消费；通知跨崩溃为 at-least-once，不自动恢复执行游标，不宣称外部副作用 exactly-once。

Intelligent Chat（2026-10-29，Owner: Runtime）：可选 UI channel callback、Main-only send_ui、parentToolCallId 和只读 Subagent 状态投影已实现；Base prompt/skill 显式选择不受全局角色影响。新增协议/Runtime 集成 6/6 通过，完整回归与 HEAD 基线有相同 9 项失败（详见 Surface PLAN）。下一步为真实模型和原生 Electron 打包验收；不增加 Agent loop 或新的角色调度器。

源码目录迁移完成（2026-10-23）：Runtime 子目录与会话公共入口已落地；Arena 审计改为注入接口，新增依赖检查阻止 Runtime 直接引用 Surface、Connector 或 Eval 实现。 验证结果见仓库 PLAN 的 Recent Verification；本模块尚未完成的功能里程碑保持原状态。

- `AgentSession` + `ConversationRunner` is the single model-driven loop for Base and all roles.
- ToolManager enforces base / role / surface layers, role visibility and confirmed-tool gates.
- Tool results, delivery evidence, artifact manifests, provider failures and context compaction have structured runtime facts.
- OpenAI-compatible、Anthropic and Ollama adapters share normalized message/tool boundaries.
- Subagent role dispatch works through shared sessions; bounded status/progress/question/output metadata is durable, while execution cursors remain memory-backed.
- BrowserCat/GuiCat drivers are deterministic adapters and do not run a second Agent/Chat/MCP loop.
- EngineerCat consumes the shared loop with a narrow coding/Skill allowlist, child-side `ask_parent`, and one role-scoped `codex_run` external executor adapter; parent-side controls and XiaoBa-owned nested job/session layers remain absent.
- EvolutionCat `remember` is a deterministic role tool over the existing session-person memory contract.
- Terminal SubAgentSession runs persist standard child `traces.jsonl` with parent, role, selected-skill, tool-result and artifact lineage for nightly evolution and debugging.
- `evolution sleep` uses the lightweight Evolution control workflow; the old typed-route runner is deleted.
- Narrow SubAgent workflows can enforce `allowedWriteRoot` across shared SDK file and Shell execution; unavailable native sandbox execution fails closed.
- Case Replay defaults to an isolated child with a read-only ToolManager; workspace writes require an enforced clean runtime and never expose delivery / Browser / GUI / Secretary tools.
- EngineerCat Source Candidate runs in a secret-free source copy；build and ordinary tests run under a native sandbox, while the two sandbox-in-sandbox contract files run separately with their own native sandbox；source + dist activation is scoped to the next process.
- XiaoBa is a product runtime with a reusable harness core, not yet a public general-purpose Harness SDK.
- Session/model/tool spans can be exported through the default-off OTLP/HTTP bridge; graceful runtime shutdown flushes spans while collector failure remains fail-open.
- One-shot CLI execution forwards an incoming `TRACEPARENT` into `AgentSession`, preserving
  an external Barena turn as the parent of XiaoBa's native session/model/tool spans.

```mermaid
flowchart LR
    Done["AgentSession / Runner<br/>ToolManager / providers"] --> Partial["durable subagents<br/>cancel / idempotency"]
    Partial --> Next["recoverable runtime<br/>Owner-bound execution"]
```

## Milestones

1. Shared AgentSession/ConversationRunner loop：completed。
2. Layered ToolManager and canonical ToolResult：completed for maintained paths。
3. Provider adapter normalization：completed for current adapters。
4. Structured failure/delivery/artifact/compaction evidence：completed for current paths。
5. Role-only subagent dispatch：completed。
6. Durable in-flight subagent recovery and action receipts：partial; interrupted-child inspection and native Connector write receipts implemented, automatic cursor resume remains absent。
7. Provider/Shell end-to-end cancellation：completed for maintained model adapters, compression, retry waits and SDK tools; independent background children require explicit stop。
8. Public Harness SDK extraction：not a current product milestone。
9. Standard `traces.jsonl` for terminal SubAgentSession runs：completed。
10. Lightweight Evolution control：completed；old typed-route runner removed。
11. Bounded SubAgent write root：completed through shared SDK file/Shell execution on supported Linux/macOS hosts; missing sandbox fails closed。
12. Native EngineerCat fallback：completed；small changes and external-executor failure continue through the shared SubAgentSession/ConversationRunner coding tools。
13. OTel trace bridge：completed for session/model/tool spans, W3C parent continuity, redacted OTLP/HTTP export and graceful flushing；metrics/logs export remains out of scope。
14. Replay effect boundary：completed for default read-only and SDK clean-runtime workspace-write; unsupported hosts fail closed。
15. Source Candidate runtime boundary：completed for isolated EngineerCat, full Test and next-process source + dist activation。
16. Narrow EngineerCat Codex adapter：completed；one role-scoped Tool, no job manager/supervisor, native coding fallback retained。

## File-system memory migration

- Owner: Runtime with Observability & Evidence for Markdown layout.
- Completed: bounded per-request index loading, role-owned replacement/forget,
  preservation of manual Markdown and non-resurrection after archive.
- Acceptance: a new Session instance sees saved preferences; unrelated sessions
  stay isolated; manual edits refresh; memory is absent from stored transcript.
- Next: task-follow-up integration within the existing sessionKey boundary; cross-surface person binding is out of scope.

## Next Steps

- Persist exact resume/tool cursors and pending confirmations; extend action continuity beyond native app connectors.
- Carry authenticated principal and Owner authority through ToolExecutionContext.
- Observe maintained cancellation in live use; custom/external adapters must consume the trusted AbortSignal.
- Reduce remaining prose-based legacy ToolResult/artifact inference.
- Package and release-verify BrowserCat/GuiCat adapters without adding driver-side model loops.
- Release-build the optional native Codex package on Windows and Linux; runtime source/build plus macOS arm64 packaged start/resume are verified.

## Owners

- Session lifecycle：`src/runtime/sessions/agent-session.ts`
- Agent loop：`src/runtime/harness/loop/conversation-runner.ts`
- Subagents：`src/runtime/subagents/sub-agent-*`
- Providers：`src/runtime/harness/models/**`
- Tools and execution types：`src/capabilities/tools/**`, `src/runtime/contracts/**`

## Acceptance Criteria

- Every assistant tool call has a matching terminal tool result.
- Failure, timeout, cancel and blocked states are structured and auditable.
- Provider transcript, working trace and durable session remain distinct boundaries.
- Confirmed tools are hidden or blocked unless confirmation matches actor and payload.
- Base and all eight roles use the same runtime loop.
- EngineerCat coding tasks use the shared tool contract through an explicit allowlist; Base externally owns SubAgent lifecycle, EngineerCat may only use `ask_parent` as the child uplink, and the only external model loop is the bounded `codex_run` Tool. It has no parent-side controls or role-local job manager/supervisor.
- External drivers are fixed, bounded capability adapters with version, timeout and trust evidence.
- A SubAgent with `allowedWriteRoot` cannot use file tools or Shell to write outside that root; workflows must hide any separate write control plane that can choose another cwd.
- A default Case Replay cannot call write, Shell, delivery, Browser, GUI or Secretary tools; explicit write Cases require an enforced clean runtime.
- A Source Candidate cannot read production source or write outside its candidate/test roots during Test; passing code activates only for the next process.
- Runtime architecture changes update this PLAN and [`SPEC.md`](SPEC.md) only.
- Enabling OTLP export does not change Agent outcomes or expose prompt, tool argument, file-content or free-form error attributes.

## Risks / Open Questions

- Process crashes preserve child inspection metadata but can still lose exact tool/resume cursors.
- Native Connector receipts block lost-response replay; other external-effect adapters still need their own durable outcome/reconciliation contract.
- Cancellation cannot undo an already completed external effect; supervised SDK process cleanup and provider transport cancellation have contract coverage.
- Tool processes that deliberately detach from the supervised worker group can still require tool-specific cancellation evidence.
- Owner identity is not yet a first-class runtime authorization fact.
- SDK-backed workspace_write Replay and Source Candidate Test require a supported macOS/Linux host; other platforms fail closed.

## Recent Verification

- 2026-10-08: build passed; file-memory/runtime/Role focused tests passed 33/33;
  repository regression passed 591/592. The sole failure remains the existing
  Evolution descendant-process timeout assertion in this cloud container.
  Coverage proves fresh Session recall, edit refresh, root consistency, bounded
  and scoped reads, correction/forget, archive exclusion, legacy Markdown upgrade,
  managed-block integrity and non-persistence of injected memory.

- SubAgent boundary tests include traversal, absolute-path and symlink rejection plus an actual Seatbelt attempt outside `allowedWriteRoot`; `npm test` passed 561/561 tests across 102 suites and `npm run build` passed.
- OTel runtime tests verify session/model/tool-compatible parent topology, incoming W3C ancestry, graceful flushing and fail-open collector errors without changing local span evidence.
- EngineerCat runtime tests verify the coding/Skill/`ask_parent` allowlist, one `codex_run` role tool, the absence of parent-side controls and nested job/session/supervisor tools, plus start/resume, access mode, AbortSignal, secret filtering and artifact evidence.
- A production-path E2E drove `codex_run` through the real AgentSession, ConversationRunner and ToolManager, then resumed the returned thread id on the next user turn with zero changes, commands, external tools or errors.
- Real official-SDK read-only start/resume smoke kept one thread id and produced zero file changes and zero external tool calls; macOS arm64 Electron packaging and an App-contained adapter resume from `/tmp` also passed with no old supervisor payload or duplicate native binary.
- Terminal child trace tests cover success, failure, stop, selected-skill, parent lineage and real tool/artifact results.
- Lightweight Evolution tests cover deterministic Candidate packaging, shared Test/Eval control, fail-closed code Findings, atomic Role/Skill activation and rollback.
- A real Source Candidate validation completed build, ordinary repository tests and the separate native-sandbox contract phase inside the candidate boundary; it passed without activating production source.
- A real-provider Arena `base_skill` proof exposed and fixed Base aliases being resolved as missing Role packages; focused ToolManager/Arena tests now cover the Base tool set without a role package.
- UserCat now hashes the overflow of long Arena run ids instead of truncating away scenario identity, so multi-case pressure keeps distinct native Pet sessions.
- Isolated Arena Role profiles now reuse the production ToolManager with an explicit snapshot-derived role policy: registered tools, provider-visible tools, role-native adapters, allow/deny rules and surface delivery tools are computed rather than hard-coded, without mutating global role resolution state.

## Proactive memory maintenance

Owner: Runtime. Completed: scoped Event admission, proposal-only EvolutionCat on the shared loop with an empty Tool allowlist and one-turn budget, parent isolation, stale-plan rejection, CLI and timezone schedule. Next: operational installation on the user host and continuity within the existing sessionKey boundary. Cancellation is cooperative, not an OS-enforced worker deadline. Verification: build and focused memory/journal/role/security 39/39 passed, including a real EvolutionCat loop and CLI entry.

## Shared scheduled events

Owner: Runtime. Completed: manual/scheduled Event admission for both jobs, failure isolation, no minute retry of failed/in-flight work, preserved supervised Evolution worker and memory proposal/cursor boundaries. Worker entry remains internal and does not recursively admit Events. Next: operational observation; no automatic interrupted-work recovery introduced. Focused 45/46 and full regression 615/616; the sole failure in both is the pre-existing cloud descendant-process assertion.

## Session timed wakeups

Owner: Runtime. Completed: trusted Base timer tool and child denial; original session restoration; direct reminder vs shared-loop check; quiet outcomes; CLI failure propagation; transient per-request clock and memory-finalizer exclusion. Acceptance verified through a real AgentSession plus lifecycle/owner/revision/concurrency tests. No cross-surface person binding. Remaining: a busy transition after admission can fail a check; interrupted work requires inspection. Next: observe proactive-check quality and frequency in real use. Build and focused 47/47 passed; full regression 630/631 passed; the sole failure remains the pre-existing cloud Evolution descendant-process SIGKILL assertion.

## Agent-owned app connections

Owner: Runtime. Completed: Base operation discovery/read/write tools, trusted main-session validation during discovery and execution, exact nested payload confirmation and successful channel delivery evidence. New app tools do not inherit authority in children or bypass role allowlists. Next: optional constrained delegation if needed. Limits: Connector policy does not sandbox other Shell/file tools; hostile tenant isolation remains separate runtime work.

Verification: TypeScript build and focused native connector / Feishu boundary / role-tool tests 39/39 passed, including real AgentSession confirmed-write execution with mocked official HTTP. Full regression 650/651 passed; the only failure remains the pre-existing cloud Evolution descendant-process SIGKILL assertion. Live app accounts are not yet verified.


Dashboard credential integration: default Connector service reads the shared Agent credential file, so new calls in running sessions use newly saved/revoked authorization without changing session scope. Existing injectable AgentCredentials and environment configuration stay supported; no new Agent loop or chat credential tool. Verification is owned by Surface/Evidence plans.


Dashboard simplification: completed. Three authorization-only cards reuse existing Skills/Store components and the shared modal/config fields; no requester/scope/Feishu/control panel remains. Token connection and Google callback verify accounts automatically. All configured/enabled app operations are available by default to valid main sessions; retired grants are ignored/removed on the next write. Google OAuth covers all implemented mail operations through gmail.modify. Write confirmation and existing role/child boundaries remain intact.

Verification: build and focused 50/50 passed, including cross-surface default reads/writes, old-config migration, retired API absence and exact write-confirmation tests. Real Chromium validated shared computed card styles, token/OAuth connection, all-operation defaults, disconnect, mobile modal and Electron renderer external authorization with mocked providers and no page errors. Full regression 658/659 passed; the sole failure remains the pre-existing cloud Evolution descendant-process SIGKILL assertion. Real provider credentials/consent and native OS browser launch remain user-host checks.


## Unified sandbox execution

Owner: Runtime. Completed: pinned Anthropic Sandbox Runtime 0.0.79, one SDK worker per invocation, trusted policies, bounded output/time/cancellation, private HOME/TMP, credential/session-memory exclusions and proxy filtering. Shell and file tools share the boundary; native Seatbelt generators and unsandboxed options are removed. Arena/Evolution reuse policy JSON; provider transports explicitly use the SDK proxy. Source Candidate native-contract tests remain inside SDK isolation. Codex internal sandbox and capability drivers retain their separate external contracts.

Verification: build, Electron JS syntax and frozen npm ci passed. Acceptance 48/48 passed; all 10 real SDK contract tests passed without skips, covering missing dependencies, subprocess/symlink writes, file/env secrets, concurrent policies, allowed/denied/direct network, output limits, timeout descendants, cancellation, file tools, current-session memory and three model provider transports with local mocked HTTP. CLI `sandbox check` returned available=true on Linux. Full regression 669/670 passed with only the unchanged cloud Evolution descendant PID/zombie assertion failing. SDK vendor binaries and .mjs/.cjs resources are included by Electron packaging filters; desktop Node selection/Doctor now require the SDK's exact >=22.12 floor.

Remaining: macOS packaged execution and Windows support are not verified here; Windows adapter execution explicitly blocks. CPU/memory/PID quotas and crash recovery remain separate work. This cloud installs signed Debian socat into a user directory; setup/start instructions export its PATH. npm ci skips the optional Electron binary download because its direct GitHub DNS route is unavailable; native Electron launch/build was not validated.

## Cancellation and external action continuity

Owner: Runtime. Implemented: request-owned cancellation through provider transports, compression and retry waits, preserving completed tool evidence and suppressing late replies; Connector receipts protect same-call replay and uncertain identical writes. Interrupted child metadata is visible to the original parent after process termination, without automatic replay or transcript resume. Final focused integration 98/98 passed (serial final integration), including actual local HTTP cancellation, per-request action identity and killed-process recovery. Full regression before the final action-scope refinement: 692/693 passed, zero skips; sole failure remains the existing cloud Evolution descendant PID/zombie assertion.

## Asynchronous conversation

Implemented: lifecycle-owned callback refresh, session-idle turn serialization (IM feedback and Weixin inbound), active-task TTL protection and conversational prompt guidance. Focused 85/85 passed, including actual shared-loop acknowledgement → dispatch → intervening chat → result delivery, owner replacement, shutdown, queue isolation/error recovery and internal approval denial. Full regression 700/701 passed (zero skips); sole failure remains the existing cloud Evolution descendant PID/zombie assertion. Final shutdown-order/route guard refinement passed 20/20 focused lifecycle/reminder tests; build passed. Natural tone/proactive relevance still need live-model use; scripted tests establish transport/lifecycle behavior only. Connector live-account work is deferred by user preference.
