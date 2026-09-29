# Harness Engineering 实践指南：Vela 快应用 AI Coding 体系优化

> 把 AI Coding 从"靠 Prompt 碰运气"提升到"靠工程体系可控、可验证、可复用"。

## 一、问题诊断：为什么 Agent 不听话？

### 1.1 现象

用户选择「快速模式」后，AI 没有按照 `vela-s3-coding` agent 的规范创建项目：
- 路由到了错误的 agent（`vela-quick` 而非 `vela-s3-coding`）
- 脚手架命令缺少 `--template vela-demo` 参数
- 创建出来的项目结构不符合预期

### 1.2 根因分析

| 问题 | 影响 |
|------|------|
| **约束与流程混杂** | Agent 文件 600+ 行，AI 无法区分"必须遵守的约束"和"建议的流程步骤" |
| **约束重复 5 次** | 组件白名单在每个 agent 中各写一遍，稍有修改就会遗漏 |
| **Handoff 路由模糊** | 快速模式没有专用 handoff，AI 靠关键词猜测目标 agent |
| **独立 Agent 冲突** | `vela-quick` 与 `vela-s3-coding` 职责重叠，AI 随机选择 |
| **Rules 层缺失** | 只有 1 个 rule（project-init.md），大量硬约束散落在 agent 里 |
| **Prompts 与 Agents 重叠** | Stage-specific prompt 和 agent 内容高度重复，浪费 context |

### 1.3 核心矛盾

> **Agent 应该是"轨道"，不是"缰绳+轨道+质检+记忆"的混合体。**

当一个文件同时承载约束（什么不能做）和流程（怎么做）时，AI 会：
- 混淆优先级，把约束当作建议
- 在长文本中丢失关键约束
- 跳过"看起来不重要"的段落

---

## 二、Harness Engineering 核心理念

```
Harness Engineering = 缰绳（Rules）+ 轨道（Agents）+ 知识库（Prompts）+ 入口（Instructions）
```

### 2.1 三层分离架构

```
.github/
├── rules/               ← 缰绳：编译时约束（alwaysApply，AI 无条件遵守）
├── agents/              ← 轨道：运行时行为体（纯流程编排，rules 自动注入约束）
├── prompts/             ← 知识库：按需加载的参考文档
└── copilot-instructions.md  ← 入口：架构说明 + 触发条件
```

### 2.2 各层职责对比

| 层级 | 职责 | 加载方式 | 特点 | 类比 |
|------|------|----------|------|------|
| **Rules** | 硬约束（什么不能做） | `alwaysApply`，自动注入 | 不可协商、可验证 | 缰绳 |
| **Agents** | 流程编排（怎么做） | 按任务 handoff 调度 | 关注行为序列 | 轨道 |
| **Prompts** | 知识参考（做得好） | 按需引用 | 详细文档、示例 | 知识库 |
| **Instructions** | 全局入口 | 自动加载 | 触发条件 + 架构总览 | 说明书 |

### 2.3 设计原则

1. **单一职责**：每个文件只做一件事（约束 OR 流程 OR 知识）
2. **零重复**：约束只定义一次，通过 `alwaysApply` 自动注入所有 agent
3. **可验证**：每条约束都有明确的判定标准（✅/❌）
4. **最小 Context**：Agent 文件只写流程，不重复已有的约束

---

## 三、重构实施过程

### 3.1 诊断阶段：梳理现有结构

```
重构前文件清单：
.github/
├── copilot-instructions.md          ← 170+ 行，工作流+约束+Agent说明混杂
├── agents/
│   ├── vela-workflow.agent.md       ← 7.5KB，协调器
│   ├── vela-s1-prd.agent.md         ← 4.3KB，PRD 生成
│   ├── vela-s2-tech.agent.md        ← 4.3KB，技术方案
│   ├── vela-s3-coding.agent.md      ← 18KB（643行），代码生成 ← 最臃肿
│   ├── vela-quick.agent.md          ← 4.5KB，快速模式 ← 与 s3 冲突
│   └── vela-knowledge.agent.md      ← 2.2KB，知识库查询
├── prompts/
│   ├── vela-dev-guide.prompt.md     ← 19KB，完整开发指南
│   ├── vela-components.prompt.md    ← 2.9KB，组件速查
│   ├── vela-apis.prompt.md          ← 3.1KB，API 速查
│   ├── vela-best-practices.prompt.md ← 2.4KB，最佳实践
│   ├── vela-s1-prd.prompt.md        ← 1.2KB，与 agent 重复
│   ├── vela-s2-tech.prompt.md       ← 1.0KB，与 agent 重复
│   └── vela-s3-coding.prompt.md     ← 4.7KB，与 agent 重复
└── rules/
    └── project-init.md              ← 唯一的 rule，还缺 --template 参数
```

**关键发现**：
- 组件白名单、API 白名单、禁止项在 **5 个 agent 中各写一遍**
- `vela-s3-coding` 混杂了约束（30%）+ 流程（50%）+ 模板（20%）
- `vela-quick` 和 `vela-s3-coding` 的脚手架命令不一致
- 3 个 stage-specific prompt 与 agent 内容 90% 重复

### 3.2 设计阶段：规划目标结构

```
目标结构：
.github/
├── rules/                              ← 5 个 rule（新建 4 个，更新 1 个）
│   ├── vela-platform.md                ← 平台约束：组件+API+禁止依赖+生命周期
│   ├── vela-format.md                  ← 格式规范：.ux+manifest+package.json
│   ├── vela-layout.md                  ← 布局规范：CSS+圆屏安全区域
│   ├── vela-quality.md                 ← 质量标准：命名+错误处理+资源清理
│   └── project-init.md                 ← 初始化规范：脚手架命令（更新）
├── agents/                             ← 5 个 agent（全部重写为轻量版）
│   ├── vela-workflow.agent.md          ← 协调器（7.5KB → 3.5KB，精简53%）
│   ├── vela-s1-prd.agent.md            ← PRD（4.3KB → 2.3KB，精简47%）
│   ├── vela-s2-tech.agent.md           ← 技术方案（4.3KB → 2.3KB，精简46%）
│   ├── vela-s3-coding.agent.md         ← 代码生成（18KB → 5.5KB，精简69%）
│   └── vela-knowledge.agent.md         ← 知识库（保持精简）
├── prompts/                            ← 4 个 prompt（删除 3 个重复的）
│   ├── vela-dev-guide.prompt.md        ← 完整开发指南（保留）
│   ├── vela-components.prompt.md       ← 组件速查（保留）
│   ├── vela-apis.prompt.md             ← API 速查（保留）
│   └── vela-best-practices.prompt.md   ← 最佳实践（保留）
└── copilot-instructions.md             ← 精简入口（170行 → 60行）
```

### 3.3 实施阶段：四步完成重构

#### Step 1：建立 Rules 层（新建 4 个 + 更新 1 个）

**`rules/vela-platform.md`** — 平台硬约束

```yaml
---
description: VelaOS 平台硬约束 — 组件白名单、API 白名单、禁止的第三方依赖、生命周期、数据对象
alwaysApply: true
---
```

核心内容：
- ✅ 组件白名单（21 个内置组件）
- ✅ API 白名单（20 个 @system.xxx）
- ✅ 禁止依赖表（UI库/JS库/框架/构建工具）
- ✅ 页面生命周期顺序
- ✅ 数据对象作用域

**`rules/vela-format.md`** — 文件格式规范

核心内容：
- ✅ .ux 文件三段式结构（template + style + script）
- ✅ manifest.json 必需字段和正确嵌套（designWidth 在 config 内部）
- ✅ package.json 标准模板（aiot-toolkit，禁止 hap-toolkit）
- ✅ 项目目录结构
- ✅ 禁止 @import

**`rules/vela-layout.md`** — 布局规范

核心内容：
- ✅ Flexbox 布局（div 默认 column）
- ✅ 圆屏安全区域（上下 10%，左右 7-8%）
- ✅ 滚动容器（超出一屏必须用 scroll）
- ✅ 字体/颜色建议

**`rules/vela-quality.md`** — 代码质量标准

核心内容：
- ✅ 命名规范（camelCase/PascalCase/UPPER_SNAKE_CASE）
- ✅ 错误处理（所有 API 调用必须有 fail 处理）
- ✅ 资源清理（onDestroy 清理定时器/事件监听）
- ✅ 禁止行为表（7 项）
- ✅ 代码自检清单（9 项）

**`rules/project-init.md`** — 初始化规范（更新）

关键修改：
- 修复：`npx create-aiot ux --name {项目名}` → `npx create-aiot ux --name {项目名} --template vela-demo`
- 添加：`--template vela-demo` 说明，避免交互式阻塞
- 添加：执行前检查清单（项目名规范、目录冲突、npm 源、npx 可用性）

#### Step 2：精简 Agents 层（全部重写）

**改造模式**：每个 agent 文件开头添加一行：

```
> 📌 平台约束（组件、API、禁止依赖）由 `.github/rules/` 自动注入，本 Agent 无需重复声明。
```

**vela-s3-coding.agent.md 改造对比**：

| 改造前 | 改造后 |
|--------|--------|
| 内联组件白名单（20行） | 删除，引用 rules |
| 内联 API 白名单（15行） | 删除，引用 rules |
| 内联禁止依赖表（10行） | 删除，引用 rules |
| 内联 manifest 规范（25行） | 删除，引用 rules |
| 内联 CSS 规范（10行） | 删除，引用 rules |
| 内联安全区域规范（15行） | 删除，引用 rules |
| 内联 .ux 格式规范（20行） | 删除，引用 rules |
| 内联 package.json 模板（15行） | 删除，引用 rules |
| **合计删除 ~130 行约束** | 保留 ~140 行纯流程 |

**新增 handoff（修复快速模式路由）**：

```yaml
handoffs:
  # 原有 3 个
  - label: 生成 PRD
    agent: Vela PRD 生成
  - label: 生成技术方案
    agent: Vela 技术方案
  - label: 生成代码
    agent: Vela 代码生成
  # 新增：快速模式专用
  - label: 快速模式生成代码
    agent: Vela 代码生成
    prompt: 快速模式：跳过 PRD 和技术方案，直接根据需求生成代码。使用 npx create-aiot ux --name {项目名} --template vela-demo 初始化。
```

#### Step 3：删除冲突文件

```
删除清单：
- ❌ agents/vela-quick.agent.md          ← 与 s3-coding 职责冲突
- ❌ prompts/vela-s1-prd.prompt.md       ← 与 agent 内容 90% 重复
- ❌ prompts/vela-s2-tech.prompt.md      ← 与 agent 内容 90% 重复
- ❌ prompts/vela-s3-coding.prompt.md    ← 与 agent 内容 90% 重复
```

#### Step 4：更新入口层

`copilot-instructions.md` 从 170+ 行精简到 60 行，只保留：
- 触发条件
- 工程体系架构图
- 三层设计原则说明
- Agent 列表

---

## 四、重构效果对比

### 4.1 量化指标

| 指标 | 重构前 | 重构后 | 改善 |
|------|--------|--------|------|
| **约束定义次数** | 5 次（每个 agent 各写一遍） | 1 次（rules 自动注入） | ↓ 80% |
| **agent 总行数** | ~900 行 | ~380 行 | ↓ 58% |
| **vela-s3-coding 行数** | 643 行 | ~140 行 | ↓ 78% |
| **copilot-instructions 行数** | 170+ 行 | ~60 行 | ↓ 65% |
| **prompts 文件数** | 7 个 | 4 个 | ↓ 43% |
| **rules 文件数** | 1 个 | 5 个 | ↑ 400% |
| **冲突 agent 数** | 1（vela-quick） | 0 | ✅ 消除 |

### 4.2 质量指标

| 指标 | 重构前 | 重构后 |
|------|--------|--------|
| 约束一致性 | ❌ 5 个文件可能不同步 | ✅ 单一来源，零冲突 |
| AI 约束遵守率 | 低（约束被长文本淹没） | 高（rules alwaysApply 强制注入） |
| 快速模式路由准确性 | ❌ 可能路由到 vela-quick | ✅ 专用 handoff label |
| 脚手架命令正确性 | ❌ vela-quick 缺少 --template | ✅ 统一为 --template vela-demo |
| 新增约束成本 | 修改 5 个 agent 文件 | 只修改 1 个 rule 文件 |

---

## 五、关键经验总结

### 5.1 Agent 文件应该写什么、不写什么

```
Agent 应该写：                    Agent 不应该写：
✅ 角色定义（你是谁）              ❌ 组件白名单（→ rules/vela-platform.md）
✅ 执行步骤（做什么）              ❌ API 白名单（→ rules/vela-platform.md）
✅ 输入输出格式                    ❌ 禁止依赖表（→ rules/vela-platform.md）
✅ Checkpoint 交互                ❌ 文件格式规范（→ rules/vela-format.md）
✅ handoff 路由                   ❌ CSS 规范（→ rules/vela-layout.md）
✅ 失败处理逻辑                    ❌ 命名规范（→ rules/vela-quality.md）
                                 ❌ 脚手架命令（→ rules/project-init.md）
```

### 5.2 Rules 文件的编写规范

每条 rule 必须包含：

1. **YAML frontmatter**：
   ```yaml
   ---
   description: 一句话描述这条规则约束什么
   alwaysApply: true    # true = 无条件遵守，false = 按需加载
   ---
   ```

2. **醒目标记**：
   ```markdown
   > ⚠️ 本文件为强制执行规则，AI 必须无条件遵守，不可协商或降级。
   ```

3. **可验证的标准**：每条约束都有 ✅/❌ 示例或判定条件

### 5.3 Handoff 路由设计原则

```yaml
# ✅ 好的设计：每个 handoff 有唯一的 label 和明确的 prompt
handoffs:
  - label: 生成 PRD          # 唯一标签
    agent: Vela PRD 生成      # 目标 agent
    prompt: 请根据需求生成 PRD  # 明确指令
  - label: 快速模式生成代码    # 不同模式用不同 label
    agent: Vela 代码生成
    prompt: 快速模式：跳过 PRD...  # 指定具体行为

# ❌ 坏的设计：模糊的 label，AI 无法区分
handoffs:
  - label: 下一步
    agent: ???  # AI 不知道该去哪个 agent
```

### 5.4 什么时候该拆文件

| 信号 | 处理方式 |
|------|----------|
| 同一段内容在 3+ 个文件中出现 | 提取为 rule |
| 单个 agent 文件超过 200 行 | 检查是否有约束可以提取到 rules |
| 两个 agent 职责重叠 | 合并或删除冗余的 |
| AI 经常忽略某条约束 | 从 agent 提取到 rule（alwaysApply） |

### 5.5 常见反模式

| 反模式 | 问题 | 正确做法 |
|--------|------|----------|
| 在 agent 中内联所有规范 | 约束被流程淹没，AI 忽略 | 提取到 rules |
| 每个 agent 重复写组件白名单 | 修改时容易遗漏 | 单一来源 rules |
| 创建多个功能重叠的 agent | AI 随机选择 | 合并或明确 handoff |
| copilot-instructions 写完整工作流 | 过长，AI 无法聚焦 | 只写触发条件和架构 |
| prompt 和 agent 内容 90% 重复 | 浪费 context | 删除 stage-specific prompt |

---

## 六、快速复用指南

如果你想在自己的项目中应用 Harness Engineering，按以下步骤操作：

### Step 1：诊断

```bash
# 统计约束重复次数
grep -r "白名单\|禁止\|不允许" .github/agents/ | wc -l

# 统计 agent 平均行数
wc -l .github/agents/*.md

# 检查是否有冲突 agent
grep -l "相似关键词" .github/agents/*.md
```

### Step 2：提取 Rules

```
1. 在所有 agent 中找到重复的约束内容
2. 按主题分类（平台/格式/布局/质量/初始化）
3. 创建对应的 rules/*.md 文件
4. 每个 rule 添加 alwaysApply: true
```

### Step 3：精简 Agents

```
1. 删除 agent 中已提取到 rules 的约束内容
2. 添加引用说明：`.github/rules/` 自动注入
3. 确保 agent 只保留流程编排逻辑
4. 检查 handoff 路由是否明确
```

### Step 4：清理

```
1. 删除与 agent 重复的 stage-specific prompts
2. 删除功能冲突的 agent
3. 精简 copilot-instructions.md
4. 验证最终结构
```

---

## 附录：最终文件结构

```
.github/
├── copilot-instructions.md              # 入口层：触发条件 + 架构说明
├── rules/                               # Rules 层：硬约束（alwaysApply）
│   ├── vela-platform.md                 # 平台约束：组件+API+禁止依赖+生命周期
│   ├── vela-format.md                   # 格式规范：.ux+manifest+package.json
│   ├── vela-layout.md                   # 布局规范：CSS+圆屏安全区域
│   ├── vela-quality.md                  # 质量标准：命名+错误处理+资源清理
│   └── project-init.md                  # 初始化规范：脚手架命令+检查清单
├── agents/                              # Agents 层：流程编排（引用 rules）
│   ├── vela-workflow.agent.md           # 工作流协调器（S1→S2→S3）
│   ├── vela-s1-prd.agent.md             # S1 PRD 生成
│   ├── vela-s2-tech.agent.md            # S2 技术方案
│   ├── vela-s3-coding.agent.md          # S3 代码生成（含快速模式）
│   └── vela-knowledge.agent.md          # 知识库查询
└── prompts/                             # Prompts 层：知识参考（按需加载）
    ├── vela-dev-guide.prompt.md         # 完整开发指南
    ├── vela-components.prompt.md        # 组件用法速查
    ├── vela-apis.prompt.md              # API 速查
    └── vela-best-practices.prompt.md    # 最佳实践
```
