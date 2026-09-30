# NexioSchedule-for-MiBand

Nexio 课程表的 **小米手环版**，基于 Vela 快应用（aiot-toolkit）开发，可在手环 / 手表端查看课程表。

原作者仓库（手机端）：[HaoZai000/NexioSchedule](https://github.com/HaoZai000/NexioSchedule)

## 功能

- 手环端课程表展示
- 通过 `system.interconnect` 与手机端同步课程数据
- 本地存储（`system.storage`）缓存课程信息

## 项目结构

```
src/                 # 应用源码
  app.ux             # 应用入口
  pages/index/       # 主页面
  common/            # 工具与资源（schedule / sync / util）
  manifest.json      # 应用配置
sign-rpk.js          # RPK 签名脚本
tools/               # 辅助脚本
check_*.py           # 构建 / 包体检查脚本
```

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

| 版本 | versionCode | 说明 | 下载 |
|------|-------------|------|------|
| 1.1.0 | 19 | 新增左右横滑查看更多课表 | [release/com.haooz.chedule.release.1.1.0.rpk](./release/com.haooz.chedule.release.1.1.0.rpk) |
| 1.0.1 | 18 | 布局铺满屏幕；下节课课名折行显示 | [release/com.haooz.chedule.release.1.0.1.rpk](./release/com.haooz.chedule.release.1.0.1.rpk) |
| 1.0.0 | 17 | 首个手环端正式签名发行包 | [release/com.haooz.chedule.release.1.0.0.rpk](./release/com.haooz.chedule.release.1.0.0.rpk) |

当前版本见 `src/manifest.json`（versionName / versionCode）。

## License

请遵循原作者仓库的许可协议。
