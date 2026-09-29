---
inclusion: auto
---

# Vela 快应用工作流规范

## 知识来源

- 核心知识文件: #[[file:.kiro/skills/vela-js-app/SKILL.md]]
- 官方文档站点: https://iot.mi.com/vela/quickapp/
- 当 SKILL.md 中的信息不够详细时（如某个组件的完整属性列表），使用 webFetch 访问 SKILL.md 中标注的官网链接按需获取

## 项目约束

- 目标平台: VelaOS 智能手表/手环
- 默认屏幕规格: 480×480 圆屏（可在 Session 中自定义）
- 快应用页面文件格式: `.ux`（模板 + 脚本 + 样式合一）
- 布局方式: Flexbox 为主，默认 flex-direction: column
- 禁止使用第三方 npm 包（仅使用 VelaOS 内置 API 和组件）
- 禁止使用 antd、echarts、element-ui、vant、axios、lodash 等外部库
- 图表需求使用 Vela 内置 chart 组件，不用 echarts/d3
- 组件只能用知识库 knowledge/components/ 中列出的内置组件
- API 只能用 @system.xxx 系统 API（参考 knowledge/api-reference/）
- 所有功能优先用原生 JS + CSS 实现

## 代码风格

- 变量/函数: camelCase
- 组件名: PascalCase
- 常量: UPPER_SNAKE_CASE
- 缩进: 2 空格
- 字符串: 单引号优先
- 每个文件顶部必须有文件说明注释
- 所有异步操作必须包含错误处理
- 禁止使用 `@import` 引入 CSS，外部 CSS 必须用 `<style src="./path"></style>` 标签引入

## 工作流使用提示

- 启动工作流: 在对话框中输入 `#vela-workflow`（或引用 `@.workflow/workflow_starter.md`）
- 快捷命令: y(确认) / e(编辑) / n(重做) / q(退出) / status(进度) / back(返回)
- Session 数据保存在 `.ai-workspace/sessions/` 目录
- 代码产出物直接写入项目工程目录（非 Session 目录）
- `package.json` 必须基于 `knowledge/examples/settings/package.json` 模板生成

## 项目初始化规范

- 全新项目必须使用 `npx create-aiot ux --name <项目名>` 创建
- 脚手架创建后必须补全缺失的产物：
  - `package.json` 的 `devDependencies`（aiot-toolkit）
  - `package.json` 的 `scripts`（start, build, release, watch）
  - `README.md`（项目说明、开发/构建命令、目标平台）
  - `.gitignore`（node_modules/, build/, dist/, .DS_Store, *.log）

## Figma 设计稿对接规范

### 获取设计信息流程

1. 使用 `get_metadata` 获取整体页面结构和节点 ID
2. 对每个关键页面/frame 调用 `get_design_context` 获取详细设计参数（颜色、尺寸、字体）
3. 使用 `get_screenshot` 获取视觉参考截图
4. 从设计上下文中提取图片资源 URL 并下载到 `src/common/`

### 图片资源导出规则

- **格式要求**：Vela 快应用仅支持 PNG 格式，禁止使用 SVG
- **下载方式**：从 Figma Desktop MCP 的 localhost 资源 URL 下载（`http://localhost:3845/assets/xxx.png`）
- **文件验证**：下载后用 `file` 命令验证是否为有效 PNG，检查文件大小（19字节 = 下载失败）
- **尺寸控制**：图标不超过 200KB，背景图用 `sips -Z <maxDimension>` 压缩到屏幕尺寸
- **命名规范**：`icon-<name>.png`（图标）、`bg-<name>.png`（背景）、`screenshot-<n>.png`（截图）

### 尺寸还原规则

- `manifest.json` 的 `config.designWidth` 必须与 Figma 设计稿宽度一致（如 466px 屏幕设为 466）
- 所有列表项、卡片、按钮使用**固定宽高**（从 Figma 节点尺寸直接取值），不用百分比
- border-radius 直接使用 Figma 中的数值

### Scroll 容器必备设置

Vela 快应用的 scroll 组件需要内部容器有明确尺寸才能正确滚动：

```html
<scroll class="page" scroll-y="true">
  <div class="container">
    <!-- 内容 -->
  </div>
</scroll>
```
```css
.page {
  width: 100%;
  height: 100%;
}
.container {
  flex-direction: column;
  width: 100%;
  height: 1000px; /* 必须设置固定高度，大于内容实际高度 */
}
```

### 设计对比检查清单

代码生成后自动执行以下检查（由 `figma-design-check` hook 触发）：

- [ ] 布局结构（flex-direction、对齐方式）与设计稿一致
- [ ] 关键元素尺寸（宽高、圆角、间距）使用固定值且与设计稿匹配
- [ ] 颜色值、字号与设计稿一致
- [ ] 所有图片引用指向 `src/common/` 下的有效 PNG 文件
- [ ] 无 SVG 文件引用
- [ ] 超出一屏的页面使用 scroll 包裹且 container 有固定高度
- [ ] 圆形屏幕安全区域 padding 正确（上下 ~50px，左右 ~24-36px）
