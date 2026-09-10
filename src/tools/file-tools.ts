import type { ToolDefinition } from './registry'
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { extname, join } from 'node:path'
import { WORKSPACE_DIR, ensureWorkspace, listWorkspaceEntries, resolveWorkspacePath } from '../workspace'


// 二进制/压缩包型文档：read_file 按 UTF-8 读只会得到乱码，这里直接路由到专用工具
const BINARY_DOC_ROUTES: Record<string, string> = {
  '.xlsx': 'read_excel',
  '.xlsm': 'read_excel',
  '.xlsb': 'read_excel',
  '.xls': 'read_excel',
  '.csv': 'read_excel',
  '.docx': 'read_word',
  '.docm': 'read_word',
  '.doc': 'read_word',
  '.pdf': 'read_pdf',
}

/** 相对路径未命中时的统一提示：告诉模型工作区在哪、里面有什么 */
function notFoundHint(raw: string): string {
  const entries = listWorkspaceEntries(10)
  const listing = entries.length > 0 ? `\n工作区(${WORKSPACE_DIR})当前内容:\n${entries.join('\n')}` : ''
  return `文件不存在: ${raw}（相对路径默认在工作区 ${WORKSPACE_DIR} 内查找）${listing}`
}

export const readFileTool: ToolDefinition = {
  name: 'read_file',
  description:
    '读取指定路径的文本文件内容。仅用于纯文本（代码/日志/md/json/txt）；Excel、Word、PDF 请分别用 read_excel / read_word / read_pdf。' +
    '相对路径默认在工作区目录内解析，访问项目代码请用 "./" 开头的路径（如 "./src/index.ts"）',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: '文件路径。相对路径默认相对工作区；"./xxx" 表示相对项目目录；也可用绝对路径',
      }
    },
    required: ['path'],
    additionalProperties: false
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  maxResultChars: 500,
  execute: async ({ path }: { path: string }) => {
    const resolved = resolveWorkspacePath(path).path
    const ext = extname(resolved).toLowerCase()
    const route = BINARY_DOC_ROUTES[ext]
    if (route) {
      if (ext === '.doc') {
        return `[工具路由提示] "${path}" 是旧版二进制 .doc 格式，当前工具链无法解析。请先用 Word / WPS 另存为 .docx，再用 read_word 读取。`
      }
      return `[工具路由提示] "${path}" 是 ${ext} 格式的二进制文档，用 read_file 读取只会得到乱码。请改用 ${route} 工具（如 ${route}({ "path": "${path}", "mode": "overview" })）`
    }
    if (!existsSync(resolved)) return notFoundHint(path)
    return readFileSync(resolved, 'utf-8')
  },
}

export const writeFileTool: ToolDefinition = {
  name: 'write_file',
  description:
    '写入内容到指定文件（全量覆写）。相对路径默认写入工作区；修改已有项目文件时用 "./" 开头的路径（如 "./src/index.ts"）',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: '文件路径。相对路径默认相对工作区；"./xxx" 表示相对项目目录；也可用绝对路径',
      },
      content: {
        type: 'string',
        description: '要写入的内容',
      }
    },
    required: ['path', 'content'],
    additionalProperties: false
  },
  isConcurrencySafe: false,  // 写入操作不能并发
  isReadOnly: false,
  execute: async ({ path, content }: { path: string, content: string }) => {
    const resolved = resolveWorkspacePath(path).path
    writeFileSync(resolved, content, 'utf-8')
    return `已写入 ${content.length} 个字符到 ${resolved}`
  }
}

export const listDirectoryTool: ToolDefinition = {
  name: 'list_directory',
  description:
    '列出目录下的文件和子目录。不传 path 时列出工作区（用户办公文档所在目录）；列项目代码传 "./"',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '目录路径。省略=工作区；"." 或 "./"=项目根目录；也可用绝对路径' },
    },
    required: [],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  execute: async ({ path }: { path?: string } = {}) => {
    const resolved = path === undefined || path.trim() === '' ? ensureWorkspace() : resolveWorkspacePath(path).path
    if (!existsSync(resolved)) return notFoundHint(path ?? WORKSPACE_DIR)

    const entries = readdirSync(resolved);
    if (entries.length === 0) return `${resolved} 是空目录`
    return entries.map(name => {
      try {
        const stat = statSync(join(resolved, name));
        const size = stat.isDirectory() ? '' : `  ${Math.max(1, Math.round(stat.size / 1024))} KB`;
        return `${stat.isDirectory() ? '[DIR]' : '[FILE]'} ${name}${size}`;
      } catch {
        return `[?] ${name}`;
      }
    }).join('\n');
  },
};

// 编辑文件
export const editFileTool: ToolDefinition = {
  name: 'edit_file',
  description: '精确替换文件中的制定内容，用 old_string 定位要替换的文本，用 new_string 替换它。不是全量覆写，只改你指定的部分（相对路径默认在工作区，项目文件用 "./" 开头）',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: '文件路径。相对路径默认相对工作区；"./xxx" 表示相对项目目录；也可用绝对路径',
      },
      old_string: {
        type: 'string',
        description: '要被替换的原始文本（必须精确匹配）',
      },
      new_string: {
        type: 'string',
        description: '替换后的新文本',
      }
    },
    required: ['path', 'old_string', 'new_string'],
    additionalProperties: false
  },
  isConcurrencySafe: false,  // 编辑操作不能并发
  isReadOnly: false,
  execute: async ({ path, old_string, new_string }: { path: string, old_string: string, new_string: string }) => {
    const resolved = resolveWorkspacePath(path).path;
    if (!existsSync(resolved)) return notFoundHint(path)

    const content = readFileSync(resolved, 'utf-8')
    const count = content.split(old_string).length - 1

    if (count === 0) {
      return `未找到匹配的内容。请检查 old_string 是否与文件中的文本完全一致（包括空格和换行）`;
    }

    if (count > 1) {
      return `找到 ${count} 处匹配，请提供更多上下文让 old_string 唯一`;
    }

    const updated = content.replace(old_string, new_string);
    writeFileSync(resolved, updated, 'utf-8')
    return `已替换 ${path} 中的内容（${old_string} ➡️  ${new_string} 字符）`

  }
}
