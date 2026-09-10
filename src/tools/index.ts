import type { ToolDefinition } from './registry'
import { readFileTool, writeFileTool, editFileTool, listDirectoryTool } from './file-tools'
import { globTool, grepTool } from './search-tools'
import { bashTool } from './shell-tools'
import { pickSearchTool, webFetchTool } from './web-search'
// 办公文档工具（Excel / Word / PDF）统一放在 ./office 目录，清单在 ./office/index.ts
import { officeTools } from './office'


export const allTools: ToolDefinition[] = [
  readFileTool,
  writeFileTool,
  listDirectoryTool,
  editFileTool,
  globTool,
  grepTool,
  bashTool,
  pickSearchTool(),
  webFetchTool,
  // 办公文档解析（Office 文档是二进制/压缩包，read_file 读出来是乱码）
  ...officeTools,
]


// 核心工具
export {
  readFileTool,
  writeFileTool,
  listDirectoryTool,
  editFileTool,
  globTool,
  grepTool,
  bashTool,
}

// 办公文档工具：read_excel / read_word / read_pdf
export * from './office'
