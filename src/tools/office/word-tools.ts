/**
 * read_word —— Agent 用的 Word(.docx) 只读解析工具
 *
 * 管线：docx → mammoth(HTML) → parseHtmlBlocks(结构化块) → 按模式输出
 *
 * 为什么不用 turndown：turndown 核心规则不保留表格结构，而办公文档里"名单/成绩/安排"几乎都是表格。
 * 这里自己解析 mammoth 的规整 HTML，换来三件事：
 *   1. 表格能被还原成 Markdown 表格
 *   2. 每个段落/表格都有稳定编号（第 N 段 / 表格 K 第 R 行第 C 列），便于"依据事实"逐条引用
 *   3. 每个块都带 headingPath（所属标题链路），检索结果可读性大幅提升
 */

import mammoth from 'mammoth'
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import type { ToolDefinition } from '../registry'
import {
  type DocBlock,
  DocumentError,
  budgetChars,
  clampInt,
  normalizeInline,
  paginate,
  parseHtmlBlocks,
  resolveExistingFile,
  toMarkdownTable,
  truncateText,
  wrapExecute,
} from './document-utils'

const WORD_EXTS = ['.docx', '.docm']

// 中文 Word 的标题样式名默认不会被 mammoth 映射为 h1/h2，这里补上，保证大纲模式可用
const STYLE_MAP = [
  "p[style-name='Title'] => h1:fresh",
  "p[style-name='标题'] => h1:fresh",
  "p[style-name='标题 1'] => h1:fresh",
  "p[style-name='标题 2'] => h2:fresh",
  "p[style-name='标题 3'] => h3:fresh",
  "p[style-name='标题 4'] => h4:fresh",
  "p[style-name='标题 5'] => h5:fresh",
  "p[style-name='Heading 1'] => h1:fresh",
  "p[style-name='Heading 2'] => h2:fresh",
  "p[style-name='Heading 3'] => h3:fresh",
  "p[style-name='Heading 4'] => h4:fresh",
]

// ---------------------------------------------------------------------------
// 解析缓存
// ---------------------------------------------------------------------------

interface CachedDoc {
  mtimeMs: number
  sizeBytes: number
  blocks: DocBlock[]
  messages: string[]
}

const docCache = new Map<string, CachedDoc>()
const CACHE_LIMIT = 3

async function loadBlocks(
  resolved: string,
  mtimeMs: number,
  sizeBytes: number,
): Promise<{ blocks: DocBlock[]; messages: string[] }> {
  const cached = docCache.get(resolved)
  if (cached && cached.mtimeMs === mtimeMs && cached.sizeBytes === sizeBytes) {
    docCache.delete(resolved)
    docCache.set(resolved, cached)
    return { blocks: cached.blocks, messages: cached.messages }
  }

  let buffer: Buffer
  try {
    buffer = readFileSync(resolved)
  } catch (err) {
    throw new DocumentError(`读取文件失败: ${err instanceof Error ? err.message : err}`)
  }

  let html = ''
  let messages: string[] = []
  try {
    const result = await mammoth.convertToHtml({ buffer }, { styleMap: STYLE_MAP })
    html = result.value
    messages = result.messages.map((msg: { message: string }) => msg.message).slice(0, 5)
  } catch (err) {
    throw new DocumentError(
      `Word 文档解析失败（文件可能损坏、被加密，或其实是旧版 .doc 格式改名而来）: ${err instanceof Error ? err.message : err}`,
      '若为 .doc / .wps 旧格式，请先用 Word 另存为 .docx',
    )
  }

  const blocks = parseHtmlBlocks(html)
  docCache.set(resolved, { mtimeMs, sizeBytes, blocks, messages })
  if (docCache.size > CACHE_LIMIT) {
    const oldest = docCache.keys().next().value
    if (oldest) docCache.delete(oldest)
  }
  return { blocks, messages }
}

// ---------------------------------------------------------------------------
// 输出辅助
// ---------------------------------------------------------------------------

function blocksToMarkdown(blocks: DocBlock[], maxCellChars: number): string {
  const lines: string[] = []
  for (const block of blocks) {
    if (block.type === 'heading') {
      lines.push(`${'#'.repeat(block.level ?? 1)} ${block.text}`)
    } else if (block.type === 'list-item') {
      lines.push(`- ${block.text}`)
    } else if (block.type === 'table') {
      const rows = block.rows ?? []
      const [header, ...body] = rows
      if (!header) continue
      const clipped = [header, ...body].map((row) => row.map((cell) => truncateText(cell, maxCellChars)))
      lines.push(`**[表格 ${block.tableIndex}]**`)
      lines.push(toMarkdownTable(clipped[0], clipped.slice(1)))
    } else {
      lines.push(block.text)
    }
    lines.push('')
  }
  return lines.join('\n').trim()
}

type MatchMode = 'contains' | 'exact' | 'regex'

function hitKeywords(value: string, keywords: string[], mode: MatchMode, matchAll: boolean): string[] {
  const hits: string[] = []
  for (const kw of keywords) {
    let hit = false
    if (mode === 'exact') hit = value.trim().toLowerCase() === kw.trim().toLowerCase()
    else if (mode === 'regex') {
      let re: RegExp
      try {
        re = new RegExp(kw, 'i')
      } catch (err) {
        throw new DocumentError(`正则表达式非法 "${kw}": ${err instanceof Error ? err.message : err}`)
      }
      hit = re.test(value)
    } else hit = value.toLowerCase().includes(kw.toLowerCase())

    if (hit) hits.push(kw)
    else if (matchAll) return []
  }
  return hits
}

// ---------------------------------------------------------------------------
// 工具执行
// ---------------------------------------------------------------------------

interface ReadWordInput {
  path: string
  mode?: 'outline' | 'text' | 'tables' | 'search'
  keyword?: string
  keywords?: string[]
  matchMode?: MatchMode
  matchAll?: boolean
  tableIndex?: number
  offset?: number
  limit?: number
  maxCellChars?: number
  includeTables?: boolean
  format?: 'markdown' | 'json'
}

async function readWord(input: ReadWordInput) {
  const { resolved, ext, sizeBytes, mtimeMs, pathNote } = resolveExistingFile(input.path, WORD_EXTS)
  const mode = input.mode ?? 'outline'
  if (!['outline', 'text', 'tables', 'search'].includes(mode)) {
    throw new DocumentError(`mode 参数非法: ${mode}`, "可选值: 'outline' | 'text' | 'tables' | 'search'")
  }

  const maxCellChars = clampInt(input.maxCellChars, 20, 2000, 160)
  const { blocks, messages } = await loadBlocks(resolved, mtimeMs, sizeBytes)

  const fileInfo = { name: basename(resolved), ext, sizeKB: Math.round(sizeBytes / 1024) }
  const headBlocks = blocks.filter((b) => b.type === 'heading')
  const tableBlocks = blocks.filter((b) => b.type === 'table')
  const notes: string[] = []
  if (pathNote) notes.push(pathNote)
  if (messages.length > 0) notes.push(`解析提示: ${messages.join('; ')}`)
  if (blocks.length === 0) notes.push('文档正文为空，或内容全部位于文本框/图片中（mammoth 只能读取正文）')

  // ---------------- outline ----------------
  if (mode === 'outline') {
    const tables = tableBlocks.map((t) => ({
      tableIndex: t.tableIndex,
      rows: (t.rows ?? []).length,
      cols: (t.rows ?? [])[0]?.length ?? 0,
      header: (t.rows ?? [])[0]?.map((c) => truncateText(c, maxCellChars)),
      section: t.headingPath.join(' > ') || undefined,
    }))

    const paragraphs = blocks.filter((b) => b.type === 'paragraph' || b.type === 'list-item')

    return {
      success: true,
      mode,
      file: fileInfo,
      blockCount: blocks.length,
      paragraphCount: blocks.filter((b) => b.type === 'paragraph').length,
      headingCount: headBlocks.length,
      tableCount: tableBlocks.length,
      outline: headBlocks.map((b) => ({
        blockIndex: b.index,
        level: b.level,
        text: truncateText(b.text, maxCellChars),
        path: b.headingPath.join(' > '),
      })),
      tables,
      leadingParagraphs: paragraphs.slice(0, 3).map((b) => ({ blockIndex: b.index, text: truncateText(b.text, maxCellChars * 2) })),
      notes: notes.length > 0 ? notes : undefined,
      nextStep: '用 mode="text" 分页读正文，用 mode="tables" 读表格，用 mode="search" 按关键词定位',
    }
  }

  // ---------------- tables ----------------
  if (mode === 'tables') {
    if (tableBlocks.length === 0) {
      return {
        success: true,
        mode,
        file: fileInfo,
        tableCount: 0,
        tables: [],
        markdown: `未在文档中检索到任何表格`,
        notes: notes.length > 0 ? notes : undefined,
      }
    }

    if (input.tableIndex !== undefined) {
      const target = tableBlocks.find((t) => t.tableIndex === Number(input.tableIndex))
      if (!target) {
        throw new DocumentError(
          `未找到表格 ${input.tableIndex}，本文档共 ${tableBlocks.length} 个表格（编号 1~${tableBlocks.length}）`,
          '先用 mode="tables" 不带 tableIndex 查看全部表格概况',
        )
      }
      const rows = target.rows ?? []
      const [header, ...body] = rows
      const limit = clampInt(input.limit, 1, 200, 50)
      const offset = clampInt(input.offset, 0, 100000, 0)
      const page = paginate(body, offset, limit)
      const markdown = toMarkdownTable(
        (header ?? []).map((c) => truncateText(c, maxCellChars)),
        page.page.map((row) => row.map((c) => truncateText(c, maxCellChars))),
      )
      return {
        success: true,
        mode,
        file: fileInfo,
        tableIndex: target.tableIndex,
        section: target.headingPath.join(' > ') || undefined,
        totalRows: rows.length,
        dataRows: body.length,
        cols: header?.length ?? 0,
        offset: page.offset,
        returned: page.returned,
        hasMore: page.hasMore,
        nextOffset: page.nextOffset,
        markdown: budgetChars(`表格 ${target.tableIndex}（共 ${rows.length} 行）\n\n${markdown}`, 12000, '表格内容'),
        notes: notes.length > 0 ? notes : undefined,
      }
    }

    return {
      success: true,
      mode,
      file: fileInfo,
      tableCount: tableBlocks.length,
      tables: tableBlocks.map((t) => ({
        tableIndex: t.tableIndex,
        rows: (t.rows ?? []).length,
        cols: (t.rows ?? [])[0]?.length ?? 0,
        header: (t.rows ?? [])[0]?.map((c) => truncateText(c, maxCellChars)),
        section: t.headingPath.join(' > ') || undefined,
      })),
      notes: notes.length > 0 ? notes : undefined,
      hint: '用 tableIndex 读取某个表格的完整内容',
    }
  }

  // ---------------- search ----------------
  if (mode === 'search') {
    const keywords = [...(input.keyword ? [input.keyword] : []), ...(input.keywords ?? [])]
      .map((k) => String(k))
      .filter((k) => k.trim() !== '')
    if (keywords.length === 0) {
      throw new DocumentError('search 模式必须提供 keyword 或 keywords', '例如 {"mode":"search","keyword":"张三"}')
    }
    const matchMode: MatchMode = input.matchMode === 'exact' || input.matchMode === 'regex' ? input.matchMode : 'contains'
    const matchAll = input.matchAll === true

    const paragraphHits: Array<Record<string, unknown>> = []
    const tableHits: Array<Record<string, unknown>> = []

    for (const block of blocks) {
      if (block.type === 'table') {
        const rows = block.rows ?? []
        const header = rows[0] ?? []
        for (let r = 1; r < rows.length; r++) {
          // AND 语义下要求同一行同时命中所有关键词
          const rowHit = matchAll
            ? keywords.every((kw) => rows[r].some((cell) => hitKeywords(cell, [kw], matchMode, false).length > 0))
            : true
          for (let c = 0; c < rows[r].length; c++) {
            const value = rows[r][c] ?? ''
            if (value === '') continue
            const hits = hitKeywords(value, keywords, matchMode, false)
            if (hits.length === 0) continue
            if (matchAll && !rowHit) continue
            tableHits.push({
              kind: 'table',
              tableIndex: block.tableIndex,
              row: r + 1, // 1-based，含表头行
              col: c + 1,
              columnName: header[c] ? truncateText(normalizeInline(header[c]), maxCellChars) : `第${c + 1}列`,
              value: truncateText(value, maxCellChars),
              rowValues: rows[r].map((cell) => truncateText(cell, maxCellChars)),
              matched: hits,
              section: block.headingPath.join(' > ') || undefined,
            })
          }
          if (!matchAll && rowHit) {
            // 单关键词时 rowHit 恒为 true，无需额外处理
          }
        }
      } else {
        const hits = hitKeywords(block.text, keywords, matchMode, matchAll)
        if (hits.length === 0) continue
        paragraphHits.push({
          kind: block.type === 'list-item' ? 'list-item' : block.type,
          blockIndex: block.index,
          text: truncateText(block.text, maxCellChars * 3),
          matched: hits,
          section: block.headingPath.join(' > ') || undefined,
        })
      }
    }

    const all = [...paragraphHits, ...tableHits]
    const limit = clampInt(input.limit, 1, 200, 30)
    const offset = clampInt(input.offset, 0, 100000, 0)
    const page = paginate(all, offset, limit)

    const lines = page.page.map((hit, i) => {
      const h = hit as Record<string, any>
      const where =
        h.kind === 'table'
          ? `表格${h.tableIndex} 第${h.row}行 第${h.col}列(${h.columnName})`
          : h.kind === 'list-item'
            ? `第${h.blockIndex}条列表项`
            : `第${h.blockIndex}段`
      const section = h.section ? `【${h.section}】` : ''
      return `${page.offset + i + 1}. ${section}${where}: ${h.text ?? h.value}`
    })

    return {
      success: true,
      mode,
      file: fileInfo,
      searchedKeywords: keywords,
      matchMode,
      matchAll,
      matchedTotal: all.length,
      paragraphMatches: paragraphHits.length,
      tableMatches: tableHits.length,
      offset: page.offset,
      returned: page.returned,
      hasMore: page.hasMore,
      nextOffset: page.nextOffset,
      markdown: budgetChars(
        `文件: ${fileInfo.name} ｜ 关键词: ${keywords.join(matchAll ? ' AND ' : ' OR ')} (${matchMode}) ｜ 命中: ${all.length} 处\n\n${lines.join('\n')}`,
        12000,
        '检索结果',
      ),
      matches: input.format === 'json' ? page.page : undefined,
      notes: notes.length > 0 ? notes : undefined,
      hint: all.length === 0 ? `未在文件中检索到关于 [${keywords.join('、')}] 的数据` : undefined,
    }
  }

  // ---------------- text ----------------
  const flowBlocks = blocks.filter((b) => input.includeTables === false ? b.type !== 'table' : true)
  const limit = clampInt(input.limit, 1, 200, 40)
  const offset = clampInt(input.offset, 0, 100000, 0)
  const page = paginate(flowBlocks, offset, limit)
  const markdown = blocksToMarkdown(page.page, maxCellChars)

  return {
    success: true,
    mode,
    file: fileInfo,
    totalBlocks: flowBlocks.length,
    offset: page.offset,
    returned: page.returned,
    hasMore: page.hasMore,
    nextOffset: page.nextOffset,
    content: page.page.map((b) => ({
      blockIndex: b.index,
      type: b.type,
      level: b.level,
      tableIndex: b.tableIndex,
      section: b.headingPath.join(' > ') || undefined,
      text: b.type === 'table' ? `[表格 ${b.tableIndex}] ${(b.rows ?? []).length} 行` : truncateText(b.text, maxCellChars * 3),
    })),
    markdown: budgetChars(
      `文件: ${fileInfo.name} ｜ 第 ${page.offset + 1}~${page.offset + page.returned} 块 / 共 ${flowBlocks.length} 块\n\n${markdown}`,
      12000,
      '正文内容',
    ),
    notes: notes.length > 0 ? notes : undefined,
  }
}

export const readWordTool: ToolDefinition = {
  name: 'read_word',
  description:
    '读取并检索 Word(.docx/.docm) 文档内容，保留段落、标题层级与表格结构。四种模式：' +
    'outline=文档大纲（标题树 + 表格清单 + 开头段落，先用它了解文档结构）；' +
    'text=分页读取正文与表格（Markdown 形式，带段落编号）；' +
    'tables=列出全部表格概况，或用 tableIndex 读取指定表格的完整内容；' +
    'search=按关键词（人名/学号/班级/考场等）定位，返回"第N段/表格K第R行第C列 + 所属标题章节 + 原文"，可直接引用核对。' +
    '注意：仅支持 .docx 系列，不支持旧版二进制 .doc（需先另存为 .docx）。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Word 文件路径（相对工作目录或绝对路径）' },
      mode: {
        type: 'string',
        enum: ['outline', 'text', 'tables', 'search'],
        description: 'outline=结构大纲（默认）; text=分页正文; tables=表格; search=关键词检索',
      },
      keyword: { type: 'string', description: '单个检索关键词（search 模式），如 "张三"' },
      keywords: { type: 'array', items: { type: 'string' }, description: '多个检索关键词，默认 OR，配合 matchAll=true 变 AND' },
      matchMode: { type: 'string', enum: ['contains', 'exact', 'regex'], description: '匹配方式，默认 contains（忽略大小写）' },
      matchAll: { type: 'boolean', description: 'true=要求同时命中所有关键词（AND）。默认 false（OR）' },
      tableIndex: { type: 'number', description: 'tables 模式下要读取的表格编号（1-based，来自 outline/tables 的清单）' },
      offset: { type: 'number', description: '分页偏移量（0-based）：text 按块、tables 按数据行、search 按命中数' },
      limit: { type: 'number', description: '本页最大条数。text 默认 40，tables 默认 50，search 默认 30' },
      maxCellChars: { type: 'number', description: '单个段落/单元格最大字符数（默认 160，超出截断以保护 Token）' },
      includeTables: { type: 'boolean', description: 'text 模式下是否包含表格（默认 true）' },
      format: { type: 'string', enum: ['markdown', 'json'], description: 'markdown=文本化结果（默认）; json=search 时额外返回结构化匹配数组' },
    },
    required: ['path'],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  maxResultChars: 9000,
  execute: wrapExecute(readWord),
}
