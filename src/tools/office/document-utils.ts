/**
 * 文档解析共享层
 *
 * 职责（被 excel / word / pdf 三个工具复用）：
 *   1. 路径防御：工作区锚定 + existsSync + 文件类型白名单 + 体积限制
 *   2. 脏值净化：null / undefined / number / Date / 公式 → 统一 trim 后的字符串
 *   3. 表头识别：跳过空行与大标题合并行，自动定位有效表头行
 *   4. Token 保护：分页（offset/limit）、单元格截断、整体字符预算
 *   5. HTML 块解析：把 mammoth 输出的 HTML 还原成有结构的文档块（段落/标题/表格）
 *   6. Markdown 渲染：表格与单元格的安全转义
 */

import { existsSync, statSync } from 'node:fs'
import { extname } from 'node:path'
import { WORKSPACE_DIR, resolveWorkspacePath } from '../../workspace'

/** 统一的失败返回结构：永不抛到进程外，永远可 JSON 序列化 */
export interface ToolFailure {
  success: false
  error: string
  hint?: string
}

export function fail(error: string, hint?: string): ToolFailure {
  return hint ? { success: false, error, hint } : { success: false, error }
}

/** 业务级异常：在 execute 内部抛出，由 wrapExecute 统一兜底成 ToolFailure */
export class DocumentError extends Error {
  hint?: string
  constructor(message: string, hint?: string) {
    super(message)
    this.name = 'DocumentError'
    this.hint = hint
  }
}

/**
 * 工具执行包装器：统一 try-catch + 具名错误信息，保证工具不会让 Agent 进程崩溃
 */
export function wrapExecute<I, O>(fn: (input: I) => Promise<O> | O) {
  return async (input: I): Promise<O | ToolFailure> => {
    try {
      return await fn(input)
    } catch (err) {
      if (err instanceof DocumentError) return fail(err.message, err.hint)
      const message = err instanceof Error ? err.message : String(err)
      return fail(`工具执行失败: ${message}`)
    }
  }
}

/** 解析并校验路径：必须是存在的、体积可接受的、扩展名在白名单内的文件 */
export function resolveExistingFile(
  filePath: unknown,
  allowedExts: string[],
  maxBytes = 60 * 1024 * 1024,
): { resolved: string; ext: string; sizeBytes: number; mtimeMs: number; pathNote?: string } {
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    throw new DocumentError('path 参数不能为空，需要提供文件的相对或绝对路径')
  }
  // 相对路径锚定到工作区（找不到再退回项目目录），保证换启动目录也能读到文件
  const target = resolveWorkspacePath(filePath.trim())
  const resolved = target.path
  if (!existsSync(resolved)) {
    throw new DocumentError(
      `文件不存在: ${resolved}`,
      `相对路径默认在工作区(${WORKSPACE_DIR})内查找；可用 list_directory 查看工作区里有哪些文件，或用 "./" 开头的路径访问项目目录`,
    )
  }
  let stat
  try {
    stat = statSync(resolved)
  } catch (err) {
    throw new DocumentError(`无法读取文件状态: ${resolved} (${err instanceof Error ? err.message : err})`)
  }
  if (!stat.isFile()) throw new DocumentError(`路径不是文件而是目录: ${resolved}`)

  const ext = extname(resolved).toLowerCase()
  if (allowedExts.length > 0 && !allowedExts.includes(ext)) {
    throw new DocumentError(
      `不支持的文件类型 "${ext || '(无扩展名)'}"，本工具仅支持: ${allowedExts.join(', ')}`,
    )
  }
  if (stat.size > maxBytes) {
    throw new DocumentError(
      `文件过大 (${(stat.size / 1024 / 1024).toFixed(1)}MB)，超过 ${(maxBytes / 1024 / 1024).toFixed(0)}MB 上限`,
      '请先拆分文件，或改用 bash 工具做流式处理',
    )
  }
  return { resolved, ext, sizeBytes: stat.size, mtimeMs: stat.mtimeMs, pathNote: target.note }
}

/** 把任意输入钳制为安全整数 */
export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  const i = Math.trunc(n)
  if (i < min) return min
  if (i > max) return max
  return i
}

/** 字符串截断（用于单元格级 Token 保护） */
export function truncateText(text: string, maxChars: number): string {
  if (maxChars <= 0 || text.length <= maxChars) return text
  return text.slice(0, maxChars) + `…(+${text.length - maxChars}字)`
}

/** 整体字符预算裁剪：超出时保留头部并给出明确提示，不静默丢数据 */
export function budgetChars(text: string, maxChars: number, label = '内容'): string {
  if (text.length <= maxChars) return text
  return (
    text.slice(0, maxChars) +
    `\n\n... [${label}超出字符预算，已截断 ${text.length - maxChars} 个字符，请用 offset/limit 分页或缩小 columns 范围]`
  )
}

// ---------------------------------------------------------------------------
// 单元格净化
// ---------------------------------------------------------------------------

const DATE_PAD = (n: number) => String(n).padStart(2, '0')

/** Date → "YYYY-MM-DD"（含非零时分秒时补 " HH:mm:ss"） */
export function formatDate(d: Date): string {
  if (Number.isNaN(d.getTime())) return ''
  const date = `${d.getFullYear()}-${DATE_PAD(d.getMonth() + 1)}-${DATE_PAD(d.getDate())}`
  const h = d.getHours()
  const m = d.getMinutes()
  const s = d.getSeconds()
  if (h === 0 && m === 0 && s === 0) return date
  return `${date} ${DATE_PAD(h)}:${DATE_PAD(m)}:${DATE_PAD(s)}`
}

/**
 * 单元格 → 干净字符串
 * 兼容：null / undefined / 数字（含科学计数显示）/ 日期对象 / 布尔 / 错误值 / 公式单元格
 */
export function normalizeCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) return formatDate(value)
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : String(value)
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE'
  if (typeof value === 'bigint') return value.toString()
  try {
    return String(value).trim()
  } catch {
    return ''
  }
}

/** HTML 实体解码（mammoth 输出会转义 & < > "） */
export function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
}

/** 内联文本归一化：解码实体、压缩空白、去首尾 */
export function normalizeInline(text: string): string {
  return decodeEntities(text)
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim()
}

// ---------------------------------------------------------------------------
// 表头动态识别
// ---------------------------------------------------------------------------

export interface HeaderScanResult {
  /** 表头行在矩阵中的 0-based 行下标 */
  headerRowIndex: number
  /** 表头块所占行数（支持多行表头，如"语文 / 期中"） */
  headerRowCount: number
  /** 首个数据行下标 */
  dataStartIndex: number
  /** 命中分数（用于调试与可解释性） */
  score: number
  /** 被跳过的前置行（空行 / 大标题行），便于向用户解释 */
  skippedRows: number[]
}

function isNumericLike(text: string): boolean {
  return /^[-+]?\d+(\.\d+)?%?$/.test(text.replace(/,/g, ''))
}

/**
 * 单行作为"表头"的可信得分
 * 越高越像表头：非空格子多、取值互不重复、文本短、不像数字；且下一行结构与它对齐
 */
function headerScore(matrix: string[][], r: number): number {
  const row = matrix[r] ?? []
  const filled = row.filter((v) => v !== '')
  if (filled.length === 0) return -1

  const unique = new Set(filled).size
  const avgLen = filled.reduce((sum, v) => sum + v.length, 0) / filled.length
  const numericCount = filled.filter(isNumericLike).length

  let score = filled.length * 2 + unique * 2
  if (filled.length === 1) score -= 8 // 单格：大标题 / 说明行
  if (avgLen > 16) score -= 5 // 长文本：更像说明段落
  score -= numericCount * 3 // 纯数字列（学号、分数）不像表头
  if (unique < filled.length) score -= 4 // 表头一般不会自我重复

  const next = matrix[r + 1]
  if (next) {
    const nextFilled = next.filter((v) => v !== '').length
    if (nextFilled > 0 && Math.abs(nextFilled - filled.length) <= Math.max(2, filled.length * 0.5)) {
      score += 5 // 与下一行的数据密度对齐 → 典型表头特征
    }
  }
  return score
}

/** 一行是否像"表头文字行"：非空、至少两格、取值短、不含纯数字 */
function isHeaderTextRow(matrix: string[][], r: number): boolean {
  const row = matrix[r]
  if (!row) return false
  const filled = row.filter((v) => v !== '')
  if (filled.length < 2) return false
  if (filled.some((v) => isNumericLike(v))) return false
  return filled.every((v) => v.length <= 12)
}

/**
 * "横向合并指纹"：一行中出现重复取值（合并单元格向右填充后必然产生），
 * 这是"分组表头"独有的特征——数据行极少在同一行内自我重复。
 */
function hasMergeFingerprint(matrix: string[][], r: number): boolean {
  const row = matrix[r] ?? []
  const filled = row.filter((v) => v !== '')
  return filled.length > new Set(filled).size
}

function filledCount(matrix: string[][], r: number): number {
  return (matrix[r] ?? []).filter((v) => v !== '').length
}

/**
 * 自动定位有效表头行：
 *   1. 扫描前 maxScanRows 行，取"最像表头"的一行作为锚点（跳过空行、大标题合并行）
 *   2. 以合并指纹为依据，向上/向下扩展到最多 3 行，还原复合表头（如 语文 / 期中）
 */
export function detectHeader(matrix: string[][], maxScanRows = 15): HeaderScanResult {
  const skippedRows: number[] = []
  const limit = Math.min(matrix.length, maxScanRows)

  let bestIndex = -1
  let bestScore = -Infinity
  for (let r = 0; r < limit; r++) {
    const score = headerScore(matrix, r)
    if (score > bestScore) {
      bestScore = score
      bestIndex = r
    }
  }

  // 整张表都没有可用内容
  if (bestIndex === -1) {
    return { headerRowIndex: 0, headerRowCount: 0, dataStartIndex: 0, score: 0, skippedRows }
  }

  const block: number[] = [bestIndex]

  // 向上扩展：父表头（列数不少于子行，且带合并指纹，避免把大标题行吞进来）
  while (block.length < 3 && block[0] > 0) {
    const parent = block[0] - 1
    if (!isHeaderTextRow(matrix, parent)) break
    if (!hasMergeFingerprint(matrix, parent)) break
    if (filledCount(matrix, parent) < filledCount(matrix, block[0])) break
    block.unshift(parent)
  }

  // 向下扩展：子表头（列数不多于父行，父行必须带合并指纹）
  while (block.length < 3 && block[block.length - 1] + 1 < matrix.length) {
    const child = block[block.length - 1] + 1
    if (!isHeaderTextRow(matrix, child)) break
    if (!hasMergeFingerprint(matrix, block[block.length - 1])) break
    if (filledCount(matrix, child) > filledCount(matrix, block[block.length - 1])) break
    block.push(child)
  }

  const headerRowIndex = block[0]
  const headerRowCount = block.length

  // 记录被跳过的前置行（用于结果里向用户解释"第1行是大标题，已跳过"）
  for (let r = 0; r < headerRowIndex; r++) {
    if ((matrix[r] ?? []).some((v) => v !== '')) skippedRows.push(r)
  }

  return {
    headerRowIndex,
    headerRowCount,
    dataStartIndex: headerRowIndex + headerRowCount,
    score: bestScore,
    skippedRows,
  }
}

/** 多行表头按列拍平："语文 / 期中"；纵向合并导致的重复值自动去重 */
export function flattenHeaderRows(headerRows: string[][], colCount: number): string[] {
  const headers: string[] = []
  for (let c = 0; c < colCount; c++) {
    const parts: string[] = []
    for (const row of headerRows) {
      const v = (row[c] ?? '').trim()
      if (v === '') continue
      if (parts[parts.length - 1] === v) continue // 纵向合并的重复值
      parts.push(v)
    }
    headers.push(parts.join(' / '))
  }
  return headers
}

/** 0-based 列下标 → Excel 列名（A、B、...、AA） */
export function columnLetter(index: number): string {
  let n = index
  let name = ''
  do {
    name = String.fromCharCode(65 + (n % 26)) + name
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return name
}

/** 表头补名与去重：空表头 → "列A"，重名 → "姓名_2" */
export function normalizeHeaders(headers: string[]): { headers: string[]; renamed: string[] } {
  const seen = new Map<string, number>()
  const renamed: string[] = []
  const result = headers.map((raw, i) => {
    let name = raw.trim()
    if (name === '') {
      name = `列${columnLetter(i)}`
      renamed.push(`第${i + 1}列 无表头 → 使用占位名 "${name}"`)
    }
    const count = seen.get(name) ?? 0
    seen.set(name, count + 1)
    if (count > 0) {
      const next = `${name}_${count + 1}`
      renamed.push(`第${i + 1}列 表头重名 "${name}" → "${next}"`)
      seen.set(next, 1)
      return next
    }
    return name
  })
  return { headers: result, renamed }
}

// ---------------------------------------------------------------------------
// 分页 / Markdown 渲染
// ---------------------------------------------------------------------------

export interface Page<T> {
  page: T[]
  total: number
  offset: number
  returned: number
  hasMore: boolean
  nextOffset: number | null
}

export function paginate<T>(items: T[], offset: number, limit: number): Page<T> {
  const total = items.length
  const start = Math.min(Math.max(offset, 0), total)
  const page = items.slice(start, start + limit)
  const hasMore = start + page.length < total
  return {
    page,
    total,
    offset: start,
    returned: page.length,
    hasMore,
    nextOffset: hasMore ? start + page.length : null,
  }
}

/** Markdown 单元格转义：管道符与换行会破坏表格结构 */
export function escapeMdCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>').trim()
}

/** 渲染 Markdown 表格（自动补齐列数不齐的行） */
export function toMarkdownTable(headers: string[], rows: string[][]): string {
  if (headers.length === 0) return '(无表头)'
  const head = `| ${headers.map(escapeMdCell).join(' | ')} |`
  const sep = `| ${headers.map(() => '---').join(' | ')} |`
  const body = rows.map((row) => {
    const cells: string[] = []
    for (let c = 0; c < headers.length; c++) cells.push(escapeMdCell(row[c] ?? ''))
    return `| ${cells.join(' | ')} |`
  })
  return [head, sep, ...body].join('\n')
}

// ---------------------------------------------------------------------------
// HTML → 文档块（专供 mammoth 输出的规整 HTML 使用）
// ---------------------------------------------------------------------------

export type DocBlockType = 'heading' | 'paragraph' | 'list-item' | 'table'

export interface DocBlock {
  /** 1-based 顺序号，供 Agent 精确引用（"第 12 段"） */
  index: number
  type: DocBlockType
  /** 标题层级：1~6，仅 heading 有值 */
  level?: number
  text: string
  /** 从属的标题路径，如 ["第三章 考试安排", "3.2 考场分配"] */
  headingPath: string[]
  /** 表格编号：仅 table 有值，从 1 开始 */
  tableIndex?: number
  /** 表格数据：仅 table 有值 */
  rows?: string[][]
}

/**
 * 线性扫描 mammoth 生成的 HTML，还原为结构化文档块。
 * mammoth 输出的 HTML 规整（标签闭合、文本已转义），因此采用轻量扫描而非引入 DOM 依赖。
 */
export function parseHtmlBlocks(html: string): DocBlock[] {
  const blocks: DocBlock[] = []
  const headingPath: string[] = []
  let inline = ''
  let headingLevel: number | null = null
  let ordered = false

  let inCell = false
  let inTable = false
  let tableRows: string[][] = []
  let row: string[] = []
  let cellText = ''
  let pendingHref: string | null = null

  const pushBlock = (type: DocBlockType) => {
    const text = normalizeInline(inline)
    inline = ''
    if (text === '') return
    if (type === 'heading') {
      const level = headingLevel ?? 1
      headingPath.length = level - 1
      headingPath[level - 1] = text
      blocks.push({ index: blocks.length + 1, type, level, text, headingPath: [...headingPath].filter(Boolean) })
    } else {
      blocks.push({ index: blocks.length + 1, type, text, headingPath: [...headingPath].filter(Boolean) })
    }
  }

  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>|([^<]+)/g
  let m: RegExpExecArray | null
  while ((m = tagRe.exec(html)) !== null) {
    const [, closing, rawTag, attrs, text] = m

    // 纯文本
    if (rawTag === undefined) {
      const decoded = decodeEntities(text)
      if (inCell) cellText += decoded
      else inline += decoded
      continue
    }

    const tag = rawTag.toLowerCase()
    const isClosing = closing === '/'

    if (tag === 'table') {
      if (!isClosing) {
        pushBlock('paragraph')
        inTable = true
        tableRows = []
      } else if (inTable) {
        if (row.length > 0) tableRows.push(row)
        if (tableRows.length > 0) {
          blocks.push({
            index: blocks.length + 1,
            type: 'table',
            text: `[表格 ${blocks.filter((b) => b.type === 'table').length + 1}] ${tableRows.length} 行 × ${tableRows[0]?.length ?? 0} 列`,
            headingPath: [...headingPath].filter(Boolean),
            tableIndex: blocks.filter((b) => b.type === 'table').length + 1,
            rows: tableRows,
          })
        }
        inTable = false
        row = []
      }
      continue
    }

    if (inTable) {
      if (tag === 'tr') {
        if (isClosing) {
          if (row.length > 0) tableRows.push(row)
          row = []
        } else {
          row = []
        }
      } else if (tag === 'td' || tag === 'th') {
        if (isClosing) {
          row.push(normalizeInline(cellText))
          cellText = ''
          inCell = false
        } else {
          inCell = true
          cellText = ''
        }
      }
      // 表格内的 <p>/<li> 等嵌套标签直接忽略，文本已并入单元格
      continue
    }

    if (tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'h4' || tag === 'h5' || tag === 'h6') {
      if (isClosing) {
        pushBlock('heading')
        headingLevel = null
      } else {
        pushBlock('paragraph')
        headingLevel = Number(tag[1])
      }
      continue
    }

    if (tag === 'p') {
      pushBlock('paragraph')
      continue
    }
    if (tag === 'li') {
      pushBlock('list-item')
      continue
    }
    if (tag === 'ul' || tag === 'ol') {
      if (!isClosing) {
        pushBlock('paragraph')
        ordered = tag === 'ol'
      }
      continue
    }
    if (tag === 'br') {
      inline += '\n'
      continue
    }
    if (tag === 'a') {
      if (isClosing) {
        if (pendingHref) {
          inline += ` (${pendingHref})`
          pendingHref = null
        }
      } else {
        const href = /href\s*=\s*["']([^"']+)["']/i.exec(attrs ?? '')
        pendingHref = href ? href[1] : null
      }
      continue
    }
    if (tag === 'img' && !isClosing) {
      inline += '[图片]'
      continue
    }
    // 其余内联标签（strong / em / span / u / sup / sub ...）不参与结构，仅保留文本
    void ordered
  }

  // 收尾：文档末尾没有闭合标签的情况
  pushBlock(headingLevel ? 'heading' : 'paragraph')
  if (inTable) {
    if (row.length > 0) tableRows.push(row)
    if (tableRows.length > 0) {
      blocks.push({
        index: blocks.length + 1,
        type: 'table',
        text: `[表格 ${blocks.filter((b) => b.type === 'table').length + 1}] ${tableRows.length} 行`,
        headingPath: [...headingPath].filter(Boolean),
        tableIndex: blocks.filter((b) => b.type === 'table').length + 1,
        rows: tableRows,
      })
    }
  }

  return blocks
}
