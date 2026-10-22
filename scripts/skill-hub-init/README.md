# XiaoBa SkillHub

本目录保存初始化独立 SkillHub 仓库的 README 与索引模板。XiaoBa 应用自身的本地商店索引资源位于 `../../skills/registry.json`。

XiaoBa 官方 Skill 商店索引仓库。

当前官方仓库：

```text
https://github.com/fightheyyy/XiaoBa-SkillHub
```

## 什么是 Skill Hub？

Skill Hub 是 XiaoBa 的能力扩展市场。开发者可以将自己开发的 Skill 发布到这里，让所有 XiaoBa 用户都能通过 Dashboard 一键安装。

## 架构设计

- **去中心化**：Skill 代码托管在开发者自己的 GitHub 仓库
- **轻量级索引**：本仓库只维护 `registry.json` 索引文件
- **社区驱动**：任何人都可以通过 PR 贡献新 Skill

SkillHub PR 必须保持轻量：

- 只修改 `registry.json`
- 只新增或修正目标 skill 的 registry 条目
- 不把 skill 源码复制到 SkillHub 仓库
- 通过 fork SkillHub 提交 PR；fork 中也只保留 `registry.json` 增量
- 不重排、删除、批量格式化已有 registry 条目

## 如何发布 Skill？

### 方法 1：使用 skill-publish（推荐）

XiaoBa 内置了 `skill-publish` skill，可以引导完成发布流程：

```bash
# 在 XiaoBa 中执行
/skill-publish <你的skill名称>
```

它会引导你：

1. 确认本地 skill 元数据
2. 使用独立公开 GitHub 仓库托管 skill 代码
3. Fork 官方 `fightheyyy/XiaoBa-SkillHub`
4. Clone fork，并从官方 `main` 新建发布分支
5. 只对 `registry.json` 做增量更新
6. 推送 fork 分支并提交 registry-only PR

### 方法 2：手动发布

1. **创建 Skill 仓库**
   - 在 GitHub 创建公开仓库（建议命名：`xiaoba-skill-<name>`）
   - 推送你的 skill 代码（必须包含 `SKILL.md`）

2. **Fork 本仓库**

   Fork 当前官方仓库：

   ```text
   https://github.com/fightheyyy/XiaoBa-SkillHub
   ```

   然后 clone 你的 fork，并从官方 `main` 新建发布分支。

3. **编辑 registry.json**

   只添加你的 skill 条目，避免改动已有条目：

   ```json
   {
     "name": "your-skill-name",
     "description": "简短描述你的 skill 功能",
     "category": "工具",
     "recommended": false,
     "repo": "https://github.com/your-username/xiaoba-skill-your-skill-name"
   }
   ```

4. **提交 PR**

   PR 标题：`Add skill: <skill-name>`

   PR 要求：

   - base repo 是 `fightheyyy/XiaoBa-SkillHub`
   - changed files 只有 `registry.json`
   - diff 只包含目标 skill 的索引增量

   `fightheyyy` 维护者也可以按仓库 ruleset bypass 直接推送 `main`，但默认贡献流程仍推荐 fork PR。

## Registry 字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | string | Skill 名称（必须与 SKILL.md 中的 name 一致） |
| `description` | string | 简短描述（建议 50 字以内） |
| `category` | string | 分类：核心、工具、效率、科研、运维、其他 |
| `recommended` | boolean | 是否推荐（由维护者决定） |
| `repo` | string | GitHub 仓库地址（完整 URL） |

## Skill 开发规范

### 必需文件

- `SKILL.md`：Skill 元数据和使用说明

### 可选文件

- `requirements.txt`：Python 依赖
- `*.py`：Python 工具脚本
- `*.ts` / `*.js`：TypeScript/JavaScript 工具

### SKILL.md 格式

```markdown
---
name: your-skill-name
description: "简短描述"
invocable: user
autoInvocable: false
argument-hint: "<参数提示>"
max-turns: 20
---

# Skill 名称

详细说明...
```

## 审核标准

PR 会根据以下标准审核：

- ✅ SKILL.md 格式正确
- ✅ 功能描述清晰
- ✅ 代码质量良好
- ✅ 无恶意代码
- ✅ 无重复功能

## 社区

- 问题反馈：[Issues](https://github.com/fightheyyy/XiaoBa-SkillHub/issues)
- 讨论交流：[Discussions](https://github.com/fightheyyy/XiaoBa-SkillHub/discussions)

## License

MIT
