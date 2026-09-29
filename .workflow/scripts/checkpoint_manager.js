/**
 * Checkpoint 管理模块
 *
 * 负责阶段间的人工审核（Checkpoint）机制和阶段流转逻辑。
 * 提供产出物审核状态管理、y/e/n 命令处理、阶段推进和前置条件校验。
 *
 * Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 10.2, 10.5
 */

const fs = require('fs');
const path = require('path');
const {
  resumeSession,
  updateStageStatus,
  safeWriteSessionJson,
  SESSIONS_DIR,
  VALID_STAGE_IDS
} = require('./session_manager');

// 工作流配置文件路径
const WORKFLOW_CONFIG_PATH = path.resolve(__dirname, '../workflow-config.json');

/**
 * 加载工作流配置
 * @returns {{ success: boolean, config?: object, error?: string }}
 */
function loadWorkflowConfig() {
  try {
    const raw = fs.readFileSync(WORKFLOW_CONFIG_PATH, 'utf-8');
    return { success: true, config: JSON.parse(raw) };
  } catch (err) {
    return { success: false, error: `加载工作流配置失败: ${err.message}` };
  }
}

/**
 * 处理 Checkpoint（阶段审核点）
 *
 * 当阶段产出物生成完成时调用，将阶段状态设为 pending_review，
 * 返回描述 checkpoint 状态的对象供工作流编排器使用。
 *
 * @param {string} sessionId - Session ID
 * @param {string} stageId - 阶段 ID（S1/S2/S3）
 * @param {string} output - 产出物内容路径
 * @returns {{ success: boolean, checkpoint?: object, error?: string }}
 */
function handleCheckpoint(sessionId, stageId, output) {
  // 参数校验
  if (!sessionId || typeof sessionId !== 'string') {
    return { success: false, error: 'Session ID 不能为空' };
  }
  if (!VALID_STAGE_IDS.includes(stageId)) {
    return { success: false, error: `无效的阶段 ID: ${stageId}，应为 S1/S2/S3` };
  }
  if (!output || typeof output !== 'string') {
    return { success: false, error: '产出物路径不能为空' };
  }

  // 加载工作流配置获取阶段名称
  const configResult = loadWorkflowConfig();
  if (!configResult.success) {
    return configResult;
  }

  const stageConfig = configResult.config.stages[stageId];
  if (!stageConfig) {
    return { success: false, error: `工作流配置中未找到阶段: ${stageId}` };
  }

  // 更新阶段状态为 pending_review
  const updateResult = updateStageStatus(sessionId, stageId, 'pending_review', output);
  if (!updateResult.success) {
    return updateResult;
  }

  return {
    success: true,
    checkpoint: {
      stageId,
      stageName: stageConfig.name,
      outputPath: output,
      status: 'pending_review'
    }
  };
}

/**
 * 处理 Checkpoint 命令（y/e/n）
 *
 * 根据用户的审核命令执行对应操作：
 * - y: 标记阶段为 completed，推进到下一阶段
 * - e: 保持阶段为 in_progress，返回编辑指示
 * - n: 重置阶段为 in_progress，清除产出物
 *
 * @param {string} sessionId - Session ID
 * @param {string} stageId - 阶段 ID（S1/S2/S3）
 * @param {string} command - 用户命令（y/e/n）
 * @param {string} outputPath - 当前产出物路径
 * @returns {{ success: boolean, result?: object, error?: string }}
 */
function processCheckpointCommand(sessionId, stageId, command, outputPath) {
  // 参数校验
  if (!sessionId || typeof sessionId !== 'string') {
    return { success: false, error: 'Session ID 不能为空' };
  }
  if (!VALID_STAGE_IDS.includes(stageId)) {
    return { success: false, error: `无效的阶段 ID: ${stageId}，应为 S1/S2/S3` };
  }
  if (!['y', 'e', 'n'].includes(command)) {
    return { success: false, error: `无效的命令: ${command}，应为 y/e/n` };
  }

  if (command === 'y') {
    // 确认通过：标记为 completed，推进到下一阶段
    const updateResult = updateStageStatus(sessionId, stageId, 'completed', outputPath);
    if (!updateResult.success) {
      return updateResult;
    }

    const advanceResult = advanceToNextStage(sessionId, stageId);
    if (!advanceResult.success) {
      return advanceResult;
    }

    return {
      success: true,
      result: {
        action: 'advance',
        nextStage: advanceResult.nextStage
      }
    };
  }

  if (command === 'e') {
    // 编辑修改：保持为 in_progress，等待用户反馈后重新生成
    const updateResult = updateStageStatus(sessionId, stageId, 'in_progress', outputPath);
    if (!updateResult.success) {
      return updateResult;
    }

    return {
      success: true,
      result: {
        action: 'edit'
      }
    };
  }

  // command === 'n'
  // 放弃重新生成：重置为 in_progress，清除产出物
  const updateResult = updateStageStatus(sessionId, stageId, 'in_progress', null);
  if (!updateResult.success) {
    return updateResult;
  }

  return {
    success: true,
    result: {
      action: 'redo'
    }
  };
}

/**
 * 推进到下一阶段
 *
 * 根据 workflow-config.json 中的 next_stage 配置，更新 session.json 的 current_stage。
 * 如果当前阶段是最终阶段（next_stage 为 null），返回工作流完成指示。
 *
 * @param {string} sessionId - Session ID
 * @param {string} currentStageId - 当前阶段 ID（S1/S2/S3）
 * @returns {{ success: boolean, nextStage: string|null, isComplete: boolean, error?: string }}
 */
function advanceToNextStage(sessionId, currentStageId) {
  // 参数校验
  if (!sessionId || typeof sessionId !== 'string') {
    return { success: false, nextStage: null, isComplete: false, error: 'Session ID 不能为空' };
  }
  if (!VALID_STAGE_IDS.includes(currentStageId)) {
    return { success: false, nextStage: null, isComplete: false, error: `无效的阶段 ID: ${currentStageId}，应为 S1/S2/S3` };
  }

  // 加载工作流配置
  const configResult = loadWorkflowConfig();
  if (!configResult.success) {
    return { success: false, nextStage: null, isComplete: false, error: configResult.error };
  }

  const stageConfig = configResult.config.stages[currentStageId];
  if (!stageConfig) {
    return { success: false, nextStage: null, isComplete: false, error: `工作流配置中未找到阶段: ${currentStageId}` };
  }

  const nextStage = stageConfig.next_stage;

  // 如果没有下一阶段，工作流完成
  if (!nextStage) {
    return { success: true, nextStage: null, isComplete: true };
  }

  // 更新 session.json 的 current_stage
  const sessionResult = resumeSession(sessionId);
  if (!sessionResult.success) {
    return { success: false, nextStage: null, isComplete: false, error: sessionResult.error };
  }

  const sessionData = sessionResult.session;
  sessionData.current_stage = nextStage;
  sessionData.updated_at = new Date().toISOString();

  const writeResult = safeWriteSessionJson(sessionId, sessionData);
  if (!writeResult.success) {
    return { success: false, nextStage: null, isComplete: false, error: `更新 Session 失败: ${writeResult.error}` };
  }
  return { success: true, nextStage, isComplete: false };
}

/**
 * 校验前置条件
 *
 * 检查指定阶段的所有前置阶段是否已完成。
 * 根据 workflow-config.json 中的 prerequisites 配置进行校验。
 *
 * @param {string} sessionId - Session ID
 * @param {string} stageId - 要校验的阶段 ID（S1/S2/S3）
 * @returns {{ success: boolean, valid?: boolean, missingPrerequisites?: string[], error?: string }}
 */
function validatePrerequisites(sessionId, stageId) {
  // 参数校验
  if (!sessionId || typeof sessionId !== 'string') {
    return { success: false, error: 'Session ID 不能为空' };
  }
  if (!VALID_STAGE_IDS.includes(stageId)) {
    return { success: false, error: `无效的阶段 ID: ${stageId}，应为 S1/S2/S3` };
  }

  // 加载工作流配置
  const configResult = loadWorkflowConfig();
  if (!configResult.success) {
    return { success: false, error: configResult.error };
  }

  const stageConfig = configResult.config.stages[stageId];
  if (!stageConfig) {
    return { success: false, error: `工作流配置中未找到阶段: ${stageId}` };
  }

  const prerequisites = stageConfig.prerequisites || [];

  // 没有前置条件，直接通过
  if (prerequisites.length === 0) {
    return { success: true, valid: true, missingPrerequisites: [] };
  }

  // 恢复 Session 数据
  const sessionResult = resumeSession(sessionId);
  if (!sessionResult.success) {
    return { success: false, error: sessionResult.error };
  }

  const stages = sessionResult.session.stages;
  const missing = [];

  for (const prereq of prerequisites) {
    if (!stages[prereq] || stages[prereq].status !== 'completed') {
      missing.push(prereq);
    }
  }

  return {
    success: true,
    valid: missing.length === 0,
    missingPrerequisites: missing
  };
}

module.exports = {
  handleCheckpoint,
  processCheckpointCommand,
  advanceToNextStage,
  validatePrerequisites,
  loadWorkflowConfig,
  WORKFLOW_CONFIG_PATH
};
