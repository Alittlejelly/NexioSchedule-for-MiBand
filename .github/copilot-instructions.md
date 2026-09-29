# Vela 快应用开发

## 触发条件

当用户消息中包含以下关键词时，**立即自动启动工作流**，无需用户手动引用任何文件：
- 创建 Vela 快应用 / 创建 Vela 应用
- 创建小米手表快应用 / 创建小米手表应用
- Vela 快应用 / vela app / vela quickapp
- 小米快应用 / 小米穿戴应用

---

## 工程体系架构（Harness Engineering）

```
.github/
├── rules/               ← 编译时约束（alwaysApply，AI 无条件遵守）
│   ├── vela-platform.md       # 平台约束：组件+API+禁止依赖+生命周期
│   ├── vela-format.md         # 格式规范：.ux+manifest+package.json+目录结构
│   ├── vela-layout.md         # 布局规范：CSS+圆屏安全区域
│   ├── vela-quality.md        # 质量标准：命名+错误处理+资源清理+禁止行为
│   └── project-init.md        # 初始化规范：脚手架命令+检查清单
├── agents/              ← 运行时行为体（纯流程编排，rules 自动注入约束）
│   ├── vela-workflow.agent.md    # 工作流协调器
│   ├── vela-s1-prd.agent.md      # S1 PRD 生成
│   ├── vela-s2-tech.agent.md     # S2 技术方案
│   ├── vela-s3-coding.agent.md   # S3 代码生成
│   └── vela-knowledge.agent.md   # 知识库查询
└── prompts/             ← 知识参考层（按需加载）
    ├── vela-dev-guide.prompt.md       # 完整开发指南
    ├── vela-components.prompt.md      # 组件用法速查
    ├── vela-apis.prompt.md            # API 速查
    └── vela-best-practices.prompt.md  # 最佳实践
```

### 设计原则

| 层级 | 职责 | 加载方式 | 特点 |
|------|------|----------|------|
| **Rules** | 硬约束（什么不能做） | alwaysApply，自动注入 | 不可协商、可验证 |
| **Agents** | 流程编排（怎么做） | 按任务 handoff 调度 | 关注行为序列 |
| **Prompts** | 知识参考（做得好） | 按需引用 | 详细文档、示例 |

### 核心约束（由 Rules 层自动执行）

- 📌 组件白名单 + API 白名单 → `rules/vela-platform.md`
- 📌 .ux 格式 + manifest + package.json → `rules/vela-format.md`
- 📌 Flexbox 布局 + 圆屏安全区域 → `rules/vela-layout.md`
- 📌 命名规范 + 错误处理 + 资源清理 → `rules/vela-quality.md`
- 📌 脚手架初始化 + 禁止行为清单 → `rules/project-init.md`

---

## 自定义 Agent

可在 VS Code Copilot Chat 的 Agent 下拉菜单中选择：

| Agent | 用途 |
|-------|------|
| `Vela 快应用工作流` | 完整三阶段工作流协调器（PRD → 技术方案 → 代码） |
| `Vela PRD 生成` | S1 阶段：生成产品需求文档 |
| `Vela 技术方案` | S2 阶段：生成技术方案 |
| `Vela 代码生成` | S3 阶段：生成可运行的项目代码（含快速模式） |
| `Vela 知识库` | 查询组件用法、API 参数、最佳实践 |
