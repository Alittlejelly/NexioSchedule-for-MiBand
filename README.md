# NexioSchedule-for-MiBand

Nexio 课程表的 **小米手环版**，基于 Vela 快应用（aiot-toolkit）开发，可在手环 / 手表端查看课程表。

原作者仓库（手机端）：[HaoZai000/NexioSchedule](https://github.com/HaoZai000/NexioSchedule)

## 功能

- 手环端课程表展示
- 通过 `system.interconnect` 与手机端同步课程数据
- 本地存储（`system.storage`）缓存课程信息
- 关于页提供打赏入口（`/common/reward_qr.png`），打赏页可向右侧滑返回

## 项目结构

```
src/                 # 应用源码
  app.ux             # 应用入口
  pages/index/       # 主页面（首页 / 关于 / 打赏 三个视图，靠 isHome / isAbout / isReward 切换）
  common/            # 工具与资源（schedule / sync / util / reward_qr.png）
  manifest.json      # 应用配置
tools/               # 辅助脚本
```

> 胶囊屏版本 `../MI Band` 的 `node_modules` 是一个指向本工程 `node_modules` 的 junction，
> 借此共用同一套 aiot-toolkit。**请不要删除本工程的 `node_modules`**，否则那边也构建不了。

## 开发环境

- Node.js
- [aiot-toolkit](https://www.npmjs.com/package/aiot-toolkit)（小米 Vela 快应用工具链）

```bash
npm install
npm run server   # 本地预览（watch）
npm run build    # 构建
npm run release  # 发布构建
```

## 签名说明

签名证书与私钥位于 `sign/` 目录（**已从仓库排除，请勿提交**）。

- `sign/debug/`   — 调试签名
- `sign/release/` — 发布签名

如需重新生成签名文件，可参考 `tools/extract-sign.ps1`。

## 版本

当前版本见 `src/manifest.json`（versionName / versionCode）。

## License

请遵循原作者仓库的许可协议。
