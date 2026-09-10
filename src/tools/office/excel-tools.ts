/**
 * read_excel —— Agent 用的 Excel / CSV 只读解析工具
 *
 * 设计目标（对应"依据事实"工作流）：
 *   overview：先摸清文件有几张 Sheet、每张表头在第几行、字段是什么（发现阶段）
 *   preview ：按 offset/limit 分页看数据（避免一次性塞爆上下文）
 *   search  ：按关键词跨表检索命中行，返回"Sheet + Excel 行号 + 字段值"（取证阶段，可直接引用）
 *
 * 关键工程点：
 *   - 表头动态识别：跳过空行与大标题合并行，支持两行分组表头
 *   - 合并单元格还原：!merges 左上角值向下/向右填充
 *   - 脏值净化：null / Date / 数字 / 布尔 / 公式 / 错误值 统一转字符串
 *   - Token 保护：单元格截断 + 行分页 + 整体字符预算
 */

import * as XLSX from 'xlsx'
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import type { ToolDefinition } from '../registry'
import {
  DocumentError,
  budgetChars,
  clampInt,
  columnLetter,
  detectHeader,
  flattenHeaderRows,
  formatDate,
  normalizeCell,
  normalizeHeaders,
  paginate,
  resolveExistingFile,
  toMarkdownTable,
  truncateText,
  wrapExecute,
} from './document-utils'

// ---------------------------------------------------------------------------
// 工作簿缓存：Agent 通常先 overview 再 search，同一文件重复解析会浪费大量时间
// ---------------------------------------------------------------------------

interface CachedWorkbook {
  mtimeMs: number
  sizeBytes: number
  wb: XLSX.WorkBook
}

const workbookCache = new Map<string, CachedWorkbook>()
const CACHE_LIMIT = 3

function loadWorkbook(resolved: string, mtimeMs: number, sizeBytes: number): XLSX.WorkBook {
  const cached = workbookCache.get(resolved)
  if (cached && cached.mtimeMs === mtimeMs && cached.sizeBytes === sizeBytes) {
    workbookCache.delete(resolved) // LRU 续期
    workbookCache.set(resolved, cached)
    return cached.wb
  }
  let buf: Buffer
  try {
    buf = readFileSync(resolved)
  } catch (err) {
    throw new DocumentError(`读取文件失败: ${err instanceof Error ? err.message : err}`)
  }
  let wb: XLSX.WorkBook
  try {
    wb = XLSX.read(buf, {
      type: 'buffer',
      cellDates: true, // 日期 → Date 对象，而不是 45292 这种序列号
      cellFormula: true, // 保留公式，便于识别"这列是算出来的"
      cellNF: true,
      cellText: true, // 生成 .w 显示文本
    })
  } catch (err) {
    throw new DocumentError(
      `Excel 解析失败（文件可能损坏、加密或不是真正的表格格式）: ${err instanceof Error ? err.message : err}`,
      '若文件有打开密码，请先另存为无密码副本',
    )
  }
  workbookCache.set(resolved, { mtimeMs, sizeBytes, wb })
  if (workbookCache.size > CACHE_LIMIT) {
    const oldest = workbookCache.keys().next().value
    if (oldest) workbookCache.delete(oldest)
  }
  return wb
}

// ---------------------------------------------------------------------------
// 单元格 → 文本
// ---------------------------------------------------------------------------

/**
 * 单元格转文本。
 * raw=false（默认）优先取单元格显示文本（.w），保留原文件的数字格式：
 *   百分比 "85.5%"、金额 "￥1,200.00"、学号前导零
 * 日期统一归一化为 ISO（"2024-09-01"），避免 9/1/24、45292 这类歧义表示。
 * raw=true 取底层值，便于做精确统计/比对。
 */
function cellText(cell: XLSX.CellObject | undefined, raw: boolean): string {
  if (!cell) return ''
  if (cell.t === 'e') return cell.w ? String(cell.w) : '#ERROR#'
  if (cell.t === 'b') return cell.v ? 'TRUE' : 'FALSE'

  const v = cell.v
  if (v instanceof Date) return formatDate(v) // 日期优先走 ISO，而不是各文件不同的显示格式
  if (!raw) {
    const w = typeof cell.w === 'string' ? cell.w.trim() : ''
    if (w !== '') return w
  }
  return normalizeCell(v)
}

// ---------------------------------------------------------------------------
// 工作表 → 规整矩阵
// ---------------------------------------------------------------------------

interface SheetMatrix {
  rows: string[][]
  excelRowNumbers: number[]
  colCount: number
  totalCols: number
  totalRows: number
  formulaCells: number
  mergedRanges: number
  colTruncated: boolean
  rowTruncated: boolean
}

function buildMatrix(ws: XLSX.WorkSheet, maxColumns: number, maxRows: number, raw: boolean): SheetMatrix {
  const ref = ws['!ref']
  if (!ref) {
    return {
      rows: [],
      excelRowNumbers: [],
      colCount: 0,
      totalCols: 0,
      totalRows: 0,
      formulaCells: 0,
      mergedRanges: 0,
      colTruncated: false,
      rowTruncated: false,
    }
  }

  const range = XLSX.utils.decode_range(ref)
  const totalRows = range.e.r - range.s.r + 1
  const totalCols = range.e.c - range.s.c + 1
  const colCount = Math.min(totalCols, maxColumns)
  const rowLimit = Math.min(totalRows, maxRows)

  const rows: string[][] = []
  const excelRowNumbers: number[] = []
  let formulaCells = 0

  for (let r = range.s.r; r < range.s.r + rowLimit; r++) {
    const row: string[] = []
    for (let c = range.s.c; c < range.s.c + colCount; c++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })] as XLSX.CellObject | undefined
      if (cell?.f) formulaCells++
      row.push(cellText(cell, raw))
    }
    rows.push(row)
    excelRowNumbers.push(r + 1)
  }

  // 合并单元格还原：用左上角的值填充整个合并区域（大标题 / 纵向合并的分组表头）
  const merges = (ws['!merges'] ?? []) as XLSX.Range[]
  for (const merge of merges) {
    if (merge.s.r < range.s.r || merge.s.r >= range.s.r + rowLimit) continue
    const source = ws[XLSX.utils.encode_cell({ r: merge.s.r, c: merge.s.c })] as XLSX.CellObject | undefined
    const value = cellText(source, raw)
    if (value === '') continue
    const rEnd = Math.min(merge.e.r, range.s.r + rowLimit - 1)
    const cEnd = Math.min(merge.e.c, range.s.c + colCount - 1)
    for (let r = merge.s.r; r <= rEnd; r++) {
      const rowIndex = r - range.s.r
      for (let c = merge.s.c; c <= cEnd; c++) {
        const colIndex = c - range.s.c
        if (rows[rowIndex] && rowIndex >= 0 && colIndex >= 0 && colIndex < colCount) {
          rows[rowIndex][colIndex] = value
        }
      }
    }
  }

  return {
    rows,
    excelRowNumbers,
    colCount,
    totalCols,
    totalRows,
    formulaCells,
    mergedRanges: merges.length,
    colTruncated: totalCols > colCount,
    rowTruncated: totalRows > rowLimit,
  }
}

// ---------------------------------------------------------------------------
// 表头 + 记录
// ---------------------------------------------------------------------------

interface SheetTable {
  sheetName: string
  headers: string[]
  headerRowNumber: number
  dataStartExcelRow: number
  records: Array<{ excelRow: number; values: string[] }>
  notes: string[]
  matrix: SheetMatrix
}

function buildTable(
  ws: XLSX.WorkSheet,
  sheetName: string,
  options: { maxColumns: number; maxRows: number; raw: boolean; headerRow?: number; headerRows?: number; includeEmptyRows: boolean },
): SheetTable {
  const matrix = buildMatrix(ws, options.maxColumns, options.maxRows, options.raw)
  const notes: string[] = []

  if (matrix.rows.length === 0) {
    return {
      sheetName,
      headers: [],
      headerRowNumber: 0,
      dataStartExcelRow: 0,
      records: [],
      notes: ['该工作表为空（无 !ref 范围）'],
      matrix,
    }
  }

  // 表头定位：显式指定 > 自动识别
  const scan = detectHeader(matrix.rows, 15)
  let headerRowIndex = scan.headerRowIndex
  let headerRowCount = scan.headerRowCount

  if (options.headerRows && options.headerRows > 0) {
    // 用户显式给了表头块行数，则从自动识别的表头行向下取 N 行
    headerRowCount = Math.min(options.headerRows, matrix.rows.length - headerRowIndex)
  }
  if (options.headerRow && options.headerRow > 0) {
    const idx = matrix.excelRowNumbers.indexOf(options.headerRow)
    if (idx === -1) {
      notes.push(`指定的 headerRow=${options.headerRow} 超出数据范围(${matrix.excelRowNumbers[0]}~${matrix.excelRowNumbers[matrix.excelRowNumbers.length - 1]})，已回退为自动识别`)
    } else {
      headerRowIndex = idx
      if (!options.headerRows) headerRowCount = 1
    }
  }

  const headerRows = matrix.rows.slice(headerRowIndex, headerRowIndex + headerRowCount)
  const { headers } = normalizeHeaders(flattenHeaderRows(headerRows, matrix.colCount))
  const headerRowNumber = matrix.excelRowNumbers[headerRowIndex] ?? 0
  const dataStartExcelRow = matrix.excelRowNumbers[headerRowIndex + headerRowCount] ?? headerRowNumber + headerRowCount

  if (scan.skippedRows.length > 0) {
    const nums = scan.skippedRows.map((i) => matrix.excelRowNumbers[i]).join('、')
    notes.push(`第 ${nums} 行判定为标题/空行，未作为表头`)
  }
  if (headerRowCount > 1) {
    notes.push(`识别到 ${headerRowCount} 行复合表头，已按列合并为 "分组 / 子项" 形式`)
  }

  // 数据行
  const records: Array<{ excelRow: number; values: string[] }> = []
  const repeatedHeaderRows: number[] = []
  // 跨页重复的表头有多种形态：拍平后的表头、或原样的分组表头行，都算重复表头
  const headerSignatures = new Set<string>([headers.join('\u0001')])
  for (let i = headerRowIndex; i < headerRowIndex + headerRowCount; i++) {
    headerSignatures.add((matrix.rows[i] ?? []).slice(0, headers.length).join('\u0001'))
  }

  for (let i = headerRowIndex + headerRowCount; i < matrix.rows.length; i++) {
    const values = matrix.rows[i].slice(0, headers.length)
    if (headerSignatures.has(values.join('\u0001'))) {
      repeatedHeaderRows.push(matrix.excelRowNumbers[i]) // 中途重复的表头行（跨页打印常见）
      continue
    }
    if (!options.includeEmptyRows && values.every((v) => v === '')) continue
    records.push({ excelRow: matrix.excelRowNumbers[i], values })
  }

  if (repeatedHeaderRows.length > 0) {
    notes.push(`第 ${repeatedHeaderRows.slice(0, 10).join('、')} 行与表头重复（跨页表头），已从数据行中剔除`)
  }
  if (matrix.formulaCells > 0) notes.push(`含 ${matrix.formulaCells} 个公式单元格，返回的是其计算结果`)
  if (matrix.mergedRanges > 0) notes.push(`含 ${matrix.mergedRanges} 处合并单元格，已按左上角值填充`)
  if (matrix.colTruncated) notes.push(`原表共 ${matrix.totalCols} 列，仅解析前 ${matrix.colCount} 列（可用 maxColumns 调整）`)
  if (matrix.rowTruncated) notes.push(`原表共 ${matrix.totalRows} 行，仅解析前 ${matrix.rows.length} 行（可用 maxRows 调整）`)

  return { sheetName, headers, headerRowNumber, dataStartExcelRow, records, notes, matrix }
}

// ---------------------------------------------------------------------------
// Sheet 选择 / 列选择 / 匹配
// ---------------------------------------------------------------------------

function pickSheetNames(wb: XLSX.WorkBook, sheet: string | number | undefined, mode: string): string[] {
  const names = wb.SheetNames
  if (names.length === 0) throw new DocumentError('工作簿中没有任何工作表')

  if (sheet === undefined || sheet === null || sheet === '') {
    // 检索模式默认横扫全部工作表（多表核对场景），其余模式默认第一张
    return mode === 'search' && names.length > 1 ? names : [names[0]]
  }
  if (typeof sheet === 'number') {
    const idx = sheet - 1 // 1-based，对模型更友好
    if (idx < 0 || idx >= names.length) {
      throw new DocumentError(`sheet 序号 ${sheet} 超出范围，本文件共 ${names.length} 张工作表: ${names.map((n, i) => `${i + 1}.${n}`).join(', ')}`)
    }
    return [names[idx]]
  }
  const wanted = String(sheet).trim()
  const exact = names.find((n) => n === wanted)
  if (exact) return [exact]
  const fuzzy = names.find((n) => n.toLowerCase() === wanted.toLowerCase())
  if (fuzzy) return [fuzzy]
  throw new DocumentError(
    `未找到工作表 "${sheet}"，本文件包含: ${names.join(' / ')}`,
    '可用 sheet 传工作表名，或传 1-based 序号（如 2）',
  )
}

/** 列选择：支持表头名（不区分大小写）或 1-based 列序号 */
function resolveColumns(selected: string[] | undefined, headers: string[]): { indices: number[]; missing: string[] } {
  if (!selected || selected.length === 0) {
    return { indices: headers.map((_, i) => i), missing: [] }
  }
  const indices: number[] = []
  const missing: string[] = []
  for (const key of selected) {
    const raw = String(key).trim()
    const lower = raw.toLowerCase()
    const byName = headers.findIndex((h) => h.trim().toLowerCase() === lower)
    if (byName !== -1) {
      if (!indices.includes(byName)) indices.push(byName)
      continue
    }
    const asNumber = Number(raw)
    if (Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= headers.length) {
      if (!indices.includes(asNumber - 1)) indices.push(asNumber - 1)
      continue
    }
    missing.push(raw)
  }
  return { indices: indices.length > 0 ? indices : headers.map((_, i) => i), missing }
}

type MatchMode = 'contains' | 'exact' | 'regex'

/** 单个关键词 vs 单个单元格 */
function cellMatches(value: string, keyword: string, mode: MatchMode): boolean {
  if (mode === 'exact') return value.trim().toLowerCase() === keyword.trim().toLowerCase()
  if (mode === 'regex') {
    let re: RegExp
    try {
      re = new RegExp(keyword, 'i')
    } catch (err) {
      throw new DocumentError(`正则表达式非法 "${keyword}": ${err instanceof Error ? err.message : err}`)
    }
    return re.test(value)
  }
  return value.toLowerCase().includes(keyword.toLowerCase())
}

/**
 * 行级匹配：关键词可以在同一行的不同列命中。
 * OR（默认）：任一关键词命中即算命中；AND：所有关键词都要在本行命中。
 */
function matchRow(
  values: Array<{ index: number; text: string }>,
  keywords: string[],
  mode: MatchMode,
  matchAll: boolean,
): string[] {
  const hits: string[] = []
  for (const kw of keywords) {
    const hit = values.some((cell) => cell.text !== '' && cellMatches(cell.text, kw, mode))
    if (hit) hits.push(kw)
    else if (matchAll) return [] // AND 语义下缺一个关键词即整行不命中
  }
  return hits
}

// ---------------------------------------------------------------------------
// 工具执行
// ---------------------------------------------------------------------------

interface ReadExcelInput {
  path: string
  mode?: 'overview' | 'preview' | 'search'
  sheet?: string | number
  keyword?: string
  keywords?: string[]
  matchMode?: MatchMode
  matchAll?: boolean
  columns?: string[]
  headerRow?: number
  headerRows?: number
  offset?: number
  limit?: number
  maxRows?: number
  maxColumns?: number
  maxCellChars?: number
  includeEmptyRows?: boolean
  rawValues?: boolean
  format?: 'markdown' | 'json'
}

const EXCEL_EXTS = ['.xlsx', '.xlsm', '.xls', '.xlsb', '.csv', '.txt']

async function readExcel(input: ReadExcelInput) {
  const { resolved, ext, sizeBytes, mtimeMs, pathNote } = resolveExistingFile(input.path, EXCEL_EXTS)
  const mode = input.mode ?? 'overview'
  if (!['overview', 'preview', 'search'].includes(mode)) {
    throw new DocumentError(`mode 参数非法: ${mode}`, "可选值: 'overview' | 'preview' | 'search'")
  }

  const maxColumns = clampInt(input.maxColumns, 1, 200, 30)
  const maxRows = clampInt(input.maxRows, 1, 50000, 5000)
  const maxCellChars = clampInt(input.maxCellChars, 20, 2000, 200)
  const raw = input.rawValues === true
  const format = input.format === 'json' ? 'json' : 'markdown'
  const includeEmptyRows = input.includeEmptyRows === true

  const wb = loadWorkbook(resolved, mtimeMs, sizeBytes)
  const fileInfo = {
    name: basename(resolved),
    ext,
    sizeKB: Math.round(sizeBytes / 1024),
    sheetNames: wb.SheetNames,
  }

  const buildOptions = {
    maxColumns,
    maxRows,
    raw,
    headerRow: input.headerRow,
    headerRows: input.headerRows,
    includeEmptyRows,
  }

  // ---------------- overview ----------------
  if (mode === 'overview') {
    const listed = wb.SheetNames.slice(0, 12)
    const sheets = listed.map((name, i) => {
      const table = buildTable(wb.Sheets[name], name, buildOptions)
      return {
        index: i + 1,
        name,
        dataRows: table.records.length,
        columns: table.headers.length,
        headerRowNumber: table.headerRowNumber || null,
        headerRowCount: table.matrix.rows.length > 0 ? Math.max(1, table.dataStartExcelRow - table.headerRowNumber) : 0,
        headers: table.headers.map((h, ci) => truncateText(h, maxCellChars) || columnLetter(ci)),
        sampleRows: table.records.slice(0, 2).map((r) => r.values.map((v) => truncateText(v, maxCellChars))),
        notes: table.notes.length > 0 ? table.notes : undefined,
      }
    })

    const notes = [...new Set(sheets.flatMap((s) => s.notes ?? []))]
    if (pathNote) notes.unshift(pathNote)
    if (wb.SheetNames.length > listed.length) {
      notes.push(`本文件共 ${wb.SheetNames.length} 张工作表，仅列出前 ${listed.length} 张`)
    }

    return {
      success: true,
      mode,
      file: fileInfo,
      sheetCount: wb.SheetNames.length,
      sheets,
      notes: notes.length > 0 ? notes : undefined,
      nextStep: '用 mode="search" 检索具体人名/学号/班级，或用 mode="preview" 分页查看某张表的完整数据',
    }
  }

  const sheetNames = pickSheetNames(wb, input.sheet, mode)
  const keywords = [
    ...(input.keyword ? [input.keyword] : []),
    ...(input.keywords ?? []),
  ].map((k) => String(k)).filter((k) => k.trim() !== '')
  const matchMode: MatchMode = input.matchMode === 'exact' || input.matchMode === 'regex' ? input.matchMode : 'contains'

  // ---------------- search ----------------
  if (mode === 'search') {
    if (keywords.length === 0) {
      throw new DocumentError('search 模式必须提供 keyword 或 keywords', '例如 {"mode":"search","keywords":["张三","20240101"]}')
    }
    const limit = clampInt(input.limit, 1, 500, 50)
    const offset = clampInt(input.offset, 0, 1_000_000, 0)

    const allMatches: Array<{
      sheet: string
      excelRow: number
      values: Record<string, string>
      rowValues: string[]
      matchedKeywords: string[]
    }> = []
    const warnings: string[] = []
    if (pathNote) warnings.push(pathNote)
    let scannedRows = 0
    let matchedPool = 0
    let usedHeaders: string[] = []
    let usedSheet = ''

    for (const name of sheetNames) {
      const table = buildTable(wb.Sheets[name], name, buildOptions)
      if (table.headers.length === 0) {
        warnings.push(`工作表 "${name}" 无有效表头，已跳过`)
        continue
      }
      if (usedHeaders.length === 0) usedHeaders = table.headers
      if (usedSheet === '') usedSheet = name

      const { indices, missing } = resolveColumns(input.columns, table.headers)
      if (missing.length > 0) {
        warnings.push(`工作表 "${name}" 中未找到列: ${missing.join('、')}（现有列: ${table.headers.join('、')}）`)
      }

      for (const record of table.records) {
        scannedRows++
        const uniqueHits = matchRow(
          indices.map((ci) => ({ index: ci, text: record.values[ci] ?? '' })),
          keywords,
          matchMode,
          input.matchAll === true,
        )
        if (uniqueHits.length === 0) continue

        matchedPool++
        allMatches.push({
          sheet: name,
          excelRow: record.excelRow,
          rowValues: record.values.map((v) => truncateText(v, maxCellChars)),
          values: Object.fromEntries(table.headers.map((h, hi) => [h, truncateText(record.values[hi] ?? '', maxCellChars)])),
          matchedKeywords: uniqueHits,
        })
      }
    }

    const page = paginate(allMatches, offset, limit)
    const multiSheet = sheetNames.length > 1
    const displayHeaders = multiSheet ? ['工作表', 'Excel行', ...usedHeaders] : ['Excel行', ...usedHeaders]

    const markdown = toMarkdownTable(
      displayHeaders,
      page.page.map((m) => (multiSheet ? [m.sheet, String(m.excelRow), ...m.rowValues] : [String(m.excelRow), ...m.rowValues])),
    )

    const summary = [
      `文件: ${fileInfo.name} ｜ 模式: search ｜ 关键词: ${keywords.join(input.matchAll ? ' AND ' : ' OR ')} (${matchMode})`,
      `检索范围: ${sheetNames.join('、')} ｜ 扫描数据行: ${scannedRows} ｜ 命中: ${matchedPool} 行`,
      `本页返回: 第 ${page.offset + 1}~${page.offset + page.returned} 条${page.hasMore ? `（还有更多，nextOffset=${page.nextOffset}）` : ''}`,
    ].join('\n')

    return {
      success: true,
      mode,
      file: fileInfo,
      sheet: usedSheet,
      scannedSheets: sheetNames,
      searchedKeywords: keywords,
      matchMode,
      matchAll: input.matchAll === true,
      scannedRows,
      matchedTotal: matchedPool,
      offset: page.offset,
      returned: page.returned,
      hasMore: page.hasMore,
      nextOffset: page.nextOffset,
      headers: displayHeaders,
      markdown: budgetChars(`${summary}\n\n${markdown}`, 12000, '检索结果'),
      rows: format === 'json' ? page.page : undefined,
      warnings: warnings.length > 0 ? warnings : undefined,
      hint: matchedPool === 0 ? `未在文件中检索到关于 [${keywords.join('、')}] 的数据（已扫描 ${scannedRows} 行数据）` : undefined,
    }
  }

  // ---------------- preview ----------------
  const name = sheetNames[0]
  const table = buildTable(wb.Sheets[name], name, buildOptions)
  if (table.headers.length === 0) {
    return {
      success: true,
      mode,
      file: fileInfo,
      sheet: name,
      headers: [],
      totalDataRows: 0,
      markdown: `工作表 "${name}" 没有可解析的表格内容`,
      notes: pathNote ? [pathNote, ...table.notes] : table.notes,
    }
  }

  const { indices, missing } = resolveColumns(input.columns, table.headers)
  const limit = clampInt(input.limit, 1, 200, 20)
  const offset = clampInt(input.offset, 0, 1_000_000, 0)
  const page = paginate(table.records, offset, limit)

  const displayHeaders = ['Excel行', ...indices.map((i) => table.headers[i])]
  const markdown = toMarkdownTable(
    displayHeaders,
    page.page.map((r) => [String(r.excelRow), ...indices.map((i) => truncateText(r.values[i] ?? '', maxCellChars))]),
  )

  const summary = [
    `文件: ${fileInfo.name} ｜ 工作表: ${name} ｜ 模式: preview`,
    `表头行: 第 ${table.headerRowNumber} 行 ｜ 数据行: ${table.records.length} ｜ 列: ${table.headers.join(' | ')}`,
    `本页: 第 ${page.offset + 1}~${page.offset + page.returned} 行${page.hasMore ? `（nextOffset=${page.nextOffset}）` : '（已到末尾）'}`,
  ].join('\n')

  return {
    success: true,
    mode,
    file: fileInfo,
    sheet: name,
    headerRowNumber: table.headerRowNumber,
    dataStartExcelRow: table.dataStartExcelRow,
    headers: displayHeaders,
    totalDataRows: table.records.length,
    offset: page.offset,
    returned: page.returned,
    hasMore: page.hasMore,
    nextOffset: page.nextOffset,
    markdown: budgetChars(`${summary}\n\n${markdown}`, 12000, '预览结果'),
    rows: format === 'json' ? page.page : undefined,
    warnings: missing.length > 0 ? [`未找到列: ${missing.join('、')}（现有列: ${table.headers.join('、')}）`] : undefined,
    notes: pathNote ? [pathNote, ...table.notes] : table.notes,
  }
}

export const readExcelTool: ToolDefinition = {
  name: 'read_excel',
  description:
    '读取并检索 Excel(.xlsx/.xls/.xlsb/.csv) 文件内容，支持多工作表。三种模式：' +
    'overview=列出所有工作表的表头、数据行数、前置标题行判定（先用它摸清结构）；' +
    'preview=按 offset/limit 分页查看某张表的数据（Markdown 表格）；' +
    'search=按关键词（如学生姓名、学号、班级、考场）检索命中行，返回"工作表+Excel行号+各字段值"，便于引用原始位置。' +
    '自动跳过空行与大标题合并行来定位表头，支持两行分组表头，合并单元格按左上角值填充。' +
    '数值列返回单元格显示文本（保留原文件百分比/金额格式），日期统一归一化为 ISO（如 2024-09-01）；需要底层精确数值时设 rawValues=true。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Excel/CSV 文件路径（相对工作目录或绝对路径）' },
      mode: {
        type: 'string',
        enum: ['overview', 'preview', 'search'],
        description:
          'overview=结构总览（默认）; preview=分页预览数据; search=关键词检索。' +
          '不确定文件结构时先用 overview。',
      },
      sheet: {
        type: ['string', 'number'],
        description:
          '工作表名或 1-based 序号（如 "成绩表" 或 2）。search 模式省略时会检索所有工作表；preview/overview 省略时用第一张。',
      },
      keyword: { type: 'string', description: '单个检索关键词（search 模式），如 "张三"' },
      keywords: {
        type: 'array',
        items: { type: 'string' },
        description: '多个检索关键词（search 模式）。默认 OR 语义（命中任一即算命中），配合 matchAll=true 变为 AND',
      },
      matchMode: {
        type: 'string',
        enum: ['contains', 'exact', 'regex'],
        description: '匹配方式：contains=包含（默认，忽略大小写）; exact=完全相等; regex=正则表达式',
      },
      matchAll: { type: 'boolean', description: 'true 时要求一行同时命中所有关键词（AND）。默认 false（OR）' },
      columns: {
        type: 'array',
        items: { type: 'string' },
        description: '限定检索与输出的列，可写表头名（如 "姓名"）或 1-based 列序号（如 "3"）。省略=全部列',
      },
      headerRow: { type: 'number', description: '手动指定表头所在 Excel 行号（1-based）。仅在自动识别不准确时使用' },
      headerRows: { type: 'number', description: '表头占几行（复合表头如"语文/期中"填 2）。默认自动识别' },
      offset: { type: 'number', description: '分页偏移量（0-based）。preview 按数据行、search 按命中条数' },
      limit: { type: 'number', description: '本页返回的最大条数。preview 默认 20，search 默认 50' },
      maxRows: { type: 'number', description: '最多解析多少行（默认 5000，防超大文件卡死）' },
      maxColumns: { type: 'number', description: '最多解析多少列（默认 30）' },
      maxCellChars: { type: 'number', description: '单个单元格最大字符数（默认 200，超出截断以保护 Token）' },
      includeEmptyRows: { type: 'boolean', description: 'true 时保留完全空白的行。默认 false' },
      rawValues: {
        type: 'boolean',
        description: 'true=返回单元格底层值（精确数值/ISO 日期）；false=返回显示文本（保留原格式）。默认 false',
      },
      format: {
        type: 'string',
        enum: ['markdown', 'json'],
        description: 'markdown=返回可直接展示的表格文本（默认）; json=额外返回结构化行对象数组',
      },
    },
    required: ['path'],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  maxResultChars: 9000,
  execute: wrapExecute(readExcel),
}
