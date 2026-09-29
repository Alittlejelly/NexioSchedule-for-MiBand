# Vela 快应用项目 — Claude Code 配置

## 项目概述

本项目使用 Vela 快应用多阶段自动化开发工作流，支持从需求到代码的完整开发流程。

## 工作流入口

- **Slash 命令**：用户输入 `/vela-workflow` 启动完整工作流
- **触发关键词**：当用户消息包含以下关键词时自动触发工作流：
  - 创建 Vela 快应用 / 创建 Vela 应用
  - 创建小米手表快应用 / 创建小米手表应用
  - Vela 快应用 / vela app / vela quickapp
  - 小米快应用 / 小米穿戴应用

## 工作流 Skill 结构

```
.claude/skills/
├── vela-workflow/SKILL.md       # 工作流主协调器
├── vela-s1-prd/SKILL.md         # S1: PRD 生成
├── vela-s2-tech/SKILL.md        # S2: 技术方案
└── vela-s3-coding/SKILL.md      # S3: 功能研发
```

## 自动触发规则

当检测到触发关键词时：
1. 读取 `.claude/skills/vela-workflow/SKILL.md`
2. 按其定义的主流程执行
3. 每个阶段读取对应的阶段 SKILL.md 执行

## 知识库位置

- **核心开发指南**：`.claude/knowledge/vela-js-app.md`
- **平台规则**：`.claude/rules/`（vela-platform.md、vela-quality.md、vela-layout.md 等）
- **组件/API 参考**：`.claude/prompts/`（vela-components.prompt.md、vela-apis.prompt.md 等）

## VelaOS 平台硬约束（始终遵守）

- **组件白名单**：div, list, list-item, text, image, input, scroll, swiper, switch, slider, progress, picker, stack, span, marquee, barcode, qrcode, chart, image-animator, a
- **API 白名单**：router, app, fetch, storage, device, audio, prompt, sensor, vibrator, network, brightness, volume, battery, geolocation, record, file, crypto, configuration, interconnect, messagecenter
- **禁止第三方库**：antd, element-ui, vant, axios, lodash, moment, echarts, Vue, React, Angular, hap-toolkit
- **构建工具**：仅使用 aiot-toolkit（禁止 hap-toolkit）
- **项目初始化**：全新项目必须使用 `npx create-aiot ux --name <项目名>`

## 代码规范

- 变量/函数：camelCase
- 组件名：PascalCase
- 常量：UPPER_SNAKE_CASE
- 缩进：2 空格
- CSS：仅 class 选择器、扁平结构、无嵌套
- 所有 API 调用必须包含 fail 错误处理
- onDestroy 必须清理定时器和事件监听
- .ux 文件 template 只有一个根节点

## 布局硬约束

- **页面内容宽度不得超过屏幕宽度**：所有元素的宽度（含 padding、margin、border）必须 ≤ 屏幕宽度，禁止出现水平溢出或水平滚动

## Session 数据

工作流 Session 数据保存在 `.ai-workspace/sessions/{session_id}/` 目录下。
代码产出物直接写入项目工程目录（非 Session 目录）。
