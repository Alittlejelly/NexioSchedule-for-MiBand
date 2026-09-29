/**
 * Session 管理工具
 *
 * 负责工作流 Session 的创建、恢复、状态更新和 Checkpoint 管理。
 * 每个 Session 对应一次完整的工作流执行实例，包含三个阶段（S1/S2/S3）的状态信息。
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5
 */

const fs = require('fs');
const path = require('path');

// Session 存储根目录
const SESSIONS_DIR = path.resolve(__dirname, '../../.ai-workspace/sessions');

// 有效的阶段状态
const VALID_STATUSES = ['not_started', 'in_progress', 'pending_review', 'completed'];

// 有效的阶段 ID
const VALID_STAGE_IDS = ['S1', 'S2', 'S3'];

/**
 * 生成 Session ID
 * 格式: VELA-{YYYYMMDD}-{HHmmss}-{random4chars}
 * @returns {string} 生成的 Session ID
 */
function generateSessionId() {
  const now = new Date();
  const datePart = now.getFullYear().toString()
    + String(now.getMonth() + 1).padStart(2, '0')
    + String(now.getDate()).padStart(2, '0');
  const timePart = String(now.getHours()).padStart(2, '0')
    + String(now.getMinutes()).padStart(2, '0')
    + String(now.getSeconds()).padStart(2, '0');
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let random = '';
  for (let i = 0; i < 4; i++) {
    random += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `VELA-${datePart}-${timePart}-${random}`;
}

/**
 * 创建新的 Session
 *
 * 生成唯一的 session_id，创建 session 目录，并初始化 session.json。
 * session.json 包含所有必需字段和三个阶段的初始状态。
 *
 * @param {string} requirementName - 需求名称（如 "天气快应用"）
 * @returns {{ success: boolean, session?: object, error?: string }}
 */
function createSession(requirementName) {
  // 参数校验
  if (!requirementName || typeof requirementName !== 'string' || requirementName.trim() === '') {
    return { success: false, error: '需求名称不能为空' };
  }

  const sessionId = generateSessionId();
  const sessionDir = path.join(SESSIONS_DIR, sessionId);
  const now = new Date().toISOString();

  // 构建 session.json 数据结构
  const sessionData = {
    session_id: sessionId,
    requirement_name: requirementName.trim(),
    created_at: now,
    updated_at: now,
    current_stage: 'S1',
    stages: {
      S1: {
        status: 'not_started',
        output: null,
        completed_at: null
      },
      S2: {
        status: 'not_started',
        output: null,
        completed_at: null
      },
      S3: {
        status: 'not_started',
        output: null,
        completed_at: null
      }
    },
    inputs: {
      figma_urls: [],
      requirement_source: 'manual',
      requirement_description: '',
      screen_spec: null,  // { width: number, height: number, shape: "round"|"oval"|"square" }
      project_path: null  // 项目工程目录路径（相对于工作区根目录），如 'apps/packages_apps/wearable/myapp'
    },
    checkpoint: {
      active_context: null
    },
    workflow_mode: 'full'
  };

  try {
    // 创建 session 目录（递归创建，确保父目录存在）
    fs.mkdirSync(sessionDir, { recursive: true });

    // 安全写入 session.json
    const writeResult = safeWriteSessionJson(sessionId, sessionData);
    if (!writeResult.success) {
      return { success: false, error: `创建 Session 失败: ${writeResult.error}` };
    }

    return { success: true, session: sessionData };
  } catch (err) {
    return { success: false, error: `创建 Session 失败: ${err.message}` };
  }
}

/**
 * 恢复已有 Session
 *
 * 读取指定 Session 的 session.json 文件，校验格式完整性，返回 Session 对象。
 * 如果文件损坏或格式非法，返回错误信息。
 *
 * @param {string} sessionId - Session ID（如 "VELA-20260301-100000-ab12"）
 * @returns {{ success: boolean, session?: object, error?: string }}
 */
/**
 * 恢复已有 Session
 *
 * 读取指定 Session 的 session.json 文件，校验格式完整性，返回 Session 对象。
 * 如果文件损坏或格式非法，尝试自动修复常见问题（如非法字符），否则返回错误信息。
 *
 * @param {string} sessionId - Session ID（如 "VELA-20260301-100000-ab12"）
 * @returns {{ success: boolean, session?: object, error?: string }}
 */
function resumeSession(sessionId) {
  // 参数校验
  if (!sessionId || typeof sessionId !== 'string' || sessionId.trim() === '') {
    return { success: false, error: 'Session ID 不能为空' };
  }

  const sessionDir = path.join(SESSIONS_DIR, sessionId);
  const sessionFilePath = path.join(sessionDir, 'session.json');

  // 检查 session 目录是否存在
  if (!fs.existsSync(sessionDir)) {
    return { success: false, error: `Session 目录不存在: ${sessionId}` };
  }

  // 检查 session.json 是否存在
  if (!fs.existsSync(sessionFilePath)) {
    return { success: false, error: `session.json 文件不存在: ${sessionId}` };
  }

  let rawData;
  try {
    rawData = fs.readFileSync(sessionFilePath, 'utf-8');
  } catch (err) {
    return { success: false, error: `读取 session.json 失败: ${err.message}` };
  }

  let sessionData;
  try {
    sessionData = JSON.parse(rawData);
  } catch (parseErr) {
    // JSON 解析失败，尝试自动修复常见问题
    const repaired = tryRepairJson(rawData);
    if (repaired !== null) {
      try {
        sessionData = JSON.parse(repaired);
        // 修复成功，回写修复后的文件
        fs.writeFileSync(sessionFilePath, JSON.stringify(sessionData, null, 2), 'utf-8');
      } catch (_) {
        return { success: false, error: `session.json 文件损坏且无法自动修复，JSON 解析失败: ${parseErr.message}` };
      }
    } else {
      return { success: false, error: `session.json 文件损坏，JSON 解析失败: ${parseErr.message}` };
    }
  }

  // 校验必需字段
  const validationError = validateSessionData(sessionData);
  if (validationError) {
    return { success: false, error: `session.json 格式非法: ${validationError}` };
  }

  return { success: true, session: sessionData };
}
/**
 * 尝试修复常见的 JSON 损坏问题
 *
 * 处理以下情况：
 * - 中文引号（\u201c \u201d \u2018 \u2019）未转义导致字符串提前截断
 * - 尾部多余逗号
 * - BOM 头
 *
 * @param {string} raw - 原始 JSON 字符串
 * @returns {string|null} 修复后的字符串，无法修复返回 null
 */
function tryRepairJson(raw) {
  if (!raw || typeof raw !== 'string') return null;

  try {
    let repaired = raw;

    // 移除 BOM 头
    if (repaired.charCodeAt(0) === 0xFEFF) {
      repaired = repaired.slice(1);
    }

    // 替换中文引号为转义的 Unicode 序列（在 JSON 字符串值内部）
    // 这些字符在 JSON 字符串内是合法的，但如果被错误地当作裸字符写入会破坏结构
    repaired = repaired.replace(/\u201c/g, '\\u201c');
    repaired = repaired.replace(/\u201d/g, '\\u201d');
    repaired = repaired.replace(/\u2018/g, '\\u2018');
    repaired = repaired.replace(/\u2019/g, '\\u2019');

    // 移除尾部逗号（对象和数组中最后一个元素后的逗号）
    repaired = repaired.replace(/,\s*([\]}])/g, '$1');

    // 尝试解析验证
    JSON.parse(repaired);
    return repaired;
  } catch (_) {
    return null;
  }
}

/**
 * 安全写入 session.json
 *
 * 使用 JSON.stringify 确保所有内容正确序列化，避免手动拼接导致的格式问题。
 * 写入前先验证数据可以被正确序列化和反序列化。
 *
 * @param {string} sessionId - Session ID
 * @param {object} sessionData - 要写入的 Session 数据
 * @returns {{ success: boolean, error?: string }}
 */
function safeWriteSessionJson(sessionId, sessionData) {
  if (!sessionId || !sessionData) {
    return { success: false, error: '参数不能为空' };
  }

  const sessionFilePath = path.join(SESSIONS_DIR, sessionId, 'session.json');
  const tmpFilePath = sessionFilePath + '.tmp';

  try {
    // 序列化并验证往返一致性
    const serialized = JSON.stringify(sessionData, null, 2);
    JSON.parse(serialized); // 验证序列化结果可以被正确解析

    // 原子写入：先写临时文件，再 rename，防止写入中断导致 JSON 截断
    fs.writeFileSync(tmpFilePath, serialized, 'utf-8');
    fs.renameSync(tmpFilePath, sessionFilePath);
    return { success: true };
  } catch (err) {
    // 清理可能残留的临时文件
    try { fs.unlinkSync(tmpFilePath); } catch (_) { /* ignore */ }
    return { success: false, error: `写入 session.json 失败: ${err.message}` };
  }
}


/**
 * 校验 session.json 数据格式
 *
 * 确保所有必需字段存在且类型正确。
 *
 * @param {object} data - session.json 解析后的对象
 * @returns {string|null} 错误信息，null 表示校验通过
 */
function validateSessionData(data) {
  if (!data || typeof data !== 'object') {
    return '数据不是有效的 JSON 对象';
  }

  // 校验顶层必需字段
  const requiredFields = ['session_id', 'requirement_name', 'created_at', 'updated_at', 'current_stage', 'stages'];
  for (const field of requiredFields) {
    if (!(field in data)) {
      return `缺少必需字段: ${field}`;
    }
  }

  // 校验 session_id 格式
  if (typeof data.session_id !== 'string' || !data.session_id.startsWith('VELA-')) {
    return 'session_id 格式无效，应以 VELA- 开头';
  }

  // 校验 current_stage 是否为有效阶段
  if (!VALID_STAGE_IDS.includes(data.current_stage)) {
    return `current_stage 无效: ${data.current_stage}，应为 S1/S2/S3`;
  }

  // 校验 stages 结构
  if (!data.stages || typeof data.stages !== 'object') {
    return 'stages 字段不是有效的对象';
  }

  for (const stageId of VALID_STAGE_IDS) {
    if (!(stageId in data.stages)) {
      return `stages 中缺少阶段: ${stageId}`;
    }
    const stage = data.stages[stageId];
    if (!stage || typeof stage !== 'object') {
      return `阶段 ${stageId} 不是有效的对象`;
    }
    if (!('status' in stage)) {
      return `阶段 ${stageId} 缺少 status 字段`;
    }
    if (!VALID_STATUSES.includes(stage.status)) {
      return `阶段 ${stageId} 的 status 无效: ${stage.status}`;
    }
  }

  return null;
}

/**
 * 更新阶段状态
 *
 * 更新指定 Session 中某个阶段的状态和产出物路径。
 * 当状态为 completed 时，自动记录 completed_at 时间戳。
 *
 * @param {string} sessionId - Session ID
 * @param {string} stageId - 阶段 ID（S1/S2/S3）
 * @param {string} status - 新状态（not_started/in_progress/pending_review/completed）
 * @param {string|null} outputPath - 产出物文件路径（可选）
 * @returns {{ success: boolean, session?: object, error?: string }}
 */
function updateStageStatus(sessionId, stageId, status, outputPath) {
  // 参数校验
  if (!sessionId || typeof sessionId !== 'string') {
    return { success: false, error: 'Session ID 不能为空' };
  }
  if (!VALID_STAGE_IDS.includes(stageId)) {
    return { success: false, error: `无效的阶段 ID: ${stageId}，应为 S1/S2/S3` };
  }
  if (!VALID_STATUSES.includes(status)) {
    return { success: false, error: `无效的状态: ${status}，应为 ${VALID_STATUSES.join('/')}` };
  }

  // 先恢复 Session 以确保数据有效
  const result = resumeSession(sessionId);
  if (!result.success) {
    return result;
  }

  const sessionData = result.session;
  const now = new Date().toISOString();

  // 更新阶段状态
  sessionData.stages[stageId].status = status;
  sessionData.updated_at = now;

  // 当状态为 completed 时，记录完成时间和产出物路径
  if (status === 'completed') {
    sessionData.stages[stageId].completed_at = now;
    if (outputPath) {
      sessionData.stages[stageId].output = outputPath;
    }
  }

  // 非 completed 状态下也可以更新产出物路径
  if (outputPath && status !== 'completed') {
    sessionData.stages[stageId].output = outputPath;
  }

  // 安全写回 session.json
  const writeResult = safeWriteSessionJson(sessionId, sessionData);
  if (!writeResult.success) {
    return { success: false, error: `更新阶段状态失败: ${writeResult.error}` };
  }

  return { success: true, session: sessionData };
}

/**
 * 获取阶段 Checkpoint 信息
 *
 * 读取指定 Session 中某个阶段的 checkpoint 信息，
 * 包含阶段状态、产出物路径和完成时间。
 *
 * @param {string} sessionId - Session ID
 * @param {string} stageId - 阶段 ID（S1/S2/S3）
 * @returns {{ success: boolean, checkpoint?: object, error?: string }}
 */
function getCheckpoint(sessionId, stageId) {
  // 参数校验
  if (!sessionId || typeof sessionId !== 'string') {
    return { success: false, error: 'Session ID 不能为空' };
  }
  if (!VALID_STAGE_IDS.includes(stageId)) {
    return { success: false, error: `无效的阶段 ID: ${stageId}，应为 S1/S2/S3` };
  }

  // 恢复 Session 数据
  const result = resumeSession(sessionId);
  if (!result.success) {
    return result;
  }

  const sessionData = result.session;
  const stage = sessionData.stages[stageId];

  // 构建 checkpoint 信息
  const checkpoint = {
    stage_id: stageId,
    status: stage.status,
    output: stage.output,
    completed_at: stage.completed_at
  };

  // 如果 session.json 中有该阶段的详细 checkpoint 数据，也一并返回
  if (sessionData.checkpoint && sessionData.checkpoint[stageId]) {
    checkpoint.details = sessionData.checkpoint[stageId];
  }

  return { success: true, checkpoint: checkpoint };
}

// 导出所有函数
module.exports = {
  createSession,
  resumeSession,
  updateStageStatus,
  getCheckpoint,
  // 导出辅助函数和常量，便于测试
  generateSessionId,
  validateSessionData,
  tryRepairJson,
  safeWriteSessionJson,
  SESSIONS_DIR,
  VALID_STATUSES,
  VALID_STAGE_IDS
};
