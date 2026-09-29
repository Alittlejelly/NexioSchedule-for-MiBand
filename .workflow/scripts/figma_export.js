/**
 * Figma 导出模块
 *
 * 负责解析 Figma URL、校验 API Token、准备导出请求和保存导出数据。
 * 实际的 Figma API 调用由 Figma MCP 工具在运行时完成，本模块负责
 * URL 解析、Token 校验、目录准备和数据持久化。
 *
 * Requirements: 9.1, 9.2, 9.3, 9.4
 */

const fs = require('fs');
const path = require('path');

// Session 存储根目录
const SESSIONS_DIR = path.resolve(__dirname, '../../.ai-workspace/sessions');

// 用户配置文件路径
const USER_CONFIG_PATH = path.resolve(__dirname, '../../.ai-workspace/user-config.json');

/**
 * 解析 Figma 文件 URL，提取 fileKey 和可选的 nodeId
 *
 * 支持的 URL 格式：
 * - https://www.figma.com/file/{fileKey}/...
 * - https://www.figma.com/design/{fileKey}/...
 * - 带 node-id 查询参数: ?node-id=1234:5678 或 ?node-id=1234-5678
 *
 * @param {string} url - Figma 文件 URL
 * @returns {{ success: boolean, fileKey?: string, nodeId?: string, error?: string }}
 */
function parseFigmaUrl(url) {
  if (!url || typeof url !== 'string' || url.trim() === '') {
    return { success: false, error: 'Figma URL 不能为空' };
  }

  const trimmedUrl = url.trim();

  // 匹配 figma.com/file/{fileKey}、figma.com/design/{fileKey} 或 figma.com/board/{fileKey}
  const pattern = /^https?:\/\/(?:www\.)?figma\.com\/(?:file|design|board)\/([a-zA-Z0-9]+)/;
  const match = trimmedUrl.match(pattern);

  if (!match) {
    return {
      success: false,
      error: 'Figma URL 格式无效。期望格式: https://www.figma.com/file/{fileKey}/... 或 https://www.figma.com/design/{fileKey}/...'
    };
  }

  const fileKey = match[1];
  const result = { success: true, fileKey };

  // 尝试提取 node-id 查询参数
  try {
    const urlObj = new URL(trimmedUrl);
    const nodeIdParam = urlObj.searchParams.get('node-id');
    if (nodeIdParam) {
      // node-id 可能是 "1234:5678" 或 "1234-5678" 格式
      result.nodeId = nodeIdParam.replace(/-/g, ':');
    }
  } catch (_) {
    // URL 解析失败时忽略 node-id，fileKey 已成功提取
  }

  return result;
}

/**
 * @deprecated 已废弃。Figma 集成现在完全通过 MCP 工具实现，不再需要单独的 API Token。
 * 保留此函数仅为向后兼容，始终返回成功。
 *
 * @returns {{ success: boolean, token?: string }}
 */
function loadFigmaToken() {
  return { success: true, token: '' };
}


/**
 * 导出设计稿（准备阶段）
 *
 * 校验 Figma URL 格式和 API Token，创建 figma-exports/ 目录，
 * 返回解析后的 fileKey 和 nodeId 供 Figma MCP 工具使用。
 *
 * 注意：实际的 Figma API 调用由 MCP 工具在运行时完成，
 * 本函数仅负责校验和准备工作。
 *
 * @param {string} figmaUrl - Figma 文件 URL
 * @param {string} sessionId - Session ID
 * @returns {{ success: boolean, fileKey?: string, nodeId?: string, exportDir?: string, error?: string }}
 */
function exportDesign(figmaUrl, sessionId) {
  // 参数校验
  if (!sessionId || typeof sessionId !== 'string' || sessionId.trim() === '') {
    return { success: false, error: 'Session ID 不能为空' };
  }

  // 1. 解析 Figma URL
  const urlResult = parseFigmaUrl(figmaUrl);
  if (!urlResult.success) {
    return { success: false, error: urlResult.error };
  }

  // 2. 校验 Session 目录存在
  const sessionDir = path.join(SESSIONS_DIR, sessionId);
  if (!fs.existsSync(sessionDir)) {
    return { success: false, error: `Session 目录不存在: ${sessionId}。请先创建 Session` };
  }

  // 3. 创建 figma-exports/ 目录
  const exportDir = path.join(sessionDir, 'figma-exports');
  try {
    fs.mkdirSync(exportDir, { recursive: true });
  } catch (err) {
    return { success: false, error: `创建 figma-exports 目录失败: ${err.message}` };
  }

  const result = {
    success: true,
    fileKey: urlResult.fileKey,
    exportDir
  };

  if (urlResult.nodeId) {
    result.nodeId = urlResult.nodeId;
  }

  return result;
}

/**
 * 保存 Figma 导出数据
 *
 * 将 Figma MCP 工具返回的 JSON 数据和图片保存到 Session 的 figma-exports/ 目录。
 * - JSON 数据保存为 design_{index}.json（支持多个设计稿）
 * - 图片保存到 images/ 子目录
 *
 * @param {string} sessionId - Session ID
 * @param {object} jsonData - Figma 导出的 JSON 结构数据
 * @param {Array<{name: string, data: Buffer|string}>} [images] - 图片数据数组（可选）
 * @param {number} [index=0] - 设计稿序号（支持多个 Figma 链接时区分不同设计稿）
 * @returns {{ success: boolean, savedFiles?: { json: string, images: string[] }, error?: string }}
 */
function saveFigmaData(sessionId, jsonData, images, index) {
  // 参数校验
  if (!sessionId || typeof sessionId !== 'string' || sessionId.trim() === '') {
    return { success: false, error: 'Session ID 不能为空' };
  }

  if (!jsonData || typeof jsonData !== 'object') {
    return { success: false, error: '导出的 JSON 数据不能为空' };
  }

  const figmaIndex = (typeof index === 'number' && index >= 0) ? index : 0;

  const sessionDir = path.join(SESSIONS_DIR, sessionId);
  if (!fs.existsSync(sessionDir)) {
    return { success: false, error: `Session 目录不存在: ${sessionId}` };
  }

  const exportDir = path.join(sessionDir, 'figma-exports');
  const savedFiles = { json: '', images: [] };

  try {
    // 确保 figma-exports/ 目录存在
    fs.mkdirSync(exportDir, { recursive: true });

    // 保存 JSON 数据（按序号命名：design_0.json, design_1.json, ...）
    const jsonFileName = figmaIndex === 0 ? 'design.json' : `design_${figmaIndex}.json`;
    const jsonPath = path.join(exportDir, jsonFileName);
    const serialized = JSON.stringify(jsonData, null, 2);
    // 验证往返一致性
    try {
      JSON.parse(serialized);
    } catch (validateErr) {
      return { success: false, error: `Figma JSON 数据序列化验证失败: ${validateErr.message}` };
    }
    fs.writeFileSync(jsonPath, serialized, 'utf-8');
    savedFiles.json = jsonPath;

    // 保存图片（如果有）
    if (images && Array.isArray(images) && images.length > 0) {
      const imagesDir = path.join(exportDir, 'images');
      fs.mkdirSync(imagesDir, { recursive: true });

      for (const img of images) {
        if (!img || !img.name || !img.data) {
          continue;
        }
        const imgPath = path.join(imagesDir, img.name);
        fs.writeFileSync(imgPath, img.data);
        savedFiles.images.push(imgPath);
      }
    }

    return { success: true, savedFiles };
  } catch (err) {
    return { success: false, error: `保存 Figma 导出数据失败: ${err.message}` };
  }
}

/**
 * 从 Figma 节点树中提取需要下载的图片/图标节点
 *
 * 扫描 get_figma_data 返回的节点树，识别以下类型的可导出节点：
 * - 包含 imageRef 填充的节点（位图图片）
 * - 类型为 VECTOR/BOOLEAN_OPERATION/LINE/STAR/POLYGON 的矢量图标
 * - 名称包含 "icon"/"ic_"/"img"/"image"/"logo" 的节点
 * - 已配置 exportSettings 的节点
 *
 * @param {object} figmaData - mcp_figma_get_figma_data 返回的节点树数据
 * @param {string} fileKey - Figma 文件 key
 * @returns {{ nodes: Array<{nodeId: string, fileName: string, imageRef?: string}>, fileKey: string }}
 */
function extractImageNodes(figmaData, fileKey) {
  const nodes = [];
  const seenIds = new Set();

  // 图标/图片相关名称模式（支持下划线/连字符分隔和驼峰命名）
  const imageNamePattern = /(?:^|[\s_\-/.])(icon|ic|img|image|logo|illustration|photo|avatar|badge|thumbnail)(?:$|[\s_\-/.])|^(icon|ic_|img|image|logo)/i;
  // 矢量节点类型
  const vectorTypes = new Set(['VECTOR', 'BOOLEAN_OPERATION', 'LINE', 'STAR', 'POLYGON']);

  function walk(node) {
    if (!node || seenIds.has(node.id)) return;

    let shouldExport = false;
    let imageRef = null;
    let format = 'png';

    // 检查是否有 imageRef 填充（位图）
    if (node.fills && Array.isArray(node.fills)) {
      for (const fill of node.fills) {
        if (fill.type === 'IMAGE' && fill.imageRef) {
          shouldExport = true;
          imageRef = fill.imageRef;
          format = 'png';
          break;
        }
      }
    }

    // 检查是否有 exportSettings
    if (!shouldExport && node.exportSettings && node.exportSettings.length > 0) {
      shouldExport = true;
      const firstSetting = node.exportSettings[0];
      format = (firstSetting.format || 'png').toLowerCase();
      if (format !== 'svg' && format !== 'png') format = 'png';
    }

    // 检查矢量类型节点（导出为 SVG）
    if (!shouldExport && vectorTypes.has(node.type)) {
      shouldExport = true;
      format = 'svg';
    }

    // 检查名称匹配
    if (!shouldExport && node.name && imageNamePattern.test(node.name)) {
      shouldExport = true;
      format = vectorTypes.has(node.type) ? 'svg' : 'png';
    }

    if (shouldExport && node.id) {
      seenIds.add(node.id);
      // 生成安全文件名：将特殊字符替换为下划线
      const safeName = (node.name || `node_${node.id}`)
        .replace(/[^a-zA-Z0-9_\-\u4e00-\u9fff]/g, '_')
        .replace(/_+/g, '_')
        .substring(0, 80);
      const fileName = `${safeName}.${format}`;

      const entry = { nodeId: node.id.replace(/:/g, ':'), fileName };
      if (imageRef) entry.imageRef = imageRef;
      nodes.push(entry);
    }

    // 递归子节点
    if (node.children && Array.isArray(node.children)) {
      for (const child of node.children) {
        walk(child);
      }
    }
  }

  // 处理 figmaData 的不同结构
  if (figmaData.document) {
    walk(figmaData.document);
  } else if (figmaData.nodes) {
    for (const key of Object.keys(figmaData.nodes)) {
      const nodeData = figmaData.nodes[key];
      walk(nodeData.document || nodeData);
    }
  } else {
    walk(figmaData);
  }

  return { nodes, fileKey };
}

/**
 * 保存通过 mcp_figma_download_figma_images 下载的图片文件路径清单
 *
 * 在 figma-exports/ 目录下生成 image-manifest.json，记录所有已下载图片的信息，
 * 供后续 S3 编码阶段引用。
 *
 * @param {string} sessionId - Session ID
 * @param {Array<{nodeId: string, fileName: string, localPath: string}>} downloadedImages - 已下载的图片列表
 * @returns {{ success: boolean, manifestPath?: string, error?: string }}
 */
function saveImageManifest(sessionId, downloadedImages) {
  if (!sessionId || typeof sessionId !== 'string' || sessionId.trim() === '') {
    return { success: false, error: 'Session ID 不能为空' };
  }

  const sessionDir = path.join(SESSIONS_DIR, sessionId);
  if (!fs.existsSync(sessionDir)) {
    return { success: false, error: `Session 目录不存在: ${sessionId}` };
  }

  const exportDir = path.join(sessionDir, 'figma-exports');
  fs.mkdirSync(exportDir, { recursive: true });

  const manifestPath = path.join(exportDir, 'image-manifest.json');
  const manifest = {
    generated_at: new Date().toISOString(),
    image_count: downloadedImages.length,
    images: downloadedImages
  };

  try {
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
    return { success: true, manifestPath };
  } catch (err) {
    return { success: false, error: `保存图片清单失败: ${err.message}` };
  }
}

module.exports = {
  parseFigmaUrl,
  loadFigmaToken,
  exportDesign,
  saveFigmaData,
  extractImageNodes,
  saveImageManifest,
  SESSIONS_DIR,
  USER_CONFIG_PATH
};
