/**
 * 办公文档工具集（office）
 *
 * 目录职责：
 *   document-utils.ts —— 共享层：路径防御、脏值净化、表头识别、分页截断、HTML 块解析
 *   excel-tools.ts    —— read_excel：overview / preview / search
 *   word-tools.ts     —— read_word ：outline / text / tables / search
 *   pdf-tools.ts      —— read_pdf  ：info / text / search
 *
 * 对外只暴露这一个入口：新增/删除办公文档工具时，只改本文件与各自的实现文件，
 * 不必再去 src/tools/index.ts 里逐条增删（避免同一份工具清单在多处维护、逐渐不一致）。
 */

import type { ToolDefinition } from '../registry'
import { readExcelTool } from './excel-tools'
import { readWordTool } from './word-tools'
import { readPdfTool } from './pdf-tools'

/** 办公文档工具清单：工具数组与具名导出共用同一份定义，无重复清单 */
export const officeTools: ToolDefinition[] = [readExcelTool, readWordTool, readPdfTool]

export { readExcelTool, readWordTool, readPdfTool }
export * from './document-utils'
