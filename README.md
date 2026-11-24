# NexioSchedule-for-MiBand

Nexio 课程表的 **小米手环版**，基于 Vela 快应用（aiot-toolkit）开发，可在手环 / 手表端查看课程表。

原作者仓库（手机端）：[HaoZai000/NexioSchedule](https://github.com/HaoZai000/NexioSchedule)

## 功能

- 手环端课程表展示（首页 / 关于 / 打赏三个视图）
- 通过 `system.interconnect` 与手机端同步课程数据，**协议 version=4 整表**：
  手机一次下发完整学期（`courses` + `settings` + `times` + `holidays`），
  手环按 `class_start_time` 自行推算任意日期的教学周并按周次规则过滤
- 教学周、单双周 / 选周、节次时间、假期与调休一律以手机下发数据为准；
  调休按 `followDate`（绝对日期）换课，换课表不会跟错
- 本地存储（`system.storage`）缓存课表：断开手机或冷启动后仍可查看
- 打开应用时按需向手机拉取一次，请求无响应会自动重试
- **支持被反向导出**：对端（AstroBox 插件「Nexio课程表推送器」）发 `action=export`
  时，把手环缓存的整表原样回传，可在插件里存成 JSON 或转推到其它手环；
  没有课表时回 `ok:false, error:"no_schedule"`，不让对端干等超时
- **回传时有全屏反馈**：导出期间盖一层「正在回传课表」（蓝圈白箭头 + 进度条），
  回包发出后自动收起 —— 手表上不再出现「点了没反应」的空窗
- **导入失败时有全屏反馈**：手机推来的课表用不了（坏 JSON / 协议不符 / 没有
  `courses` 数组），或 `request` 重试用尽仍无回应时，盖一层设计稿的「传输出错」页
  （红圈白叉 + 最近 5 行传输日志：哪一步、为什么、怎么办），点一下收起；
  同一类错误收起后不再反复弹，传输成功一次即自动收起
- 首页显示「· 第 N 周」；关于页有手机连接状态卡，未连接时直接给出原因
  （`手机端未安装 Nexio` / `连接超时，检查配对` / `连接异常，重开 App`，
  来自 `connect.diagnosis`）
- 关于页提供打赏入口（`/common/reward_qr.png`），打赏页可向右侧滑返回

> **协议兼容性**：旧协议的按周分桶（v1/v2）与按日期直推（v3）路径已移除。
> 收到非 v4 包会明确拒绝并要求升级手机端，因此本 rpk 需与带 `buildFullJson` 的
> 新版 APK 一起上线。

## 项目结构

```
src/                 # 应用源码
  app.ux             # 应用入口
  pages/index/       # 主页面（首页 / 关于 / 打赏 三个视图，靠 isHome / isAbout / isReward 切换）
  common/            # 工具与资源（schedule / sync / util / reward_qr.png）
  manifest.json      # 应用配置
tools/               # 辅助脚本
  check-wearable-sync.mjs   # 与手机端通讯的回归检查（不需要设备）
  create_github_release.py  # 发布 GitHub Release 并上传 rpk
  release-body.md           # 上一步使用的 Release 说明
release/             # 随仓库发布的 rpk（两个分辨率）
CHANGELOG.md         # 更新日志
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

## 测试

与手机端的通讯逻辑有回归检查（纯 Node，不需要设备，也不依赖 aiot-toolkit）：

```bash
node tools/check-wearable-sync.mjs                      # 协议 / 周次 / 调休 / 缓存
node tools/check-wearable-sync.mjs 我的课表.json         # 追加真实课表的端到端校验
```

覆盖：v4 整表解析、旧协议（v1/v2/v3）必须被拒绝、周次逐日推算与校准（基准为手机
`sentAt`，与手环本机时钟无关）、周次规则（`selectedWeeks` / 单双周 / 周次范围）、
假期隐藏、调休按 `followDate` 换课（缺失时回退 `followWeekday`）、时间与节次解析、
`action=clear`、冷启动缓存回放（`sentAt` 随缓存持久化）、通道诊断码文案、
`action=export` 导出回包（结构 / `sentAt` 原样 / 假期字段换回 `date` / 空课表回
`no_schedule` / 冷启动仅有缓存时仍可导出）。

## 手机推不过来怎么排查

手环侧只看「关于 → 手机连接状态卡」的副文案，它来自 `connect.diagnosis`：

| 文案 | 诊断码 | 该做什么 |
|---|---|---|
| `手机端未安装 Nexio` | 1001 | 手机上装 Nexio 课程表（包名必须是 `com.haooz.chedule`） |
| `连接超时，检查配对` | 204 | 小米运动健康里重新配对手机与手环、确认蓝牙已连 |
| `连接异常，重开 App` | 1000 | 多为**签名不一致**：rpk 与 APK 必须同一证书，重装配套版本 |

判不出原因（例如老固件没有 `diagnosis`）时，手环仍会自动重试：`onopen` 强制拉、
数据过期（5 分钟）主动 request、通道就绪时每 5 分钟轮询一次。

## 发布

```bash
npm run release                                                   # 生成 dist/com.haooz.chedule.release.<版本>.rpk
cp dist/com.haooz.chedule.release.<版本>.rpk "release/Nexio 课程表（小米手环10Pro）.rpk"
python tools/create_github_release.py <版本>                        # 建 Release 并上传两个 rpk
```

`release/` 下两个 rpk 随版本更新（胶囊屏那份由 `../MI Band` 构建后复制过来）。

## 签名说明

签名证书与私钥位于 `sign/` 目录（**已从仓库排除，请勿提交**）。

- `sign/debug/`   — 调试签名
- `sign/release/` — 发布签名

如需重新生成签名文件，可参考 `tools/extract-sign.ps1`。

## 版本

当前版本见 `src/manifest.json`（versionName / versionCode），历史见 [CHANGELOG.md](./CHANGELOG.md)。

## License

请遵循原作者仓库的许可协议。
