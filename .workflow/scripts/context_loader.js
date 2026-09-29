/**
 * 上下文加载器（Context Loader）
 *
 * 负责为每个阶段的 Agent 组装执行上下文：
 * 1. 从 resource-paths.json 解析知识库路径
 * 2. 加载知识库文件内容
 * 3. 加载前置阶段产出物
 * 4. 将上下文注入到 Agent 提示词模板的占位符中
 *
 * Requirements: 7.2, 8.2, 8.4, 4.1, 5.1
 */

const fs = require('fs');
const path = require('path');

// 项目根目录（vela-quickapp-workflow/）
const PROJECT_ROOT = path.resolve(__dirname, '../..');

// 配置文件路径
const RESOURCE_PATHS_FILE = path.resolve(__dirname, '../resource-paths.json');
const WORKFLOW_CONFIG_FILE = path.resolve(__dirname, '../workflow-config.json');

// Session 存储根目录
const SESSIONS_DIR = path.resolve(PROJECT_ROOT, '.ai-workspace/sessions');

// 有效的阶段 ID
const VALID_STAGE_IDS = ['S1', 'S2', 'S3'];

// 知识库文件内存缓存: filePath → { content, mtimeMs }
const _fileCache = new Map();

/**
 * 带缓存的文件读取
 * 根据文件 mtime 判断是否需要重新读取，避免重复加载未变更的知识库文件。
 *
 * @param {string} filePath - 文件绝对路径
 * @returns {string} 文件内容
 */
function readFileWithCache(filePath) {
  const stat = fs.statSync(filePath);
  const cached = _fileCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs) {
    return cached.content;
  }
  const content = fs.readFileSync(filePath, 'utf-8');
  _fileCache.set(filePath, { content, mtimeMs: stat.mtimeMs });
  return content;
}

/**
 * 加载 resource-paths.json 配置
 * @returns {object} 资源路径配置对象
 * @throws {Error} 配置文件不存在或格式非法
 */
/**
 * 加载 resource-paths.json 配置
 * @returns {object} 资源路径配置对象
 * @throws {Error} 配置文件不存在或格式非法（含详细诊断信息）
 */
function loadResourcePaths() {
  if (!fs.existsSync(RESOURCE_PATHS_FILE)) {
    throw new Error(`资源路径配置文件不存在: ${RESOURCE_PATHS_FILE}`);
  }
  let raw;
  try {
    raw = fs.readFileSync(RESOURCE_PATHS_FILE, 'utf-8');
  } catch (err) {
    throw new Error(`读取资源路径配置文件失败: ${err.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`资源路径配置文件 JSON 格式错误: ${err.message}（文件: ${RESOURCE_PATHS_FILE}）`);
  }
}

/**
 * 加载 workflow-config.json 配置
 * @returns {object} 工作流配置对象
 * @throws {Error} 配置文件不存在或格式非法
 */
/**
 * 加载 workflow-config.json 配置
 * @returns {object} 工作流配置对象
 * @throws {Error} 配置文件不存在或格式非法（含详细诊断信息）
 */
function loadWorkflowConfig() {
  if (!fs.existsSync(WORKFLOW_CONFIG_FILE)) {
    throw new Error(`工作流配置文件不存在: ${WORKFLOW_CONFIG_FILE}`);
  }
  let raw;
  try {
    raw = fs.readFileSync(WORKFLOW_CONFIG_FILE, 'utf-8');
  } catch (err) {
    throw new Error(`读取工作流配置文件失败: ${err.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`工作流配置文件 JSON 格式错误: ${err.message}（文件: ${WORKFLOW_CONFIG_FILE}）`);
  }
}


/**
 * 加载指定知识库分类的文件内容
 *
 * 采用 INDEX 优先策略：
 * 1. 优先读取知识库目录下的 INDEX.md（由 index_file 字段指定）
 * 2. 从 INDEX.md 的文件列表表格中解析出实际存在的文件名
 * 3. 加载 INDEX.md 中列出的所有文件（排除 .gitkeep 等无关文件）
 * 4. 若 INDEX.md 不存在，回退到 key_files 列表
 *
 * @param {string} knowledgeKey - 知识库分类键（如 "vela/dev-paradigm"）
 * @param {object} knowledgeMappings - resource-paths.json 中的 knowledge_mappings
 * @returns {{ key: string, files: Array<{ name: string, content: string }>, indexContent: string|null, warnings: string[] }}
 */
function loadKnowledgeFiles(knowledgeKey, knowledgeMappings) {
  const warnings = [];
  const files = [];
  let indexContent = null;

  const mapping = knowledgeMappings[knowledgeKey];
  if (!mapping) {
    warnings.push(`知识库映射未找到: ${knowledgeKey}`);
    return { key: knowledgeKey, files, indexContent, warnings };
  }

  const knowledgeDir = path.resolve(PROJECT_ROOT, mapping.path);
  if (!fs.existsSync(knowledgeDir)) {
    warnings.push(`知识库目录不存在: ${mapping.path}`);
    return { key: knowledgeKey, files, indexContent, warnings };
  }

  // INDEX 优先策略：尝试读取 INDEX.md
  const indexFileName = mapping.index_file || 'INDEX.md';
  const indexPath = path.join(knowledgeDir, indexFileName);
  let fileList = null;

  if (fs.existsSync(indexPath)) {
    try {
      indexContent = readFileWithCache(indexPath);
      // 从 INDEX.md 表格中解析文件列表
      // 表格格式: | 文件名 | 路径 | 大小 |
      fileList = parseIndexFileList(indexContent);
    } catch (err) {
      warnings.push(`读取知识库索引文件失败: ${mapping.path}/${indexFileName} - ${err.message}`);
    }
  } else {
    warnings.push(`知识库索引文件不存在: ${mapping.path}/${indexFileName}，回退到 key_files`);
  }

  // 确定要加载的文件列表
  const filesToLoad = fileList || (mapping.key_files || []);

  for (const fileName of filesToLoad) {
    const filePath = path.join(knowledgeDir, fileName);
    if (!fs.existsSync(filePath)) {
      warnings.push(`知识库文件缺失: ${mapping.path}/${fileName}`);
      continue;
    }
    try {
      const content = readFileWithCache(filePath);
      files.push({ name: fileName, content });
    } catch (err) {
      warnings.push(`读取知识库文件失败: ${mapping.path}/${fileName} - ${err.message}`);
    }
  }

  return { key: knowledgeKey, files, indexContent, warnings };
}

/**
 * 从 INDEX.md 内容中解析文件列表
 *
 * 解析 INDEX.md 中的所有 Markdown 表格，提取 .md 文件名列表。
 * 支持多种表格格式：
 * - | 文件名 | 路径 | 大小 |（dev-paradigm、api-reference 格式，取第一列或第二列）
 * - | 文件名 | 描述 |（components 格式，取第一列）
 * - | 目录/文件 | 说明 |（examples 格式，取第一列中的 .md 文件）
 * 支持同一 INDEX.md 中包含多个表格（如 components 按类别分组）。
 * 自动排除 .gitkeep、INDEX.md 等非内容文件。
 *
 * @param {string} indexContent - INDEX.md 文件内容
 * @returns {string[]|null} 文件名数组，解析失败返回 null
 */
function parseIndexFileList(indexContent) {
  if (!indexContent) return null;

  const lines = indexContent.split('\n');
  const fileNames = [];
  const seenFiles = new Set();
  // 跳过的非内容文件
  const skipFiles = new Set(['.gitkeep', 'INDEX.md']);

  let inTable = false;
  let headerPassed = false;

  for (const line of lines) {
    const trimmed = line.trim();
    // 检测表格行（以 | 开头和结尾）
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      // 跳过分隔行（如 |--------|------|------|）
      if (trimmed.replace(/[\|\s\-:]/g, '') === '') {
        headerPassed = true;
        continue;
      }
      // 跳过表头行（每个新表格的第一行）
      if (!inTable) {
        inTable = true;
        continue;
      }
      if (!headerPassed) continue;

      // 解析数据行，从各列中查找 .md 文件名
      const cells = trimmed.split('|').map(c => c.trim()).filter(c => c !== '');
      if (cells.length >= 1) {
        // 优先检查第一列是否为 .md 文件名（适用于大多数格式）
        let fileName = null;
        if (cells[0] && cells[0].endsWith('.md')) {
          fileName = cells[0];
        } else if (cells.length >= 2 && cells[1] && cells[1].endsWith('.md')) {
          // 回退到第二列（兼容旧格式：| 名称 | 路径.md | 大小 |）
          fileName = cells[1];
        }

        if (fileName && !skipFiles.has(fileName) && !seenFiles.has(fileName)) {
          seenFiles.add(fileName);
          fileNames.push(fileName);
        }
      }
    } else {
      // 非表格行，重置表格状态以支持解析下一个表格
      inTable = false;
      headerPassed = false;
    }
  }

  return fileNames.length > 0 ? fileNames : null;
}

/**
 * 加载前置阶段的产出物内容
 *
 * 根据 workflow-config.json 中的 prerequisites 和 inputs 配置，
 * 从 session 目录中读取前置阶段的产出物文件。
 *
 * @param {string} stageId - 当前阶段 ID（如 "S2"）
 * @param {object} session - Session 数据对象
 * @returns {{ outputs: Array<{ stage: string, file: string, content: string }>, warnings: string[] }}
 */
function loadPrerequisiteOutputs(stageId, session) {
  const warnings = [];
  const outputs = [];

  const workflowConfig = loadWorkflowConfig();
  const stageConfig = workflowConfig.stages[stageId];
  if (!stageConfig) {
    warnings.push(`阶段配置未找到: ${stageId}`);
    return { outputs, warnings };
  }

  const prerequisites = stageConfig.prerequisites || [];
  if (prerequisites.length === 0) {
    return { outputs, warnings };
  }

  const sessionDir = path.join(SESSIONS_DIR, session.session_id);

  // 加载 inputs 中定义的前置产出物文件
  const inputs = stageConfig.inputs || [];
  for (const inputFile of inputs) {
    // 跳过非文件输入（如 figma_export, requirement_description）
    if (!inputFile.endsWith('.md')) {
      continue;
    }

    const filePath = path.join(sessionDir, inputFile);
    if (!fs.existsSync(filePath)) {
      warnings.push(`前置产出物缺失: ${inputFile}`);
      continue;
    }

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      // 确定该文件属于哪个前置阶段
      const sourceStage = findStageByOutput(inputFile, workflowConfig);
      outputs.push({
        stage: sourceStage || 'unknown',
        file: inputFile,
        content
      });
    } catch (err) {
      warnings.push(`读取前置产出物失败: ${inputFile} - ${err.message}`);
    }
  }

  return { outputs, warnings };
}

/**
 * 根据产出物文件名查找对应的阶段 ID
 *
 * @param {string} outputFile - 产出物文件名（如 "01-prd.md"）
 * @param {object} workflowConfig - 工作流配置对象
 * @returns {string|null} 阶段 ID 或 null
 */
function findStageByOutput(outputFile, workflowConfig) {
  for (const [stageId, config] of Object.entries(workflowConfig.stages)) {
    if (config.output_template === outputFile) {
      return stageId;
    }
  }
  return null;
}


/**
 * 加载 Figma 导出数据
 *
 * 从 session 目录下的 figma-exports/ 子目录读取导出的 JSON 数据。
 *
 * @param {object} session - Session 数据对象
 * @returns {{ data: string, warnings: string[] }}
 */
/**
 * 加载 Figma 导出数据
 *
 * 从 session 目录下的 figma-exports/ 子目录读取导出的 JSON 数据。
 * 对损坏的 JSON 文件进行容错处理，跳过无法解析的文件并记录警告。
 *
 * @param {object} session - Session 数据对象
 * @returns {{ data: string, warnings: string[] }}
 */
function loadFigmaData(session) {
  const warnings = [];
  const sessionDir = path.join(SESSIONS_DIR, session.session_id);
  const figmaDir = path.join(sessionDir, 'figma-exports');

  if (!fs.existsSync(figmaDir)) {
    return { data: '无 Figma 设计稿数据', warnings };
  }

  try {
    const files = fs.readdirSync(figmaDir).filter(f => f.endsWith('.json'));
    if (files.length === 0) {
      return { data: '无 Figma 设计稿数据', warnings };
    }

    const figmaContents = [];
    for (const file of files) {
      const filePath = path.join(figmaDir, file);
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        // 验证 JSON 合法性
        JSON.parse(content);
        figmaContents.push(`### ${file}\n\`\`\`json\n${content}\n\`\`\``);
      } catch (fileErr) {
        warnings.push(`Figma 数据文件损坏，已跳过: ${file} - ${fileErr.message}`);
      }
    }

    if (figmaContents.length === 0) {
      return { data: '无 Figma 设计稿数据（所有文件均损坏）', warnings };
    }

    // 加载图片清单（如果存在）
    const manifestPath = path.join(figmaDir, 'image-manifest.json');
    if (fs.existsSync(manifestPath)) {
      try {
        const manifestContent = fs.readFileSync(manifestPath, 'utf-8');
        const manifest = JSON.parse(manifestContent);
        if (manifest.images && manifest.images.length > 0) {
          const imageList = manifest.images.map(img =>
            `- \`${img.fileName}\` (nodeId: ${img.nodeId})`
          ).join('\n');
          figmaContents.push(`### 已下载的设计资源图片\n\n共 ${manifest.images.length} 个文件，保存在 \`figma-exports/images/\` 目录：\n\n${imageList}`);
        }
      } catch (manifestErr) {
        warnings.push(`图片清单文件损坏，已跳过: ${manifestErr.message}`);
      }
    }

    return { data: figmaContents.join('\n\n'), warnings };
  } catch (err) {
    warnings.push(`读取 Figma 数据目录失败: ${err.message}`);
    return { data: '无 Figma 设计稿数据', warnings };
  }
}

/**
 * 扫描快应用项目工程目录，分析现有项目结构
 *
 * 读取项目的 manifest.json、页面目录、组件目录等，
 * 生成项目现状摘要，供技术方案 Agent 判断增量开发策略。
 *
 * @param {object} session - Session 数据对象（需包含 inputs.project_path）
 * @returns {{ data: string, isExistingProject: boolean, isEmptyProject?: boolean, warnings: string[] }}
 */
function scanProjectStructure(session) {
  const warnings = [];
  const projectPath = session && session.inputs && session.inputs.project_path;

  if (!projectPath) {
    return { data: '未指定项目工程路径（将作为全新项目处理）', isExistingProject: false, warnings };
  }

  const resolvedPath = path.resolve(PROJECT_ROOT, projectPath);
  if (!fs.existsSync(resolvedPath)) {
    return { data: `项目工程路径不存在: ${projectPath}（将作为全新项目处理）`, isExistingProject: false, warnings };
  }

  // 检查目录是否为空（仅含 .gitkeep 等隐藏文件也视为空）
  try {
    const entries = fs.readdirSync(resolvedPath).filter(f => !f.startsWith('.'));
    if (entries.length === 0) {
      return {
        data: `## 项目工程现状分析\n\n**项目路径**: \`${projectPath}\`\n**状态**: ⚠️ 空目录\n\n该目录存在但为空，尚未初始化快应用工程。研发阶段（S3）开始前，需先提示开发者执行以下命令初始化项目：\n\n\`\`\`bash\nnpm create aiot\n\`\`\`\n\n初始化完成后再进行编码实现。`,
        isExistingProject: false,
        isEmptyProject: true,
        warnings
      };
    }
  } catch (err) {
    warnings.push(`读取项目目录失败: ${err.message}`);
  }

  // 检查 src 目录（快应用标准结构）
  const srcDir = path.join(resolvedPath, 'src');
  const hasSrc = fs.existsSync(srcDir);

  // 读取 manifest.json
  let manifest = null;
  const manifestPath = hasSrc
    ? path.join(srcDir, 'manifest.json')
    : path.join(resolvedPath, 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    } catch (err) {
      warnings.push(`manifest.json 解析失败: ${err.message}`);
    }
  }

  // 如果没有 manifest.json，可能是目录有文件但未初始化快应用工程
  if (!manifest) {
    return {
      data: `## 项目工程现状分析\n\n**项目路径**: \`${projectPath}\`\n**状态**: ⚠️ 非快应用工程（无 manifest.json）\n\n该目录存在但未包含有效的快应用工程结构（缺少 manifest.json）。研发阶段（S3）开始前，需先提示开发者在该目录下执行以下命令初始化项目：\n\n\`\`\`bash\nnpm create aiot\n\`\`\`\n\n初始化完成后再进行编码实现。`,
      isExistingProject: false,
      isEmptyProject: true,
      warnings
    };
  }

  // ---- 以下为已有项目分析 ----
  const sections = [];
  sections.push(`## 项目工程现状分析\n`);
  sections.push(`**项目路径**: \`${projectPath}\``);
  sections.push(`**包名**: \`${manifest.package || '未定义'}\``);
  sections.push(`**应用名称**: \`${manifest.name || '未定义'}\``);
  sections.push(`**版本**: ${manifest.versionName || '?'} (code: ${manifest.versionCode || '?'})`);
  sections.push(`**目标设备**: ${(manifest.deviceTypeList || []).join(', ') || '未定义'}`);

  // 分析 features（系统 API 依赖）
  if (manifest.features && manifest.features.length > 0) {
    const featureNames = manifest.features.map(f => f.name);
    sections.push(`\n### 已声明的系统 API (features)\n`);
    sections.push(featureNames.map(f => `- \`${f}\``).join('\n'));
  }

  // 分析路由和页面
  if (manifest.router && manifest.router.pages) {
    const pages = manifest.router.pages;
    const pageRoutes = Object.keys(pages);
    sections.push(`\n### 已有页面列表（共 ${pageRoutes.length} 个）\n`);
    sections.push(`| 路由路径 | 组件名 | 启动模式 |`);
    sections.push(`|---------|--------|---------|`);
    for (const route of pageRoutes) {
      const cfg = pages[route];
      sections.push(`| \`${route}\` | ${cfg.component || '-'} | ${cfg.launchMode || 'standard'} |`);
    }
    sections.push(`\n**入口页面**: \`${manifest.router.entry || '未定义'}\``);
  }

  // 扫描页面目录，获取每个页面的文件列表
  const baseDir = hasSrc ? srcDir : resolvedPath;
  const pagesDir = path.join(baseDir, 'pages');
  if (fs.existsSync(pagesDir)) {
    try {
      const pageFolders = fs.readdirSync(pagesDir).filter(f => {
        return fs.statSync(path.join(pagesDir, f)).isDirectory();
      });
      if (pageFolders.length > 0) {
        sections.push(`\n### 页面目录文件结构\n`);
        for (const folder of pageFolders) {
          const folderPath = path.join(pagesDir, folder);
          const files = fs.readdirSync(folderPath).filter(f => {
            return fs.statSync(path.join(folderPath, f)).isFile();
          });
          sections.push(`- \`pages/${folder}/\`: ${files.map(f => `\`${f}\``).join(', ')}`);
        }
      }
    } catch (err) {
      warnings.push(`扫描页面目录失败: ${err.message}`);
    }
  }

  // 扫描组件目录
  const componentsDir = path.join(baseDir, 'components');
  if (fs.existsSync(componentsDir)) {
    try {
      const compFolders = fs.readdirSync(componentsDir).filter(f => {
        return fs.statSync(path.join(componentsDir, f)).isDirectory();
      });
      if (compFolders.length > 0) {
        sections.push(`\n### 已有自定义组件（共 ${compFolders.length} 个）\n`);
        for (const folder of compFolders) {
          const folderPath = path.join(componentsDir, folder);
          const files = fs.readdirSync(folderPath).filter(f => {
            return fs.statSync(path.join(folderPath, f)).isFile();
          });
          sections.push(`- \`components/${folder}/\`: ${files.map(f => `\`${f}\``).join(', ')}`);
        }
      }
    } catch (err) {
      warnings.push(`扫描组件目录失败: ${err.message}`);
    }
  }

  // 扫描 common 目录
  const commonDir = path.join(baseDir, 'common');
  if (fs.existsSync(commonDir)) {
    try {
      const commonFiles = fs.readdirSync(commonDir).filter(f => {
        return fs.statSync(path.join(commonDir, f)).isFile();
      });
      if (commonFiles.length > 0) {
        sections.push(`\n### 公共资源 (common/)\n`);
        sections.push(commonFiles.map(f => `- \`${f}\``).join('\n'));
      }
    } catch (err) {
      warnings.push(`扫描 common 目录失败: ${err.message}`);
    }
  }

  // 扫描 i18n 目录
  const i18nDir = path.join(baseDir, 'i18n');
  if (fs.existsSync(i18nDir)) {
    try {
      const i18nFiles = fs.readdirSync(i18nDir).filter(f => f.endsWith('.json'));
      if (i18nFiles.length > 0) {
        sections.push(`\n### 国际化资源 (i18n/)\n`);
        sections.push(i18nFiles.map(f => `- \`${f}\``).join('\n'));
      }
    } catch (err) {
      warnings.push(`扫描 i18n 目录失败: ${err.message}`);
    }
  }

  // 检查 app.ux / app.js
  for (const appFile of ['app.ux', 'app.js']) {
    const appPath = path.join(baseDir, appFile);
    if (fs.existsSync(appPath)) {
      sections.push(`\n**应用入口文件**: \`${appFile}\``);
      break;
    }
  }

  // 检查 config 相关
  if (manifest.config) {
    sections.push(`\n### 应用配置 (config)\n`);
    sections.push('```json\n' + JSON.stringify(manifest.config, null, 2) + '\n```');
  }

  // 检查 package.json
  const pkgPath = path.join(resolvedPath, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      const deps = Object.keys(pkg.dependencies || {});
      const devDeps = Object.keys(pkg.devDependencies || {});
      if (deps.length > 0 || devDeps.length > 0) {
        sections.push(`\n### 项目依赖\n`);
        if (deps.length > 0) sections.push(`**dependencies**: ${deps.map(d => `\`${d}\``).join(', ')}`);
        if (devDeps.length > 0) sections.push(`**devDependencies**: ${devDeps.map(d => `\`${d}\``).join(', ')}`);
      }
    } catch (err) {
      warnings.push(`package.json 解析失败: ${err.message}`);
    }
  }

  return { data: sections.join('\n'), isExistingProject: true, warnings };
}

/**
 * 加载阶段上下文
 *
 * 为指定阶段组装完整的执行上下文，包括：
 * 1. 知识库文件内容（根据 stage_knowledge 映射）
 * 2. 前置阶段产出物
 * 3. Figma 设计稿数据
 * 4. Session 信息
 * 5. 项目工程现状（S2/S3 阶段，若指定了 project_path）
 *
 * @param {string} stageId - 阶段 ID（"S1" | "S2" | "S3"）
 * @param {object} session - Session 数据对象
 * @returns {{ success: boolean, context?: object, error?: string, warnings?: string[] }}
 */
function loadStageContext(stageId, session) {
  // 参数校验
  if (!VALID_STAGE_IDS.includes(stageId)) {
    return { success: false, error: `无效的阶段 ID: ${stageId}，应为 S1/S2/S3` };
  }
  if (!session || !session.session_id) {
    return { success: false, error: 'Session 数据无效' };
  }

  const allWarnings = [];

  try {
    // 1. 加载资源路径配置
    const resourcePaths = loadResourcePaths();

    // 2. 加载知识（SKILL.md 优先 + 按需加载知识库）
    const stageKnowledge = resourcePaths.stage_knowledge[stageId] || [];
    const knowledgeResults = [];
    let skillContent = null;

    // 2a. 加载 SKILL.md（核心知识源）
    const skillFilePath = resourcePaths.paths.skill_file
      ? path.resolve(PROJECT_ROOT, resourcePaths.paths.skill_file)
      : null;
    if (skillFilePath && fs.existsSync(skillFilePath)) {
      try {
        skillContent = readFileWithCache(skillFilePath);
        knowledgeResults.push({
          key: 'skill',
          files: [{ name: 'SKILL.md', content: skillContent }],
          indexContent: null,
          warnings: []
        });
      } catch (err) {
        allWarnings.push(`读取 SKILL.md 失败: ${err.message}`);
      }
    } else if (skillFilePath) {
      allWarnings.push(`SKILL.md 文件不存在: ${resourcePaths.paths.skill_file}，回退到传统知识库加载`);
    }

    // 2b. 加载额外的知识库（如 examples，仅在 stage_knowledge 中显式配置的非 skill 项）
    for (const knowledgeKey of stageKnowledge) {
      if (knowledgeKey === 'skill') continue; // 已在 2a 中加载
      const result = loadKnowledgeFiles(knowledgeKey, resourcePaths.knowledge_mappings);
      knowledgeResults.push(result);
      allWarnings.push(...result.warnings);
    }

    // 格式化知识库内容
    const knowledgeContent = formatKnowledgeContent(knowledgeResults);

    // 3. 加载前置阶段产出物
    const prereqResult = loadPrerequisiteOutputs(stageId, session);
    allWarnings.push(...prereqResult.warnings);
    const previousOutputs = formatPreviousOutputs(prereqResult.outputs);

    // 4. 加载 Figma 数据
    const figmaResult = loadFigmaData(session);
    allWarnings.push(...figmaResult.warnings);

    // 5. 扫描项目工程现状（S2/S3 阶段，若指定了 project_path）
    let projectAnalysis = null;
    let isExistingProject = false;
    let isEmptyProject = false;
    if ((stageId === 'S2' || stageId === 'S3') && session.inputs && session.inputs.project_path) {
      const scanResult = scanProjectStructure(session);
      projectAnalysis = scanResult.data;
      isExistingProject = scanResult.isExistingProject;
      isEmptyProject = scanResult.isEmptyProject || false;
      allWarnings.push(...scanResult.warnings);
    }

    // 6. 组装上下文对象
    const context = {
      stageId,
      session,
      knowledgeContent,
      knowledgeResults,
      previousOutputs,
      prerequisiteOutputs: prereqResult.outputs,
      figmaData: figmaResult.data,
      projectAnalysis: projectAnalysis || '未指定项目工程路径（全新项目）',
      isExistingProject,
      isEmptyProject,
      stageKnowledgeKeys: stageKnowledge
    };

    return { success: true, context, warnings: allWarnings };
  } catch (err) {
    return { success: false, error: `加载阶段上下文失败: ${err.message}` };
  }
}

/**
 * 格式化知识库内容为可注入的字符串
 *
 * @param {Array} knowledgeResults - loadKnowledgeFiles 的结果数组
 * @returns {string} 格式化后的知识库内容
 */
function formatKnowledgeContent(knowledgeResults) {
  if (!knowledgeResults || knowledgeResults.length === 0) {
    return '无知识库内容';
  }

  const sections = [];
  for (const result of knowledgeResults) {
    if (result.files.length === 0) continue;

    const fileContents = result.files
      .map(f => `#### ${f.name}\n${f.content}`)
      .join('\n\n');
    sections.push(`### ${result.key}\n\n${fileContents}`);
  }

  return sections.length > 0 ? sections.join('\n\n---\n\n') : '无知识库内容';
}

/**
 * 格式化前置产出物为可注入的字符串
 *
 * @param {Array} outputs - loadPrerequisiteOutputs 的结果数组
 * @returns {string} 格式化后的前置产出物内容
 */
function formatPreviousOutputs(outputs) {
  if (!outputs || outputs.length === 0) {
    return '无前置产出';
  }

  return outputs
    .map(o => `### ${o.file}（来自阶段 ${o.stage}）\n\n${o.content}`)
    .join('\n\n---\n\n');
}


/**
 * 注入上下文到 Agent 提示词模板
 *
 * 替换提示词模板中的所有占位符：
 * - {session.requirement_name} → 需求名称
 * - {knowledge_content} → 知识库内容
 * - {previous_outputs} → 前置产出物
 * - {figma_data} → Figma 设计稿数据
 *
 * 同时支持 session 对象中的其他字段占位符（如 {session.session_id}）。
 *
 * @param {string} agentPrompt - Agent 提示词模板字符串
 * @param {object} context - loadStageContext 返回的上下文对象
 * @returns {string} 替换占位符后的提示词字符串
 */
function injectContext(agentPrompt, context) {
  if (!agentPrompt || typeof agentPrompt !== 'string') {
    return agentPrompt || '';
  }
  if (!context) {
    return agentPrompt;
  }

  let result = agentPrompt;

  // 替换 session 相关占位符
  if (context.session) {
    // 替换 {session.xxx} 格式的占位符
    result = result.replace(/\{session\.(\w+)\}/g, (match, field) => {
      const value = context.session[field];
      if (value !== undefined && value !== null) {
        return String(value);
      }
      return match;
    });
  }

  // 替换知识库内容占位符
  if (context.knowledgeContent !== undefined) {
    result = result.replace(/\{knowledge_content\}/g, context.knowledgeContent);
  }

  // 替换前置产出物占位符
  if (context.previousOutputs !== undefined) {
    result = result.replace(/\{previous_outputs\}/g, context.previousOutputs);
  }

  // 替换 Figma 数据占位符
  if (context.figmaData !== undefined) {
    result = result.replace(/\{figma_data\}/g, context.figmaData);
  }

  // 替换屏幕适配规格占位符
  if (context.session && context.session.inputs && context.session.inputs.screen_spec) {
    const spec = context.session.inputs.screen_spec;
    const shapeMap = { round: '圆屏', oval: '跑道屏', square: '方屏' };
    const shapeLabel = shapeMap[spec.shape] || spec.shape || '未指定';
    const screenSpecStr = `${spec.width || '?'}×${spec.height || '?'} 像素，屏幕形状: ${shapeLabel}`;
    result = result.replace(/\{screen_spec\}/g, screenSpecStr);
  } else {
    result = result.replace(/\{screen_spec\}/g, '未指定屏幕适配规格');
  }

  // 替换项目工程现状占位符
  if (context.projectAnalysis !== undefined) {
    result = result.replace(/\{project_analysis\}/g, context.projectAnalysis);
  } else {
    result = result.replace(/\{project_analysis\}/g, '未指定项目工程路径（全新项目）');
  }

  // Fallback: 将所有未替换的占位符统一替换为 [未提供]，避免 Agent 看到原始占位符
  result = result.replace(/\{(?:session\.\w+|knowledge_content|previous_outputs|figma_data|screen_spec|project_analysis)\}/g, '[未提供]');

  return result;
}

// 导出所有函数
module.exports = {
  loadStageContext,
  injectContext,
  // 导出辅助函数，便于测试
  loadResourcePaths,
  loadWorkflowConfig,
  loadKnowledgeFiles,
  parseIndexFileList,
  loadPrerequisiteOutputs,
  loadFigmaData,
  scanProjectStructure,
  findStageByOutput,
  formatKnowledgeContent,
  formatPreviousOutputs,
  readFileWithCache,
  _fileCache,
  PROJECT_ROOT,
  RESOURCE_PATHS_FILE,
  WORKFLOW_CONFIG_FILE,
  SESSIONS_DIR,
  VALID_STAGE_IDS
};
