# S1: PRD 生成

**⚠️ 重要：仅对 S1 PRD 生成阶段执行。**

S1 阶段的目标是根据设计稿和需求描述，结合 Vela 快应用知识库，自动生成标准 PRD 文档。

---

## 阶段概要

| 属性 | 值 |
|------|-----|
| 阶段 ID | S1 |
| 阶段名称 | PRD 生成 |
| Agent | `agents/prd_agent.prompt.md` |
| 知识库 | `vela/dev-paradigm` |
| 前置条件 | 无 |
| 产出物 | `{session_dir}/01-prd.md` |

---

## 执行步骤

### Step 1: 输入收集

收集 PRD 生成所需的用户输入。

```
📝 S1 输入收集
```

**1.1 需求描述收集**

向用户询问需求描述内容：

```
📋 请提供需求描述（支持文字或 Markdown 格式）:
   描述你想要开发的 Vela 快应用功能，包括：
   • 需求背景与目标
   • 核心功能点
   • 目标用户与使用场景
```

接收用户输入后，将需求描述保存到 `session.json` 的 `inputs.requirement_description` 字段。

**1.2 屏幕适配规格收集**

询问用户目标设备的屏幕规格：

```
📐 请提供目标屏幕适配规格:
   • 屏幕像素尺寸（如 300×400）
   • 屏幕形状: 圆屏(round) / 跑道屏(oval) / 方屏(square)
```

接收用户输入后，将屏幕规格保存到 `session.json` 的 `inputs.screen_spec` 字段：

```javascript
session.inputs.screen_spec = { width: 300, height: 400, shape: 'square' }
```

**1.3 Figma 设计稿（可选，支持多个链接）**

> ⚠️ 仅当 Step 1 初始化阶段检测到 Figma MCP 可用时（`figma_mcp_available = true`），才询问用户 Figma 链接。若 MCP 不可用，跳过此步骤。

询问用户是否有 Figma 设计稿链接：

```
🎨 是否有 Figma 设计稿链接？（可选，支持多个链接，每行一个，直接回车跳过）
```

根据用户回复处理：

| 情况 | 处理方式 |
|------|---------|
| 用户提供了一个或多个 Figma 链接 | 对每个链接按序号（index=0,1,2...）依次处理：调用 `parseFigmaUrl(url)` 校验格式，使用 Figma MCP 工具（`mcp_figma_get_figma_data`）获取设计稿数据，调用 `saveFigmaData(sessionId, jsonData, images, index)` 保存到 `{session_dir}/figma-exports/`（按序号命名：`design.json`, `design_1.json`, ...）。接着调用 `extractImageNodes(figmaData, fileKey)` 提取图片/图标节点，若有可导出节点则使用 `mcp_figma_download_figma_images` 下载图片到 `{session_dir}/figma-exports/images/`。所有链接处理完成后，调用 `saveImageManifest()` 保存合并的图片清单。将所有有效链接写入 `session.json` 的 `inputs.figma_urls` 数组 |
| 某个链接无效或导出失败 | ⚠️ 警告用户该链接处理失败，继续处理剩余链接 |
| 用户跳过 | 记录 `inputs.figma_urls` 为 `[]`，后续 PRD 中标注"缺少设计稿参考" |

**1.4 更新 Session 状态**

> ⚠️ 必须在上下文加载和 Agent 执行之前将状态更新为 `in_progress`。

```javascript
// 立即更新状态为 in_progress
updateStageStatus(sessionId, 'S1', 'in_progress')
// session.json.inputs 已包含 requirement_description、screen_spec 和 figma_urls
```

---

### Step 2: 上下文加载

加载 S1 阶段所需的知识库和上下文资源。

```
📚 正在加载 S1 上下文...
```

**2.1 调用上下文加载器**

```javascript
// 加载阶段上下文
const context = loadStageContext('S1', session)
```

加载内容说明：

| 资源类型 | 加载内容 | 来源 |
|---------|---------|------|
| SKILL.md | Vela 快应用完整开发指南（项目结构、manifest、组件、API、最佳实践） | `resource-paths.json` → `paths.skill_file` |
| 前置产出 | 无（S1 无前置阶段） | `workflow-config.json` → `S1.prerequisites: []` |
| Figma 数据 | 设计稿 JSON、图片清单和已下载图片（若有） | `{session_dir}/figma-exports/` |

> **知识加载策略**：上下文加载器优先加载 SKILL.md 全文作为基础知识。当 Agent 需要某个组件/API 的完整属性列表或边界 case 时，使用 `webFetch` 访问 SKILL.md 中标注的官网链接按需获取详细文档。

**2.2 注入上下文到 Agent 提示词**

```javascript
// 读取 Agent 提示词模板
const agentPrompt = readFile('agents/prd_agent.prompt.md')

// 注入上下文，替换占位符
const injectedPrompt = injectContext(agentPrompt, context)
// 替换: {session.requirement_name} → 需求名称
// 替换: {knowledge_content} → 知识库内容
// 替换: {previous_outputs} → "无（S1 为首个阶段）"
// 替换: {figma_data} → Figma 设计稿数据或"未提供设计稿"
// 替换: {screen_spec} → 屏幕适配规格或"未指定屏幕适配规格"
```

**错误处理**：

| 错误场景 | 处理方式 |
|---------|---------|
| 知识库文件缺失 | ⚠️ 记录警告，跳过缺失文件，使用可用文件继续执行 |
| Agent 提示词文件缺失 | ❌ 阻止执行，提示用户检查 `agents/prd_agent.prompt.md` 是否存在 |

---

### Step 3: Agent 执行

使用注入上下文后的 PRD Agent 生成 PRD 文档。

```
🤖 正在执行 PRD Agent...
```

**3.1 执行 PRD Agent**

将注入上下文后的 `prd_agent.prompt.md` 交给 AI 执行，Agent 按照其内部 Workflow 生成 PRD 文档。

Agent 生成的 PRD 文档必须包含以下章节：

| 章节 | 说明 |
|------|------|
| 需求背景 | 项目背景、目标用户、业务目标 |
| 功能模块 | 按优先级排列的功能模块详细描述（含功能编号 F001、F002…） |
| 页面结构 | 页面列表、页面间导航关系 |
| 交互逻辑 | 用户操作 → 页面反馈 → 逻辑处理 |
| 异常处理 | 网络异常、超时、无权限、空数据等（表格形式） |
| 数据埋点 | Event ID、Event Name、Trigger Timing、Parameters（表格形式） |
| VelaOS 依赖说明 | 涉及的系统 API、组件和能力 |

**3.2 无设计稿标注**

若用户未提供 Figma 设计稿（`inputs.figma_urls` 为空数组），Agent 必须在 PRD 文档中标注：

```markdown
> ⚠️ 本 PRD 缺少设计稿参考，页面结构和交互逻辑基于需求描述推导，建议后续补充设计稿进行校验。
```

**错误处理**：

| 错误场景 | 处理方式 |
|---------|---------|
| Agent 生成失败 | 🔄 自动重试一次；若仍失败，提示用户并提供选项：[r] 重试 / [e] 修改输入 / [q] 退出保存 |

---

### Step 4: 产出物保存

将生成的 PRD 文档保存到 Session 目录。

```
💾 正在保存 PRD 文档...
```

**4.1 保存文件**

```javascript
// 保存 PRD 到 session 目录
saveFile(`${session_dir}/01-prd.md`, prdContent)
```

**4.2 更新 Session 状态**

```javascript
// 更新阶段状态为待审核
updateStageStatus(sessionId, 'S1', 'pending_review', '01-prd.md')
```

保存完成后输出：

```
✅ PRD 文档已生成
📄 文件: {session_dir}/01-prd.md
```

---

### Step 5: Checkpoint 交互

暂停工作流，展示 PRD 摘要，等待用户审核。

```
📋 PRD 摘要:
   • 需求名称: {requirement_name}
   • 功能模块数: {module_count} 个
   • 页面数: {page_count} 个
   • 异常场景: {exception_count} 个
   • 数据埋点: {event_count} 个
   • 设计稿参考: {有/无}
```

提供操作选项：

```
❓ 请选择操作:
   [y] 确认 — 保存 PRD，标记 S1 完成，进入 S2 技术方案
   [e] 编辑 — 提供修改意见，迭代生成
   [n] 放弃 — 丢弃当前 PRD，重新生成
```

**命令处理**：

> 严格按照 `.workflow/stages/commands.md` 中定义的逻辑处理用户命令。

| 命令 | 处理逻辑 |
|------|---------|
| `y` | 调用 `updateStageStatus(sessionId, 'S1', 'completed', '01-prd.md')`，返回 `workflow_starter.md` 的 Step 5 进行阶段流转 |
| `e` | 接收用户修改意见，追加到 Agent 上下文，重新执行 Step 3（支持多轮迭代） |
| `n` | 丢弃当前产出，调用 `updateStageStatus(sessionId, 'S1', 'in_progress')`，返回 Step 1 重新执行 |

---

## 产出物规范

| 属性 | 值 |
|------|-----|
| 文件名 | `01-prd.md` |
| 格式 | Markdown |
| 保存路径 | `.ai-workspace/sessions/{session_id}/01-prd.md` |

### 必含章节

1. **需求背景** — 项目背景、目标用户、业务目标
2. **功能模块** — 按优先级排列，含功能编号（F001、F002…）
3. **页面结构** — 页面列表与导航关系
4. **交互逻辑** — 用户操作 → 页面反馈 → 逻辑处理
5. **异常处理** — 表格形式列出所有异常场景
6. **数据埋点** — 表格形式列出所有埋点事件
7. **VelaOS 依赖说明** — 涉及的系统 API 和组件

---

## 使用的脚本函数

| 函数 | 来源 | 用途 |
|------|------|------|
| `loadStageContext('S1', session)` | `context_loader.js` | 加载知识库、Figma 数据和图片清单 |
| `injectContext(agentPrompt, context)` | `context_loader.js` | 替换 Agent 提示词占位符 |
| `updateStageStatus(sessionId, stageId, status, outputPath)` | `session_manager.js` | 更新阶段状态 |
| `createSession(requirementName)` | `session_manager.js` | 创建 Session（由 workflow_starter.md 调用） |

---

## 文件引用

| 文件 | 用途 |
|------|------|
| `agents/prd_agent.prompt.md` | PRD Agent 提示词模板 |
| `.workflow/resource-paths.json` | 知识库路径映射 |
| `.workflow/stages/commands.md` | 快捷命令处理逻辑 |
| `.workflow/scripts/context_loader.js` | 上下文加载器 |
| `.workflow/scripts/session_manager.js` | Session 管理器 |
