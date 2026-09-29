# 快捷命令处理

> 本文件由 `workflow_starter.md` 引用，定义所有快捷命令的处理逻辑。

---

## 命令一览

| 命令 | 说明 |
|------|------|
| `y` | 确认通过当前阶段产出 |
| `e` | 编辑修改，基于反馈迭代生成 |
| `n` | 放弃当前产出，重新生成 |
| `q` | 退出并保存当前进度 |
| `status` | 查看三阶段完成进度 |
| `back` | 返回上一阶段 |

---

## `y` — 确认通过

当用户输入 `y` 时，执行以下步骤：

1. 调用 `updateStageStatus(sessionId, stageId, 'completed', outputPath)` 将当前阶段标记为 `completed`
2. 保存产出物文件路径到 `session.json` 对应阶段的 `output` 字段
3. 读取 `workflow-config.json` 中当前阶段的 `next_stage`
4. **若 `next_stage` 存在**（S1 → S2，S2 → S3）：
   - 更新 `session.json` 的 `current_stage` 为 `next_stage`
   - 输出：
     ```
     ✅ 阶段 {stageId} - {stageName} 已完成
     ➡️ 自动进入下一阶段: {next_stageId} - {next_stageName}
     ```
   - 返回 workflow_starter.md 的 Step 3 执行下一阶段
5. **若 `next_stage` 为 `null`**（S3 完成）：
   - 输出工作流完成总结：
     ```
     🎉 Vela 快应用开发工作流已全部完成！

     📊 完成总结:
       ✅ S1 PRD 生成 — 01-prd.md
       ✅ S2 技术方案 — 02-tech-design.md
       ✅ S3 功能研发 — 代码已写入项目工程目录

     📂 PRD 和技术方案保存在: .ai-workspace/sessions/{session_id}/
     ```

---

## `e` — 编辑修改

当用户输入 `e` 时，进入迭代编辑模式：

1. 提示用户输入修改意见：
   ```
   ✏️ 请输入修改意见（描述需要调整的内容）:
   ```
2. 接收用户反馈后，将修改意见追加到当前阶段 Agent 的上下文中
3. 重新执行当前阶段的 Agent（携带修改意见上下文）
4. 展示新的产出物，再次进入 Step 4 结果展示
5. 用户可继续选择 `y`（确认）、`e`（再次编辑）或 `n`（放弃）
6. **支持多轮迭代**，直到用户选择 `y` 或 `n` 退出编辑模式

> 每轮编辑的修改意见会累积传递给 Agent，确保迭代上下文连贯。

### 编辑上下文管理策略

为防止多轮编辑导致上下文过长（超出 token 限制或分散 Agent 注意力），采用以下策略：

- **保留最近 3 轮**的完整修改意见
- **第 4 轮及更早**的修改意见，仅保留一句话摘要（由 Agent 在每轮结束时自动生成）
- 上下文格式：
  ```
  [历史修改摘要]
  - 第1轮: {一句话摘要}
  - 第2轮: {一句话摘要}

  [最近修改意见]
  --- 第3轮 ---
  {完整修改意见}
  --- 第4轮 ---
  {完整修改意见}
  --- 第5轮（当前）---
  {完整修改意见}
  ```
- 若累计编辑超过 **5 轮**，提示用户考虑使用 `n` 放弃重新生成：
  ```
  💡 已迭代 {round} 轮，若调整较大建议输入 n 重新生成。
  ```

---

## `n` — 放弃重新生成

当用户输入 `n` 时：

1. 丢弃当前阶段的产出物
2. 调用 `updateStageStatus(sessionId, stageId, 'in_progress')` 重置阶段状态
3. 清除 Agent 上下文中的历史修改意见（若有）
4. 从头重新执行当前阶段，返回 workflow_starter.md 的 Step 3
5. 输出：
   ```
   🔄 已放弃当前产出，正在重新生成阶段 {stageId} - {stageName}...
   ```

---

## `q` — 退出保存进度

当用户输入 `q` 时：

1. 保存当前 Session 状态到 `session.json`（包括当前阶段、各阶段状态）
2. 更新 `user-config.json` 的 `last_session.session_id` 为当前 Session ID
3. 输出保存确认：
   ```
   💾 进度已保存
   📝 Session ID: {session_id}
   🎯 当前阶段: {stageId} - {stageName}
   👋 下次启动时将自动恢复到当前进度。
   ```

---

## `status` — 查看进度

当用户输入 `status` 时：

1. 读取 `session.json` 中的 `stages` 和 `current_stage`
2. 展示三阶段进度表：
   ```
   📊 工作流进度:
     {图标} S1 PRD 生成 — {status}
     {图标} S2 技术方案 — {status}
     {图标} S3 功能研发 — {status}
   🎯 当前阶段: {current_stage} - {current_stage_name}
   ```

**状态图标映射**：

| 状态 | 图标 |
|------|------|
| `completed` | ✅ |
| `in_progress` | 🔄 |
| `pending_review` | ⏳ |
| `not_started` | ⬜ |
| `skipped` | ⏭️ |

当前阶段额外标注 `← 当前` 指示符。

---

## `back` — 返回上一阶段

当用户输入 `back` 时，根据当前阶段判断：

| 当前阶段 | 行为 |
|---------|------|
| S1 | 无法返回，输出：`⚠️ 当前已是第一个阶段，无法返回。` |
| S2 | 返回 S1，更新 `session.json` 的 `current_stage` 为 `S1` |
| S3 | 返回 S2，更新 `session.json` 的 `current_stage` 为 `S2` |

返回成功时输出：
```
⬅️ 已返回阶段 {prev_stageId} - {prev_stageName}
```

然后返回 workflow_starter.md 的 Step 3 执行该阶段。

> 返回上一阶段不会清除已完成阶段的产出物，用户可重新审核或修改。
