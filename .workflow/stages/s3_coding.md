# S3: 功能研发

**⚠️ 重要：仅对 S3 功能研发阶段执行。**

S3 阶段的目标是根据已审核通过的 PRD 文档和技术方案，结合 Vela 快应用知识库中的开发范式、API 接口文档、组件规范和代码示例，在项目工程目录中直接编写可运行的 Vela 快应用代码。

> ⚠️ **关键区别**：S3 阶段的代码产出物直接写入项目工程目录（`session.inputs.project_path`），而非 Session 目录。这确保代码可以直接在项目中编译运行。

---

## 阶段概要

| 属性 | 值 |
|------|-----|
| 阶段 ID | S3 |
| 阶段名称 | 功能研发 |
| Agent | `agents/coding_agent.prompt.md` |
| 知识库 | `vela/dev-paradigm`、`vela/api-reference`、`vela/components`、`vela/examples`、`vela/best-practices` |
| 前置条件 | S1 已完成且 S2 已完成 |
| 工作目录 | `session.inputs.project_path`（项目工程目录，由 S2 阶段收集） |
| 产出物 | 项目工程目录中的代码文件 |

---

## 执行步骤

### Step 1: 前置校验

校验前置阶段、项目工程路径，并加载前置产出物。

**1.1 检查 S1、S2 完成状态**

读取 `session.json`，根据 `workflow_mode` 判断前置条件：

| 工作流模式 | 前置条件 |
|-----------|---------|
| `full`（完整模式） | S1 和 S2 均为 `completed`，任一未完成则阻止执行 |
| `quick`（快速模式） | 无前置条件，S1 和 S2 状态为 `skipped`，直接执行 S3 |

**1.2 加载前置产出物**

- **完整模式**：确认 `01-prd.md` 和 `02-tech-design.md` 均存在于 Session 目录中
- **快速模式**：跳过此步骤，S3 将直接基于用户需求描述 + Figma 设计稿 + 知识库生成代码

**1.3 校验项目工程路径**

S3 阶段必须有一个有效的项目工程路径作为代码写入目标。

| 情况 | 处理方式 |
|------|---------|
| `project_path` 不为 `null` 且路径存在 | ✅ 使用该路径 |
| `project_path` 为 `null` 或 `.` | ✅ 使用当前工作区根目录 `.` |
| 路径不存在 | ⚠️ 自动创建目录后使用 |

> 项目工程路径默认为 `.`（当前工作区根目录），S3 脚手架会在该路径下创建以项目名命名的子目录。

**1.4 更新 Session 状态**

```javascript
updateStageStatus(sessionId, 'S3', 'in_progress')
```

---

### Step 2: 项目工程初始化检测

检测项目工程目录状态，判断是全新项目还是已有项目。

```
📂 正在检测项目工程状态...
```

**2.1 检测项目目录状态**

| 条件 | 判定 | 处理方式 |
|------|------|---------|
| 目录不存在或为空 | 🆕 全新项目 | 执行 Step 2.2 基于知识库模板初始化 |
| 目录存在但无 `src/manifest.json` | 🆕 全新项目 | 执行 Step 2.2 基于知识库模板初始化 |
| 目录存在且有 `src/manifest.json` | ✏️ 已有项目 | 跳过初始化，进入 Step 3 |

**2.2 全新项目工程初始化（使用 create-aiot 脚手架）**

> ⚠️ **强制规则**：全新项目必须使用 `npx create-aiot ux --name <项目名>` 命令创建项目模板。**禁止**手动拼凑 package.json、manifest.json 等配置文件。

```
🔧 检测到全新项目，正在使用 create-aiot 脚手架初始化...
```

执行步骤：

1. **自动生成项目名**：根据需求名称生成 kebab-case 格式的项目名
   - 示例：需求"手环汽车App" → 项目名 `band-car-app`
   - 示例：需求"应用商店" → 项目名 `app-store`
   - 规则：中文转英文、全小写、空格/特殊字符替换为 `-`

2. **在项目工程路径下执行脚手架命令**：
   ```bash
   cd ${projectPath} && npx create-aiot ux --name ${projectName}
   ```
   - 该命令会在 `${projectPath}/${projectName}/` 下生成完整的项目模板（含 package.json、src/manifest.json、src/app.ux 等）
   - 若 `projectPath` 为 `.`（当前目录），则项目生成在 `./${projectName}/`

3. **更新 project_path**：脚手架生成的项目在子目录中，需要更新 session 中的 `project_path`
   ```javascript
   session.inputs.project_path = `${projectPath}/${projectName}`
   ```

4. **校验初始化结果**：
   - 检查 `${projectPath}/${projectName}/src/manifest.json` 是否存在
   - 检查 `${projectPath}/${projectName}/package.json` 是否存在

   | 情况 | 处理方式 |
   |------|---------|
   | 初始化成功 | ✅ 继续 Step 3 |
   | `npx` 命令不存在 | ⚠️ 提示安装 Node.js，提供 [r] 重试 / [s] 跳过 选项 |
   | `create-aiot` 包下载失败 | ⚠️ 提示检查网络，提供 [r] 重试 / [s] 跳过 选项 |
   | 其他错误 | ⚠️ 输出错误信息，提供 [r] 重试 / [s] 跳过 选项 |

   > 用户选择 `[s]` 跳过时，回退到手动创建目录结构并从知识库模板复制配置文件的方式。

```
✅ 工程初始化完成（create-aiot 脚手架）
📂 项目目录: ${projectPath}/${projectName}
📄 package.json: 已生成
📄 manifest.json: 已生成
📄 app.ux: 已生成
```

**2.2.5 脚手架产物补全**

> ⚠️ `npx create-aiot` 生成的项目模板可能缺少必要的依赖声明和配置文件，必须在此步骤补全。

1. **补全 package.json 依赖**：读取脚手架生成的 `package.json`，若 `devDependencies` 为空或缺少核心依赖，则参考知识库模板（`knowledge/examples/multi_screen_todolist/package.json`）补全：
   ```json
   {
     "devDependencies": {
       "aiot-toolkit": "^2.0.5"
     }
   }
   ```
   同时确保 `scripts` 中包含以下命令（若缺失则补充）：
   ```json
   {
     "scripts": {
       "start": "aiot server --watch --open-nuttx",
       "build": "aiot build",
       "release": "aiot release",
       "watch": "aiot watch --open-nuttx"
     }
   }
   ```
   保留脚手架已生成的 `name`、`version` 等字段不变，仅合并缺失项。

2. **生成 README.md**（若不存在）：
   ```markdown
   # ${projectName}

   基于 Vela 快应用框架开发的 ${requirementName} 应用。

   ## 开发

   ```bash
   npm install
   npm run start
   ```

   ## 构建

   ```bash
   npm run build
   ```

   ## 目标平台

   - VelaOS 智能手表（${screenWidth}×${screenHeight} ${screenShape}）
   ```
   其中 `${requirementName}` 取自 `session.requirement_name`，屏幕规格取自 `session.inputs.screen_spec`。

3. **生成 .gitignore**（若不存在）：
   ```
   node_modules/
   build/
   dist/
   .DS_Store
   *.log
   .env
   ```

4. **生成 .eslintrc.json**（若不存在）：
   > ⚠️ 不生成 .eslintrc.json，项目不强制使用 eslint。

补全完成后输出：
```
🔧 脚手架产物补全完成
   📦 package.json: 依赖已补全（aiot-toolkit）
   📄 README.md: 已生成
   📄 .gitignore: 已生成
```

**2.3 已有项目扫描**

若为已有项目，简要输出项目现状：

```
✏️ 检测到已有项目工程
📂 项目目录: {projectPath}
📑 已有页面: {page_count} 个
🧩 已有组件: {component_count} 个
```

**2.4 询问是否使用 UnoCSS（仅全新项目）**

> 全新项目初始化完成后，询问用户是否启用 UnoCSS 原子化样式。

```
🎨 是否启用 UnoCSS 原子化样式？
   [y] 启用 — 使用 unocss-preset-vela 插件，支持 Tailwind 风格的原子类（如 flex, w-full, text-white 等）
   [n] 不启用 — 使用传统 CSS 手写样式（默认）
```

- 用户选择 `y`：执行以下配置步骤
- 用户选择 `n` 或直接回车：跳过，使用传统 CSS

**启用 UnoCSS 的配置步骤**：

1. **安装依赖**：
   ```bash
   cd ${projectPath} && npm install -D unocss unocss-preset-vela
   ```

2. **创建 `unocss.config.js`**：
   ```javascript
   import { defineConfig } from 'unocss'
   import { presetVela } from 'unocss-preset-vela'

   export default defineConfig({
     presets: [
       presetVela()
     ]
   })
   ```

3. **在 `package.json` 的 `scripts` 中添加 uno 命令**：
   ```json
   {
     "scripts": {
       "uno": "unocss 'src/**/*.ux' --out-file=src/common/style/unocss-vela.css --watch"
     }
   }
   ```

4. **创建样式输出目录**：
   ```bash
   mkdir -p ${projectPath}/src/common/style
   ```

5. **在 `app.ux` 中引入生成的 CSS**：
   ```html
   <style src="./common/style/unocss-vela.css"></style>
   ```
   > ⚠️ 快应用引入外部 CSS 必须使用 `<style src="./path"></style>` 标签方式。**禁止**使用 `@import './path';` 或 `@import url('./path');`

6. **记录到 session**：`session.inputs.use_unocss = true`

```
✅ UnoCSS 已启用
📦 已安装: unocss, unocss-preset-vela
📄 unocss.config.js 已创建
📝 app.ux 已引入
💡 开发时运行 npm run uno 生成原子类 CSS
```

> 启用 UnoCSS 后，后续代码生成阶段可以在 `.ux` 文件的模板中直接使用原子类（如 `class="flex items-center w-full text-white"`），无需手写 CSS。

---

### Step 3: 上下文加载

加载 S3 阶段所需的全部知识库、前置产出和 Agent 提示词。

**3.1 调用上下文加载器**

```javascript
const context = loadStageContext('S3', session)
```

| 资源类型 | 加载内容 |
|---------|---------|
| SKILL.md | Vela 快应用完整开发指南（项目结构、manifest、组件、API、最佳实践） |
| 代码示例 | `vela/examples`（完整项目模板参考） |
| 前置产出 | 完整模式：`01-prd.md` + `02-tech-design.md`；快速模式：无（使用 `session.requirement_description` 作为需求输入） |
| Figma 数据 | `session_dir/figma-exports/`（若有） |
| 项目工程现状 | `scanProjectStructure()` 扫描结果 |

> **知识加载策略**：优先加载 SKILL.md 全文。当需要某个组件/API 的完整属性列表时，使用 `webFetch` 访问 SKILL.md 中标注的官网链接按需获取。S3 阶段额外加载 `vela/examples` 知识库提供完整项目模板参考。

**3.2 注入上下文到 Agent 提示词**

```javascript
const agentPrompt = readFile('agents/coding_agent.prompt.md')
const injectedPrompt = injectContext(agentPrompt, context)
// 替换: {session.requirement_name}, {knowledge_content}, {previous_outputs}
// 替换: {figma_data}, {project_analysis}, {project_path}
```

---

### Step 3.5: 快速模式轻量技术规划（仅 quick 模式执行）

> ⚠️ 仅当 `session.workflow_mode === "quick"` 时执行此步骤。完整模式跳过。

快速模式跳过了 S1/S2，直接进入编码。为避免代码结构混乱，Agent 必须先输出一个轻量技术规划供用户确认，再开始生成代码。

```
📋 快速模式 — 轻量技术规划
🤖 正在分析需求并规划项目结构...
```

**3.5.1 Agent 输出轻量规划**

Agent 根据需求描述、Figma 设计稿和知识库，输出以下规划内容：

```
📋 轻量技术规划:
   📄 页面列表:
     - {page_1}: {description}
     - {page_2}: {description}
   🧩 自定义组件:
     - {component_1}: {description}（若无则标注"无"）
   🔗 路由配置:
     - 入口页面: {entry_page}
     - 导航关系: {page_1} → {page_2} → ...
   📡 系统 API:
     - {api_1}: {usage}
     - {api_2}: {usage}
   📂 项目目录结构:
     src/
     ├── manifest.json
     ├── app.ux
     ├── pages/
     │   ├── {Page1}/index.ux
     │   └── {Page2}/index.ux
     └── common/images/

❓ 请确认规划:
   [y] 确认 — 按此规划生成代码
   [e] 修改 — 提供调整意见
```

- 用户输入 `y` → 按规划进入 Step 4 生成代码
- 用户输入 `e` → 接收修改意见，重新输出规划（支持多轮）

---

### Step 4: Figma 图片资源导出（代码生成前必须完成）

> ⚠️ **强制执行**：此步骤必须在代码生成（Step 5）之前完成。若 `session.inputs.figma_urls` 非空，**禁止跳过此步骤直接生成代码**。

```
🎨 正在从 Figma 设计稿导出图片资源...
```

**4.1 检查是否需要导出**

| 条件 | 处理方式 |
|------|---------|
| `session.inputs.figma_urls` 非空且 Figma 数据已获取 | ✅ **必须执行**图片导出，然后进入 Step 5 |
| `session.inputs.figma_urls` 为空 | ⏭️ 跳过此步骤，直接进入 Step 5 |

**4.2 识别图片节点**

从已获取的 Figma 设计稿数据（session 目录下的 `figma-exports/design.json`）中识别所有包含图片资源的节点：
- 带有 `imageRef` 的 RECTANGLE 填充（应用图标、banner 图、背景图等）
- INSTANCE 类型的图标组件（如 app 图标、功能图标、箭头图标）
- 带有图片填充的 ELLIPSE 节点（圆形图标）
- 其他包含 `type: "IMAGE"` 填充的节点
- VECTOR/BOOLEAN_OPERATION 类型的图标节点（如返回箭头、功能图标）

**4.3 使用 Figma MCP 导出图片**

调用 `mcp_figma_export_image` 导出识别到的图片节点：

```javascript
// 导出图片节点为 PNG，scale=2 保证清晰度
mcp_figma_export_image({
  file_key: fileKey,
  node_ids: nodeIds,  // 逗号分隔的节点 ID 列表
  format: 'png',
  scale: 2
})
```

**4.4 下载图片到项目目录**

将导出的图片 URL 下载到项目的 `src/common/images/` 目录：

```bash
mkdir -p ${projectPath}/src/common/images/
curl -sL "{image_url}" -o "${projectPath}/src/common/images/{image_name}.png"
```

图片命名规则（根据 Figma 节点名称和语义）：
- 应用图标 → `icon_{appname}.png`
- 功能图标 → `icon_{function}.png`（如 `icon_back.png`、`icon_lock.png`）
- 背景图 → `bg_{scene}.png`（如 `bg_parked.png`、`bg_charging.png`）
- Banner/卡片 → `banner_{name}.png`

**4.5 输出导出结果**

```
✅ Figma 图片资源导出完成
📂 保存目录: {projectPath}/src/common/images/
🖼️ 导出图片: {count} 张
   - {image_1_name}.png ({size})
   - {image_2_name}.png ({size})
   ...
```

> ⚠️ **导出完成后才能进入 Step 5 代码生成**。代码中引用的图片路径必须与此步骤导出的文件名一致。

---
### Step 5: Agent 执行（代码生成）

> ⚠️ **前置条件**：若 Figma 数据可用，Step 4 的图片导出必须已完成。代码中**必须引用 Step 4 导出的真实图片路径**，**禁止使用占位符路径**。

在项目工程目录中编写 Vela 快应用代码。

```
🤖 正在执行编码 Agent...
📂 工作目录: {project_path}
```

**5.1 执行 Coding Agent**

Agent 必须：

- **直接在项目工程目录中创建/修改文件**，路径基于 `session.inputs.project_path`
- 严格按照技术方案（完整模式）或轻量技术规划（快速模式）组织代码
- 若为已有项目增量开发，仅修改/新增标注的文件，不破坏已有代码
- **代码中引用的所有图片路径必须指向 `src/common/images/` 下 Step 4 导出的真实文件**

**5.2 代码写入路径规则**

```javascript
const projectPath = session.inputs.project_path

// ✅ 正确：写入项目工程目录
saveFile(`${projectPath}/src/manifest.json`, manifestContent)
saveFile(`${projectPath}/src/app.ux`, appContent)
saveFile(`${projectPath}/src/pages/Index/index.ux`, pageContent)
saveFile(`${projectPath}/src/components/MyComp/index.ux`, compContent)

// ❌ 错误：禁止写入 Session 目录
// saveFile(`${session_dir}/03-code/...`, content)
```

**5.3 VelaOS 兼容性要求**

- 使用 Vela 快应用支持的 JS 语法特性
- 使用内置组件和 API，不引入不兼容的第三方库
- 样式使用 CSS 子集（Flexbox 布局为主）
- 模板使用 Vela 快应用模板语法

**5.4 API 调用规范**

必须从知识库中查找 API 签名、参数和示例，确保调用语法符合规范。

**5.5 代码结构遵循技术方案**

严格按照 `02-tech-design.md` 中定义的文件目录结构组织。

---

### Step 6: 安装项目依赖

代码文件写入完成后，自动在项目工程目录中执行 `npm install` 安装依赖。

```
📦 正在安装项目依赖...
```

**5.1 执行 npm install**

在项目工程目录下执行：

```bash
cd ${projectPath} && npm install
```

| 情况 | 处理方式 |
|------|---------|
| 安装成功 | ✅ 继续 Step 6 |
| 安装失败 | ⚠️ 输出错误信息，提供 [r] 重试 / [s] 跳过 选项 |

安装成功后输出：

```
✅ 依赖安装完成
📦 已安装 {package_count} 个包
```

安装失败时输出：

```
⚠️ 依赖安装失败: {error_message}

❓ 请选择:
   [r] 重试安装
   [s] 跳过（后续手动执行 npm install）
```

---

### Step 7: 产出物记录

代码已直接写入项目工程目录，此步骤记录产出信息到 Session。

**5.1 记录产出物路径**

```javascript
updateStageStatus(sessionId, 'S3', 'pending_review', session.inputs.project_path)
```

**5.2 生成变更文件清单**

记录本次创建或修改的所有文件列表，保存到 Session 目录供审核参考：

```javascript
saveFile(`${session_dir}/03-code-manifest.json`, JSON.stringify({
  project_path: projectPath,
  created_files: [...],
  modified_files: [...],
  timestamp: new Date().toISOString()
}, null, 2))
```

```
✅ 代码文件已写入项目工程目录
📂 项目目录: {project_path}
📝 新建文件: {created_count} 个
✏️ 修改文件: {modified_count} 个
```

---

### Step 7.5: 自动质量校验

代码写入完成后，在进入人工审核前，自动执行以下静态校验：

```
🔍 正在执行自动质量校验...
```

**5.5.1 路由一致性校验**

检查 `manifest.json` 中 `router.pages` 声明的每个页面路径，对应的页面文件是否存在：

```javascript
const manifest = JSON.parse(readFile(`${projectPath}/src/manifest.json`))
const pages = Object.keys(manifest.router.pages)
const missingPages = []
for (const route of pages) {
  const pagePath = `${projectPath}/src/${route}`
  if (!fs.existsSync(pagePath)) {
    missingPages.push(route)
  }
}
```

**5.5.2 图片资源引用校验**

扫描所有 `.ux` 文件中引用的图片路径（`/common/images/xxx.png`），检查对应文件是否存在于项目目录中。

**5.5.3 API 声明一致性校验**

扫描所有 `.ux` 文件中的 `import xxx from '@system.xxx'` 语句，检查对应的 API 是否已在 `manifest.json` 的 `features` 中声明。

**5.5.4 校验结果输出**

```
🔍 自动质量校验结果:
  ✅ 路由一致性: {pass_count}/{total_count} 页面通过
  ✅ 图片资源引用: {pass_count}/{total_count} 引用有效
  ✅ API 声明一致性: {pass_count}/{total_count} API 已声明
```

若存在校验失败项：

```
⚠️ 自动质量校验发现问题:
  ❌ 路由一致性: 以下页面在 manifest.json 中声明但文件不存在:
     - {missing_route_1}
     - {missing_route_2}
  ❌ 图片资源引用: 以下图片被引用但文件不存在:
     - {missing_image_1}
  ❌ API 声明一致性: 以下 API 被 import 但未在 features 中声明:
     - {missing_api_1}

🔧 正在自动修复可修复的问题...
```

对于 API 声明缺失，自动将缺失的 API 添加到 `manifest.json` 的 `features` 数组中。
对于路由和图片问题，记录到校验报告中供人工审核时参考。

---

### Step 8: Checkpoint 交互

> ⚠️ **关键规则：必须阻塞等待用户输入**。代码写入完成后，展示摘要和操作选项，然后**停止一切后续操作**。

```
📋 代码生成摘要:
   • 需求名称: {requirement_name}
   • 项目目录: {project_path}
   • 项目类型: {全新项目/已有项目增量开发}
   • 总文件数: {file_count} 个
   • 页面数: {page_count} 个
   • 自定义组件数: {component_count} 个
```

```
❓ 请选择操作:
   [y] 确认 — 标记 S3 完成，工作流结束
   [e] 编辑 — 提供修改意见，迭代修改代码
   [n] 放弃 — 回滚代码变更，重新生成

⏳ 等待您的输入...
```

> 严格按照 `.workflow/stages/commands.md` 中定义的逻辑处理用户命令。

| 命令 | 处理逻辑 |
|------|---------|
| `y` | `updateStageStatus(sessionId, 'S3', 'completed', project_path)`，工作流完成 |
| `e` | 接收修改意见，在项目工程目录中迭代修改（支持多轮） |
| `n` | `updateStageStatus(sessionId, 'S3', 'in_progress')`，返回 Step 1 |

---

## 调试运行（velajs-mcp）

S3 代码生成完成后，推荐使用 [velajs-mcp](https://www.npmjs.com/package/velajs-mcp) 进行模拟器调试。

**功能**：
- 🖥️ 自动启动模拟器并加载应用
- 📸 可截取应用 UI 截图进行视觉检查
- 🌳 查看页面 DOM 树结构
- 📋 抓取运行日志，定位 JS 错误
- 👆 模拟点击、滑动等用户交互
- 🔄 自动对比 Figma 设计稿修复 UI 问题

**安装方式**：

| IDE | 配置方式 |
|-----|---------|
| VS Code Copilot | `.vscode/mcp.json` 添加 `{ "mcpServers": { "velajs": { "command": "npx", "args": ["-y", "velajs-mcp"] } } }` |
| Kiro | `.kiro/settings/mcp.json` 添加 `{ "mcpServers": { "velajs": { "command": "npx", "args": ["-y", "velajs-mcp"] } } }` |
| Claude Code | 执行 `claude mcp add --scope user velajs -- npx -y velajs-mcp` |

配置完成后，在对话中说"帮我调试"即可启动模拟器运行应用。

📖 详细文档：https://www.npmjs.com/package/velajs-mcp

---

## 产出物规范

| 属性 | 值 |
|------|-----|
| 写入位置 | `session.inputs.project_path`（项目工程目录） |
| 变更清单 | `.ai-workspace/sessions/{session_id}/03-code-manifest.json` |
| 格式 | UX / JS / CSS / JSON |

### 目录结构

代码直接写入项目工程目录，典型结构如下：

```
{project_path}/
├── package.json
├── src/
│   ├── manifest.json
│   ├── app.ux
│   ├── pages/
│   │   └── {PageName}/
│   │       └── index.ux
│   ├── components/
│   │   └── {ComponentName}/
│   │       └── index.ux
│   ├── utils/
│   │   └── *.js
│   └── common/
│       ├── images/
│       │   ├── logo.png                # 应用 Logo（从 Figma 导出或用户上传）
│       │   ├── icon_{appname}.png    # 从 Figma 导出的应用图标
│       │   ├── icon_{function}.png   # 从 Figma 导出的功能图标
│       │   └── banner_{name}.png     # 从 Figma 导出的 Banner 图
│       └── styles/
│           └── global.css
```

---

## 使用的脚本函数

| 函数 | 来源 | 用途 |
|------|------|------|
| `loadStageContext('S3', session)` | `context_loader.js` | 加载全部知识库和前置产出 |
| `injectContext(agentPrompt, context)` | `context_loader.js` | 替换 Agent 提示词占位符 |
| `scanProjectStructure(session)` | `context_loader.js` | 扫描项目工程目录现状 |
| `updateStageStatus(sessionId, stageId, status, outputPath)` | `session_manager.js` | 更新阶段状态 |
| `resumeSession(sessionId)` | `session_manager.js` | 恢复 Session |
| `extractImageNodes(figmaData, fileKey)` | `figma_export.js` | 从 Figma 节点树中提取图片节点 |

---

## 文件引用

| 文件 | 用途 |
|------|------|
| `agents/coding_agent.prompt.md` | 编码 Agent 提示词模板 |
| `.workflow/resource-paths.json` | 知识库路径映射 |
| `.workflow/stages/commands.md` | 快捷命令处理逻辑 |
| `.workflow/scripts/context_loader.js` | 上下文加载器 |
| `.workflow/scripts/session_manager.js` | Session 管理器 |
