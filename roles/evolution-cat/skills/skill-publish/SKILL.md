---
name: skill-publish
description: "将已有 Skill 发布为兼容 skills.sh 的公开 GitHub 源，验证标准 SKILL.md 和单项安装方式；不再向私有 SkillHub 提交 registry.json。"
invocable: user
autoInvocable: false
argument-hint: "<skill名称>"
max-turns: 20
---

# EvolutionCat Skill Publish

将本地已有的 Skill 整理为开放 Agent Skills 生态可安装的 GitHub 源。XiaoBa 商店使用 https://skills.sh 的公开目录；不再依赖 XiaoBa-SkillHub 索引或 registry-only PR。

## 准备资产

1. 根据 `$ARGUMENTS` 找到已安装的 Skill，读取 SKILL.md 和它引用的附属文件。隔离 Candidate 仍需通过共享 Test + Eval 后才能发布。
2. 保持标准 frontmatter：`name` 为稳定的小写连字符名称，`description` 说明适用场景。保留实际需要的 scripts、references 和 assets，相对引用必须仍可解析。
3. 检查待发布目录不含凭据、私人记忆、会话日志、运行输出或 node_modules；明确作者和许可。
4. 使用用户指定的公开 GitHub 仓库。可在根目录放一个 SKILL.md，或在 `skills/<name>/SKILL.md` 放多个独立 Skill。

## 发布与验证

- 在执行公开推送、创建仓库或 PR 前，向用户展示具体仓库、文件差异和发布说明，并取得发布授权；用户已明确授权的具体操作无需反复确认。
- 发布只修改该 Skill 源仓库。不 fork 或修改旧 XiaoBa-SkillHub，不创建 registry.json 条目。
- 检查官方 CLI 能发现目标 Skill：`npx skills add <owner/repo> --list`。该命令仅列出技能；不要为了增加目录数据模拟安装量。
- 提供安装指令：`xiaoba skill add <owner/repo> --skill <name>`，以及生态通用指令 `npx skills add <owner/repo> --skill <name>`。
- GitHub 发布成功不等于 skills.sh 已收录或下载快照已就绪。通过 https://skills.sh 搜索确认；未收录时如实说明，并提供 XiaoBa 现有的 GitHub 手动安装路径，不伪造商店链接或承诺即时上榜。
- 不自动运行生态 CLI 的安装、上传或遥测操作；涉及这些操作时遵循用户本次授权范围。

## 交付

报告源仓库、发布 revision、Skill 名称、许可、安装指令和实际验证结果。区分「源码已公开」「目录可搜索」「下载可用」三个实际状态；它们不是 XiaoBa runtime 的能力生命周期状态。
