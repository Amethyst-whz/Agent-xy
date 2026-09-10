/**
 * read_pdf —— Agent 用的 PDF 只读解析工具
 *
 * 特点：
 *   - 惰性加载 pdf-parse（pdfjs-dist 体积大，不在启动时拖慢 Agent）
 *   - 依赖缺失时优雅降级：返回可执行的修复提示，而不是让工具报栈崩溃
 *   - 按页返回内容（PDF 的天然分页就是最好的分页单位），并保留真实页码便于引用
 */

import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import type { ToolDefinition } from '../registry'
import {
  DocumentError,
  budgetChars,
  clampInt,
  paginate,
  resolveExistingFile,
  truncateText,
  wrapExecute,
} from './document-utils'

/** 动态导入 pdf-parse：未安装时给出明确提示 */
async function loadPdfParse() {
  try {
    const mod = await import('pdf-parse')
    return mod.PDFParse
  } catch (err) {
    throw new DocumentError(
      `PDF 解析依赖不可用: ${err instanceof Error ? err.message : err}`,
      '请在项目根目录执行: pnpm add pdf-parse',
    )
  }
}

/** 解析 "1-3,7,9-10" 形式的页范围 */
function parsePageSpec(spec: string | undefined, total: number): number[] | undefined {
  if (!spec || spec.trim() === '' || spec.trim().toLowerCase() === 'all') return undefined
  const pages = new Set<number>()
  for (const part of spec.split(/[,，]/)) {
    const chunk = part.trim()
    if (chunk === '') continue
    const range = /^(\d+)\s*[-~]\s*(\d+)$/.exec(chunk)
    if (range) {
      const start = Number(range[1])
      const end = Number(range[2])
      if (start > end) throw new DocumentError(`页范围非法: "${chunk}"（起始页大于结束页）`)
      for (let p = start; p <= end; p++) if (p >= 1 && p <= total) pages.add(p)
      continue
    }
    const single = Number(chunk)
    if (!Number.isInteger(single)) throw new DocumentError(`页范围非法: "${chunk}"`, '正确示例: "1-5,8" 或 "3"')
    if (single >= 1 && single <= total) pages.add(single)
  }
  return [...pages].sort((a, b) => a - b)
}

function tidyPageText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

type MatchMode = 'contains' | 'exact' | 'regex'

interface ReadPdfInput {
  path: string
  mode?: 'info' | 'text' | 'search'
  pages?: string
  keyword?: string
  keywords?: string[]
  matchMode?: MatchMode
  matchAll?: boolean
  offset?: number
  limit?: number
  maxCharsPerPage?: number
  format?: 'markdown' | 'json'
}

async function readPdf(input: ReadPdfInput) {
  const { resolved, sizeBytes, pathNote } = resolveExistingFile(input.path, ['.pdf'])
  const mode = input.mode ?? 'text'
  if (!['info', 'text', 'search'].includes(mode)) {
    throw new DocumentError(`mode 参数非法: ${mode}`, "可选值: 'info' | 'text' | 'search'")
  }

  const fileInfo = { name: basename(resolved), sizeKB: Math.round(sizeBytes / 1024), pathNote }

  const PDFParse = await loadPdfParse()
  const buffer = readFileSync(resolved)
  const parser = new PDFParse({ data: new Uint8Array(buffer) })

  try {
    // ---------------- info ----------------
    if (mode === 'info') {
      const info = await parser.getInfo({ parsePageInfo: false })
      const meta = (info.info ?? {}) as Record<string, unknown>
      const pick = (key: string) => {
        const v = meta[key]
        return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined
      }
      return {
        success: true,
        mode,
        file: fileInfo,
        totalPages: info.total,
        title: pick('Title'),
        author: pick('Author'),
        subject: pick('Subject'),
        creator: pick('Creator'),
        producer: pick('Producer'),
        creationDate: pick('CreationDate'),
        outline: Array.isArray(info.outline)
          ? info.outline.slice(0, 30).map((node: { title?: string }) => node.title ?? '').filter(Boolean)
          : undefined,
        nextStep: '用 mode="text" 配合 pages="1-5" 分页读正文，或用 mode="search" 按关键词定位',
      }
    }

    if (mode === 'search') {
      const keywords = [...(input.keyword ? [input.keyword] : []), ...(input.keywords ?? [])]
        .map((k) => String(k))
        .filter((k) => k.trim() !== '')
      if (keywords.length === 0) {
        throw new DocumentError('search 模式必须提供 keyword 或 keywords', '例如 {"mode":"search","keyword":"张三"}')
      }
      const matchMode: MatchMode = input.matchMode === 'exact' || input.matchMode === 'regex' ? input.matchMode : 'contains'
      const matchAll = input.matchAll === true

      const result = await parser.getText({ pageJoiner: '' })
      const matches: Array<Record<string, unknown>> = []

      for (const page of result.pages) {
        const lines = tidyPageText(page.text).split('\n')
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]
          if (line.trim() === '') continue
          const hits: string[] = []
          for (const kw of keywords) {
            let hit = false
            if (matchMode === 'exact') hit = line.trim().toLowerCase() === kw.trim().toLowerCase()
            else if (matchMode === 'regex') {
              let re: RegExp
              try {
                re = new RegExp(kw, 'i')
              } catch (err) {
                throw new DocumentError(`正则表达式非法 "${kw}": ${err instanceof Error ? err.message : err}`)
              }
              hit = re.test(line)
            } else hit = line.toLowerCase().includes(kw.toLowerCase())
            if (hit) hits.push(kw)
          }
          if (hits.length === 0) continue
          if (matchAll && hits.length < keywords.length) continue
          matches.push({
            page: page.num,
            line: i + 1,
            text: truncateText(line.trim(), 200),
            matched: [...new Set(hits)],
            context:
              i > 0 || i < lines.length - 1
                ? truncateText(
                    [lines[i - 1] ?? '', line, lines[i + 1] ?? ''].map((l) => l.trim()).filter(Boolean).join(' / '),
                    300,
                  )
                : undefined,
          })
        }
      }

      const limit = clampInt(input.limit, 1, 300, 30)
      const offset = clampInt(input.offset, 0, 100000, 0)
      const page = paginate(matches, offset, limit)
      const lines = page.page.map(
        (m, i) => `${page.offset + i + 1}. 第${(m as any).page}页 第${(m as any).line}行: ${(m as any).text}`,
      )

      return {
        success: true,
        mode,
        file: fileInfo,
        totalPages: result.total,
        searchedKeywords: keywords,
        matchMode,
        matchAll,
        matchedTotal: matches.length,
        offset: page.offset,
        returned: page.returned,
        hasMore: page.hasMore,
        nextOffset: page.nextOffset,
        markdown: budgetChars(
          `文件: ${basename(resolved)} ｜ 共 ${result.total} 页 ｜ 关键词: ${keywords.join(matchAll ? ' AND ' : ' OR')} ｜ 命中: ${matches.length} 处\n\n${lines.join('\n')}`,
          12000,
          '检索结果',
        ),
        matches: input.format === 'json' ? page.page : undefined,
        hint: matches.length === 0 ? `未在文件中检索到关于 [${keywords.join('、')}] 的数据（已扫描 ${result.total} 页）` : undefined,
      }
    }

    // ---------------- text ----------------
    const probe = await parser.getInfo({ parsePageInfo: false })
    const totalPages = probe.total
    const explicitPages = parsePageSpec(input.pages, totalPages)
    const maxCharsPerPage = clampInt(input.maxCharsPerPage, 200, 20000, 3000)
    const limit = clampInt(input.limit, 1, 100, 5)
    const offset = clampInt(input.offset, 0, 100000, 0)

    let pageNumbers: number[]
    if (explicitPages) {
      const slice = paginate(explicitPages, offset, limit)
      pageNumbers = slice.page
    } else {
      // 未指定页范围：按 offset/limit 顺序翻页
      const start = Math.min(offset + 1, totalPages)
      pageNumbers = []
      for (let p = start; p < start + limit && p <= totalPages; p++) pageNumbers.push(p)
    }

    if (pageNumbers.length === 0) {
      return {
        success: true,
        mode,
        file: fileInfo,
        totalPages,
        offset,
        returned: 0,
        hasMore: false,
        markdown: `没有可返回的页（offset=${offset} 超出 ${totalPages} 页范围）`,
      }
    }

    const result = await parser.getText({ partial: pageNumbers, pageJoiner: '' })
    const byPage = new Map(result.pages.map((p) => [p.num, tidyPageText(p.text)]))
    const sections = pageNumbers.map((num) => {
      const text = byPage.get(num) ?? ''
      const clipped = truncateText(text, maxCharsPerPage)
      return `## 第 ${num} 页${text === '' ? '（无可提取文字，可能是扫描件图片）' : ''}\n\n${clipped || '(空)'}`
    })

    const maxPage = Math.max(...pageNumbers)
    const selected = explicitPages ? explicitPages.length : totalPages
    return {
      success: true,
      mode,
      file: fileInfo,
      totalPages,
      offset,
      pages: pageNumbers,
      returned: pageNumbers.length,
      hasMore: maxPage < totalPages,
      nextOffset: maxPage < totalPages ? maxPage : null,
      pagesWithText: pageNumbers.filter((n) => (byPage.get(n) ?? '') !== '').length,
      selectedPageCount: selected,
      markdown: budgetChars(
        `文件: ${basename(resolved)} ｜ 共 ${totalPages} 页 ｜ 本次返回第 ${pageNumbers[0]}~${maxPage} 页\n\n${sections.join('\n\n')}`,
        12000,
        '正文内容',
      ),
      hint: maxPage < totalPages ? `还有后续页码，可用 offset=${maxPage} 或 pages="..." 指定范围继续读取` : undefined,
    }
  } finally {
    await parser.destroy().catch(() => undefined)
  }
}

export const readPdfTool: ToolDefinition = {
  name: 'read_pdf',
  description:
    '读取并检索 PDF 文件内容（按页返回，保留真实页码便于引用）。三种模式：' +
    'info=页数与文档元信息（标题/作者/书签大纲）；' +
    'text=按页读取正文，支持 pages="1-5,8" 指定页范围，或用 offset/limit 顺序翻页（默认每页最多 3000 字符）；' +
    'search=按关键词定位，返回"第N页第M行 + 原文 + 上下文"。' +
    '注意：纯扫描件（图片型 PDF）无法提取文字，此时 pages 内容会显示为空。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'PDF 文件路径（相对工作目录或绝对路径）' },
      mode: { type: 'string', enum: ['info', 'text', 'search'], description: 'info=元信息; text=按页读正文（默认）; search=关键词检索' },
      pages: { type: 'string', description: '要读取的页范围，如 "1-5,8"；省略则从 offset 顺序翻页。仅 text 模式使用' },
      keyword: { type: 'string', description: '单个检索关键词（search 模式）' },
      keywords: { type: 'array', items: { type: 'string' }, description: '多个检索关键词，默认 OR，配合 matchAll=true 变 AND' },
      matchMode: { type: 'string', enum: ['contains', 'exact', 'regex'], description: '匹配方式，默认 contains（忽略大小写）' },
      matchAll: { type: 'boolean', description: 'true=要求同一行同时命中所有关键词（AND）。默认 false（OR）' },
      offset: { type: 'number', description: '分页偏移量（0-based）：text 按页码、search 按命中条数' },
      limit: { type: 'number', description: 'text=本次最多返回几页（默认 5）；search=最多返回几条命中（默认 30）' },
      maxCharsPerPage: { type: 'number', description: '每页最多提取多少字符（默认 3000，超出截断以保护 Token）' },
      format: { type: 'string', enum: ['markdown', 'json'], description: 'markdown=文本化结果（默认）; json=search 时额外返回结构化匹配数组' },
    },
    required: ['path'],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  maxResultChars: 9000,
  shouldDefer: true, // 低频工具：延迟加载，靠 tool_search 按需发现
  searchHint: 'PDF 读取 解析 pdf 论文 报告 扫描件 页码 提取文字 read pdf',
  execute: wrapExecute(readPdf),
}
