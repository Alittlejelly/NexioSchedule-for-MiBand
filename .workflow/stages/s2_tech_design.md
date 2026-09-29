# S2: 技术方案

**⚠️ 重要：仅对 S2 技术方案阶段执行。**

S2 阶段的目标是根据已审核通过的 PRD 文档，结合 Vela 快应用知识库中的开发范式、API 接口文档和组件规范，自动生成技术方案文档。

---

## 阶段概要

| 属性 | 值 |
|------|-----|
| 阶段 ID | S2 |
| 阶段名称 | 技术方案 |
| Agent | `agents/tech_design_agent.prompt.md` |
| 知识库 | `vela/dev-paradigm`、`vela/api-reference`、`vela/components`、`vela/best-practices` |
| 前置条件 | S1 已完成（`session.json` 中 `stages.S1.status === 'completed'`） |
| 产出物 | `{session_dir}/02-tech-design.md` |

---

## 执行步骤

### Step 1: 前置校验

校验 S1 阶段是否已完成，并加载 S1 产出物。

```
🔍 正在校验 S1 前置条件...
```

**1.1 检查 S1 完成状态**

读取 `session.json`，检查 `stages.S1.status` 是否为 `completed`：

```javascript
// 校验前置阶段
const session = resumeSession(sessionId)
const s1Status = session.stages.S1.status
```

| 情况 | 处理方式 |
|------|---------|
| `stages.S1.status === 'completed'` | ✅ 校验通过，继续执行 Step 2 |
| `stages.S1.status !== 'completed'` | ❌ 阻止执行，提示用户先完成 S1 |

若 S1 未完成，输出提示并终止：

```
❌ 无法进入 S2 技术方案阶段
   S1 PRD 生成尚未完成（当前状态: {s1Status}）
   请先完成 S1 阶段后再进入 S2。
```

**1.2 加载 S1 产出物**

确认 S1 产出文件 `01-prd.md` 存在于 Session 目录中：

```javascript
// 加载 S1 产出物路径
const prdPath = `${session_dir}/01-prd.md`
```

| 情况 | 处理方式 |
|------|---------|
| `01-prd.md` 文件存在 | ✅ 继续执行 |
| `01-prd.md` 文件缺失 | ❌ 阻止执行，提示用户 S1 产出物缺失，需重新执行 S1 |

**1.3 更新 Session 状态**

```javascript
// 更新 S2 阶段状态为进行中
updateStageStatus(sessionId, 'S2', 'in_progress')
```

**1.4 项目工程路径**

项目工程路径默认为当前工作区根目录 `.`，不询问用户。S3 阶段执行时，脚手架会在该路径下创建以项目名命名的子目录。

```
📂 项目工程路径: .（当前工作区根目录）
```

```javascript
// 直接使用当前工作区根目录
session.inputs.project_path = '.'
  fs.writeFileSync('.ai-workspace/user-config.json', JSON.stringify(userConfig, null, 2))
}
```

| 情况 | `session.json` | `user-config.json` | 后续影响 |
|------|---------------|-------------------|---------|
| 用户提供有效路径 | `inputs.project_path = "apps/..."` | `project_path = "apps/..."` | Step 2 上下文加载时扫描项目结构 |
| 用户跳过 | `inputs.project_path = null` | 不修改 | Agent 视为全新项目 |
| 已保存路径确认使用 | `inputs.project_path = "apps/..."` | 不修改（已存在） | Step 2 上下文加载时扫描项目结构 |

---

### Step 2: 上下文加载

加载 S2 阶段所需的知识库、前置产出、项目工程现状和 Agent 提示词。

```
📚 正在加载 S2 上下文...
```

**2.1 调用上下文加载器**

```javascript
// 加载阶段上下文（含项目工程扫描）
const context = loadStageContext('S2', session)
```

加载内容说明：

| 资源类型 | 加载内容 | 来源 |
|---------|---------|------|
| SKILL.md | Vela 快应用完整开发指南（项目结构、manifest、组件、API、最佳实践） | `resource-paths.json` → `paths.skill_file` |
| 前置产出 | `01-prd.md`（已审核通过的 PRD 文档） | `workflow-config.json` → `S2.prerequisites: ["S1"]` |
| 项目工程现状 | manifest.json、已有页面、组件、API 依赖等 | `session.json → inputs.project_path` → `scanProjectStructure()` |

> **知识加载策略**：上下文加载器优先加载 SKILL.md 全文作为基础知识。当 Agent 需要某个组件/API 的完整属性列表或边界 case 时，使用 `webFetch` 访问 SKILL.md 中标注的官网链接按需获取详细文档。

> **项目工程扫描策略**：若 `session.json` 中 `inputs.project_path` 不为 `null`，上下文加载器会自动调用 `scanProjectStructure(session)` 扫描项目目录，分析 manifest.json、已有页面列表、自定义组件、系统 API 依赖等，生成项目现状摘要注入到 Agent 上下文中。Agent 据此判断是全新项目还是增量开发，并在技术方案中明确标注新增/修改的页面和组件。

**2.2 注入上下文到 Agent 提示词**

```javascript
// 读取 Agent 提示词模板
const agentPrompt = readFile('agents/tech_design_agent.prompt.md')

// 注入上下文，替换占位符
const injectedPrompt = injectContext(agentPrompt, context)
// 替换: {session.requirement_name} → 需求名称
// 替换: {knowledge_content} → 知识库内容（开发范式 + API 接口 + 组件规范）
// 替换: {previous_outputs} → S1 产出的 01-prd.md 内容
// 替换: {figma_data} → Figma 设计稿数据或"未提供设计稿"
// 替换: {project_analysis} → 项目工程现状分析或"未指定项目工程路径（全新项目）"
```

**错误处理**：

| 错误场景 | 处理方式 |
|---------|---------|
| 知识库文件缺失 | ⚠️ 记录警告，跳过缺失文件，使用可用文件继续执行 |
| Agent 提示词文件缺失 | ❌ 阻止执行，提示用户检查 `agents/tech_design_agent.prompt.md` 是否存在 |
| S1 产出物（01-prd.md）读取失败 | ❌ 阻止执行，提示用户检查 S1 产出物完整性 |

---

### Step 3: Agent 执行

使用注入上下文后的 TechDesign Agent 生成技术方案文档。

```
🤖 正在执行技术方案 Agent...
```

**3.1 执行 TechDesign Agent**

将注入上下文后的 `tech_design_agent.prompt.md` 交给 AI 执行，Agent 按照其内部 Workflow 生成技术方案文档。

Agent 生成的技术方案文档必须包含以下章节：

| 章节 | 说明 |
|------|------|
| 项目类型与变更概览 | 全新项目或已有项目增量开发，变更摘要 |
| 页面结构设计 | 页面列表（含变更类型 🆕/✏️/♻️）、路由配置、页面导航关系图（Mermaid） |
| 组件拆分 | 组件树结构、自定义组件定义（含变更类型）、内置组件使用清单 |
| 数据模型定义 | 页面数据模型、组件数据模型、共享数据结构 |
| API 调用方案 | 系统 API 调用清单（含已声明/需新增标注）、网络请求方案、错误处理策略 |
| 状态管理方案 | 页面内状态、跨页面状态、数据流向图（Mermaid） |
| 文件目录结构 | 完整的项目文件目录结构（含变更类型标注） |
| 变更影响分析 | 仅已有项目：manifest.json 变更、已有文件修改清单、新增文件清单 |

**3.2 API 引用准确性**

Agent 在引用 Vela 快应用 API 时，必须从知识库中查找对应 API 的签名、参数和使用示例，确保引用准确。

**3.3 面向编码 Agent 写作**

技术方案是下游"编码 Agent"的直接输入，必须包含足够的实现细节（类定义、接口签名、数据结构），禁止使用"待定"、"后续补充"等占位描述。

**错误处理**：

| 错误场景 | 处理方式 |
|---------|---------|
| Agent 生成失败 | 🔄 自动重试一次；若仍失败，提示用户并提供选项：[r] 重试 / [e] 修改输入 / [q] 退出保存 |

---

### Step 4: 产出物保存

将生成的技术方案文档保存到 Session 目录。

```
💾 正在保存技术方案文档...
```

**4.1 保存文件**

```javascript
// 保存技术方案到 session 目录
saveFile(`${session_dir}/02-tech-design.md`, techDesignContent)
```

**4.2 更新 Session 状态**

```javascript
// 更新阶段状态为待审核
updateStageStatus(sessionId, 'S2', 'pending_review', '02-tech-design.md')
```

保存完成后输出：

```
✅ 技术方案文档已生成
📄 文件: {session_dir}/02-tech-design.md
```

---

### Step 5: Checkpoint 交互

> ⚠️ **关键规则：必须阻塞等待用户输入**。技术方案文档生成并保存后，展示摘要和操作选项，然后**停止一切后续操作**，等待用户输入 `y`/`e`/`n` 命令。**严禁在用户未明确输入命令前自动进入 S3 功能研发阶段或执行任何后续步骤。**

暂停工作流，展示技术方案摘要，等待用户审核。

```
📋 技术方案摘要:
   • 需求名称: {requirement_name}
   • 页面数: {page_count} 个
   • 自定义组件数: {component_count} 个
   • 系统 API 调用: {api_count} 个
   • 数据模型数: {model_count} 个
   • 文件目录层级: {dir_depth} 层
```

提供操作选项：

```
❓ 请选择操作:
   [y] 确认 — 保存技术方案，标记 S2 完成，进入 S3 功能研发
   [e] 编辑 — 提供修改意见，迭代生成
   [n] 放弃 — 丢弃当前技术方案，重新生成

⏳ 等待您的输入...
```

**命令处理**：

> 严格按照 `.workflow/stages/commands.md` 中定义的逻辑处理用户命令。

| 命令 | 处理逻辑 |
|------|---------|
| `y` | 调用 `updateStageStatus(sessionId, 'S2', 'completed', '02-tech-design.md')`，返回 `workflow_starter.md` 的 Step 5 进行阶段流转 |
| `e` | 接收用户修改意见，追加到 Agent 上下文，重新执行 Step 3（支持多轮迭代） |
| `n` | 丢弃当前产出，调用 `updateStageStatus(sessionId, 'S2', 'in_progress')`，返回 Step 1 重新执行 |

---

## 产出物规范

| 属性 | 值 |
|------|-----|
| 文件名 | `02-tech-design.md` |
| 格式 | Markdown |
| 保存路径 | `.ai-workspace/sessions/{session_id}/02-tech-design.md` |

### 必含章节

1. **页面结构设计** — 页面列表（含变更类型标注）、路由配置、页面导航关系图
2. **组件拆分** — 组件树结构、自定义组件定义（含变更类型标注）、内置组件使用清单
3. **数据模型定义** — 页面数据模型、组件数据模型、共享数据结构
4. **API 调用方案** — 系统 API 调用清单（含已声明/需新增标注）、网络请求方案、错误处理策略
5. **状态管理方案** — 页面内状态、跨页面状态、数据流向图
6. **文件目录结构** — 完整的项目文件目录结构（含变更类型标注）
7. **变更影响分析**（仅已有项目）— manifest.json 变更清单、已有文件修改清单、新增文件清单

---

## 使用的脚本函数

| 函数 | 来源 | 用途 |
|------|------|------|
| `loadStageContext('S2', session)` | `context_loader.js` | 加载知识库、PRD 产出、Figma 数据和项目工程现状 |
| `injectContext(agentPrompt, context)` | `context_loader.js` | 替换 Agent 提示词占位符（含 `{project_analysis}`） |
| `scanProjectStructure(session)` | `context_loader.js` | 扫描项目工程目录，分析已有页面、组件、API 依赖（由 `loadStageContext` 内部调用） |
| `updateStageStatus(sessionId, stageId, status, outputPath)` | `session_manager.js` | 更新阶段状态 |
| `resumeSession(sessionId)` | `session_manager.js` | 恢复 Session（用于前置校验） |

---

## 文件引用

| 文件 | 用途 |
|------|------|
| `agents/tech_design_agent.prompt.md` | 技术方案 Agent 提示词模板 |
| `.workflow/resource-paths.json` | 知识库路径映射 |
| `.workflow/stages/commands.md` | 快捷命令处理逻辑 |
| `.workflow/scripts/context_loader.js` | 上下文加载器 |
| `.workflow/scripts/session_manager.js` | Session 管理器 |
