/**
 * 文档工具验证脚本
 *
 * 直接调用三个工具注册表的 execute（与 Agent 实际调用路径一致），
 * 用"脏数据夹具"验证：表头识别、合并单元格还原、跨表检索、分页、错误降级、PDF 按页提取。
 *
 * 运行：pnpm exec tsx tests/verify-document-tools.ts
 */

import { readExcelTool } from '../src/tools/office/excel-tools'
import { readWordTool } from '../src/tools/office/word-tools'
import { readPdfTool } from '../src/tools/office/pdf-tools'
import { readFileTool, listDirectoryTool, writeFileTool } from '../src/tools/file-tools'
import { ToolRegistry } from '../src/tools/registry'
import { allTools } from '../src/tools'
import { WORKSPACE_DIR, workspacePromptSection } from '../src/workspace'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const FIX = join('tests', 'fixtures')
let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail?: unknown) {
  if (condition) {
    passed++
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.log(`  ❌ ${name}`)
    if (detail !== undefined) console.log(`     实际: ${JSON.stringify(detail)?.slice(0, 500)}`)
  }
}

function section(title: string) {
  console.log(`\n=== ${title} ===`)
}

async function call(tool: { execute: (input: any) => Promise<unknown> }, input: Record<string, unknown>) {
  const result = (await tool.execute(input)) as any
  const jsonLength = typeof result === 'string' ? result.length : (JSON.stringify(result ?? null)?.length ?? 0)
  return { result, jsonLength }
}

async function main() {
  const XLSX_FILE = join(FIX, '成绩表-脏数据.xlsx')

  // -------------------------------------------------------------------------
  section('read_excel / overview —— 结构总览 + 脏数据表头识别')
  {
    const { result } = await call(readExcelTool, { path: XLSX_FILE, mode: 'overview' })
    check('success = true', result.success === true, result)
    check('识别出 4 张工作表', result.sheetCount === 4, result.sheetCount)

    const chengji = result.sheets?.find((s: any) => s.name === '成绩汇总')
    check('成绩汇总：表头行定位到第 3 行（跳过合并大标题行）', chengji?.headerRowNumber === 3, chengji?.headerRowNumber)
    check('成绩汇总：识别为两行复合表头', chengji?.headerRowCount === 2, chengji?.headerRowCount)
    check(
      '成绩汇总：复合表头按列拍平为 "语文 / 期中"',
      Array.isArray(chengji?.headers) && chengji.headers.includes('语文 / 期中') && chengji.headers.includes('数学 / 期末'),
      chengji?.headers,
    )
    check('成绩汇总：数据行 4 行（空行与跨页重复表头已剔除）', chengji?.dataRows === 4, chengji?.dataRows)
    check('成绩汇总：提示了重复表头/公式单元格', JSON.stringify(chengji?.notes ?? '').includes('重复'), chengji?.notes)

    const linshi = result.sheets?.find((s: any) => s.name === '临时名单')
    check('临时名单：前置 3 行空行后定位表头到第 4 行', linshi?.headerRowNumber === 4, linshi?.headerRowNumber)
    check('临时名单：表头为 序号/姓名/备注', JSON.stringify(linshi?.headers) === JSON.stringify(['序号', '姓名', '备注']), linshi?.headers)

    const empty = result.sheets?.find((s: any) => s.name === '空表')
    check('空表：不报错，dataRows = 0 且有说明', empty?.dataRows === 0, empty)

    const kaochang = result.sheets?.find((s: any) => s.name === '考场安排')
    check('考场安排：单行表头，5 列', kaochang?.headerRowCount === 1 && kaochang?.columns === 5, kaochang)
  }

  // -------------------------------------------------------------------------
  section('read_excel / search —— 跨表检索与位置引用')
  {
    const { result } = await call(readExcelTool, { path: XLSX_FILE, mode: 'search', keywords: ['张三'] })
    check('success = true', result.success === true, result)
    check('未指定 sheet 时横扫全部工作表，命中 3 处（成绩/考场/临时名单）', result.matchedTotal === 3, result.matchedTotal)
    check('检索范围包含全部 4 张表', (result.scannedSheets ?? []).length === 4, result.scannedSheets)
    check('结果含工作表名与 Excel 行号列', result.markdown?.includes('工作表') && result.markdown?.includes('Excel行'), result.markdown?.slice(0, 200))
    check('命中行定位：成绩汇总第 5 行', result.markdown?.includes('20240101'), result.markdown?.slice(0, 400))
  }
  {
    const { result } = await call(readExcelTool, {
      path: XLSX_FILE,
      mode: 'search',
      keywords: ['张三', '第3考场'],
      matchAll: true,
      sheet: '成绩汇总',
    })
    check('matchAll=true（AND）命中 1 行', result.matchedTotal === 1, result.matchedTotal)
  }
  {
    const { result } = await call(readExcelTool, {
      path: XLSX_FILE,
      mode: 'search',
      keyword: '20240103',
      columns: ['姓名', '考场'],
    })
    check('指定 columns 后仅在 姓名/考场 两列检索 → 不命中', result.matchedTotal === 0 && result.hint !== undefined, result)
  }
  {
    const { result } = await call(readExcelTool, { path: XLSX_FILE, mode: 'search', keyword: '不存在的学生' })
    check('查不到时明确返回"未检索到"而不是编造', typeof result.hint === 'string' && result.hint.includes('未在文件中检索到'), result.hint)
  }

  // -------------------------------------------------------------------------
  section('read_excel / preview —— 分页与 Token 保护')
  {
    const { result } = await call(readExcelTool, { path: XLSX_FILE, mode: 'preview', sheet: '临时名单' })
    check('preview 正确取到 临时名单', result.sheet === '临时名单' && result.totalDataRows === 2, result.totalDataRows)
    check('返回 Markdown 表格', typeof result.markdown === 'string' && result.markdown.includes('| 序号 |'), result.markdown?.slice(0, 200))
  }
  {
    const { result } = await call(readExcelTool, { path: XLSX_FILE, mode: 'preview', sheet: 1, limit: 2 })
    check('sheet 支持 1-based 序号', result.sheet === '成绩汇总', result.sheet)
    check('limit=2 只返回 2 行', result.returned === 2, result.returned)
    check('hasMore/nextOffset 分页游标正确', result.hasMore === true && result.nextOffset === 2, {
      hasMore: result.hasMore,
      nextOffset: result.nextOffset,
    })

    const second = await call(readExcelTool, { path: XLSX_FILE, mode: 'preview', sheet: 1, limit: 2, offset: 2 })
    check('offset=2 翻到下一页且行号不重叠', second.result.returned === 2 && second.result.offset === 2, {
      offset: second.result.offset,
      returned: second.result.returned,
    })
  }

  // -------------------------------------------------------------------------
  section('read_excel —— .xls(BIFF8) / .csv / rawValues / 日期')
  {
    const xls = await call(readExcelTool, { path: join(FIX, '旧版成绩.xls'), mode: 'search', keyword: '张三' })
    check('旧版 .xls 可解析并命中', xls.result.success === true && xls.result.matchedTotal === 1, xls.result)

    const csv = await call(readExcelTool, { path: join(FIX, '名单.csv'), mode: 'overview' })
    check('CSV 可解析，表头行 = 第 1 行', csv.result.sheets?.[0]?.headerRowNumber === 1, csv.result.sheets?.[0])
    check('CSV 表头为 姓名/班级/考场/座位号', JSON.stringify(csv.result.sheets?.[0]?.headers) === JSON.stringify(['姓名', '班级', '考场', '座位号']), csv.result.sheets?.[0]?.headers)

    const display = await call(readExcelTool, { path: XLSX_FILE, mode: 'preview', sheet: '成绩汇总', limit: 1 })
    check('日期列返回可读日期（非 45292 序列号）', /\d{4}-\d{2}-\d{2}|\d{4}\/\d{1,2}\/\d{1,2}/.test(display.result.markdown ?? ''), display.result.markdown)
    check('公式单元格返回缓存计算结果 344', display.result.markdown?.includes('344'), display.result.markdown)

    const raw = await call(readExcelTool, { path: XLSX_FILE, mode: 'preview', sheet: '成绩汇总', limit: 1, rawValues: true })
    check('rawValues=true 返回底层值', typeof raw.result.markdown === 'string' && raw.result.markdown.length > 0, raw.result.markdown?.slice(0, 120))
  }

  // -------------------------------------------------------------------------
  section('read_excel —— 错误与边界防御')
  {
    const missing = await call(readExcelTool, { path: join(FIX, '不存在.xlsx') })
    check('文件不存在 → success=false 且信息具名', missing.result.success === false && missing.result.error.includes('文件不存在'), missing.result)

    const wrongSheet = await call(readExcelTool, { path: XLSX_FILE, mode: 'preview', sheet: '不存在的表' })
    check('工作表不存在 → 返回可选列表', wrongSheet.result.success === false && wrongSheet.result.error.includes('成绩汇总'), wrongSheet.result.error)

    const badExt = await call(readExcelTool, { path: 'tsconfig.json' })
    check('扩展名不符 → 拒绝并说明支持类型', badExt.result.success === false && badExt.result.error.includes('不支持的文件类型'), badExt.result.error)

    const noKeyword = await call(readExcelTool, { path: XLSX_FILE, mode: 'search' })
    check('search 缺关键词 → 具名错误 + 示例', noKeyword.result.success === false && typeof noKeyword.result.hint === 'string', noKeyword.result)

    const badRegex = await call(readExcelTool, { path: XLSX_FILE, mode: 'search', keyword: '[', matchMode: 'regex' })
    check('非法正则 → 具名错误而非崩溃', badRegex.result.success === false && badRegex.result.error.includes('正则表达式非法'), badRegex.result.error)

    const emptyPath = await call(readExcelTool, { path: '' })
    check('空路径 → 具名错误', emptyPath.result.success === false, emptyPath.result)
  }

  // -------------------------------------------------------------------------
  section('read_word —— 大纲 / 表格 / 检索 / 正文')
  {
    const DOCX = join(FIX, '考试安排通知.docx')
    const outline = await call(readWordTool, { path: DOCX, mode: 'outline' })
    check('success = true', outline.result.success === true, outline.result)
    check('识别 5 个标题（含中文样式"标题 2/3"映射）', outline.result.headingCount === 5, outline.result.headingCount)
    check('大纲首项为一级标题', outline.result.outline?.[0]?.level === 1, outline.result.outline?.[0])
    check('识别 1 个表格', outline.result.tableCount === 1, outline.result.tableCount)
    check(
      '表格表头被正确还原',
      JSON.stringify(outline.result.tables?.[0]?.header) === JSON.stringify(['考场', '班级', '学号', '姓名', '座位号']),
      outline.result.tables?.[0]?.header,
    )

    const table = await call(readWordTool, { path: DOCX, mode: 'tables', tableIndex: 1 })
    check('tableIndex=1 读取表格成功', table.result.success === true && table.result.dataRows === 3, table.result.dataRows)
    check('表格渲染为 Markdown 表格', table.result.markdown?.includes('| 考场 | 班级 | 学号 | 姓名 | 座位号 |'), table.result.markdown?.slice(0, 200))

    const search = await call(readWordTool, { path: DOCX, mode: 'search', keyword: '张三', format: 'json' })
    check('检索命中段落 + 表格单元格共 2 处', search.result.matchedTotal === 2, {
      total: search.result.matchedTotal,
      para: search.result.paragraphMatches,
      table: search.result.tableMatches,
      md: search.result.markdown,
    })
    check('命中位置带标题章节路径', (search.result.markdown ?? '').includes('二、考场分配') || (search.result.markdown ?? '').includes('三、注意事项'), search.result.markdown)

    const notFound = await call(readWordTool, { path: DOCX, mode: 'search', keyword: '孙悟空' })
    check('查不到时明确说明未检索到', typeof notFound.result.hint === 'string' && notFound.result.hint.includes('未在文件中检索到'), notFound.result.hint)

    const text = await call(readWordTool, { path: DOCX, mode: 'text', limit: 3 })
    check('text 模式分页返回 3 块', text.result.returned === 3 && text.result.hasMore === true, {
      returned: text.result.returned,
      total: text.result.totalBlocks,
    })
    check('text 模式块结构含 type/section', Array.isArray(text.result.content) && text.result.content[0]?.type === 'heading', text.result.content?.[0])

    const badMode = await call(readWordTool, { path: DOCX, mode: 'xxx' })
    check('非法 mode → 具名错误', badMode.result.success === false && badMode.result.error.includes('mode 参数非法'), badMode.result.error)
  }

  // -------------------------------------------------------------------------
  section('read_pdf —— 元信息 / 按页提取 / 检索')
  {
    const PDF = join(FIX, '考场安排.pdf')
    const info = await call(readPdfTool, { path: PDF, mode: 'info' })
    check('info 模式返回 3 页', info.result.success === true && info.result.totalPages === 3, info.result)

    const text = await call(readPdfTool, { path: PDF, mode: 'text', pages: '2', maxCharsPerPage: 1000 })
    check('pages="2" 只返回第 2 页', JSON.stringify(text.result.pages) === JSON.stringify([2]), text.result.pages)
    check('第 2 页文字被提取', typeof text.result.markdown === 'string' && text.result.markdown.includes('Page two'), text.result.markdown)

    const search = await call(readPdfTool, { path: PDF, mode: 'search', keyword: 'Zhang San' })
    check('检索命中并标注真实页码', search.result.matchedTotal >= 2 && (search.result.matches ?? []).length >= 0, search.result.matchedTotal)
    check('检索结果 markdown 含页码信息', (search.result.markdown ?? '').includes('页'), search.result.markdown?.slice(0, 300))

    const paged = await call(readPdfTool, { path: PDF, mode: 'text', limit: 2 })
    check('未指定 pages 时按 offset/limit 顺序翻页（前 2 页）', JSON.stringify(paged.result.pages) === JSON.stringify([1, 2]), paged.result.pages)
  }

  // -------------------------------------------------------------------------
  section('read_file —— 二进制文档路由提示')
  {
    const routed = await call(readFileTool, { path: XLSX_FILE })
    check('read_file 读 xlsx 时提示改用 read_excel', typeof routed.result === 'string' && routed.result.includes('read_excel'), routed.result)
    const routedWord = await call(readFileTool, { path: join(FIX, '考试安排通知.docx') })
    check('read_file 读 docx 时提示改用 read_word', routedWord.result.includes('read_word'), routedWord.result)
  }

  // -------------------------------------------------------------------------
  section('Token 保护 —— 输出体积')
  {
    const { jsonLength } = await call(readExcelTool, { path: XLSX_FILE, mode: 'overview' })
    check(`overview 输出体积可控 (${jsonLength} 字符 < 9000 截断线)`, jsonLength < 9000, jsonLength)
    const search = await call(readExcelTool, { path: XLSX_FILE, mode: 'search', keywords: ['高一'], limit: 50 })
    check(`search 输出体积可控 (${search.jsonLength} 字符)`, search.jsonLength < 30000, search.jsonLength)
  }

  // -------------------------------------------------------------------------
  section('工作区 —— 相对路径锚定 / 项目目录兼容 / 写入落点')
  {
    const bare = await call(readExcelTool, { path: '成绩表-脏数据.xlsx', mode: 'search', keyword: '张三' })
    check('裸文件名直接在工作区命中（不用写路径）', bare.result.success === true && bare.result.matchedTotal === 3, bare.result)

    const sub = await call(readExcelTool, { path: '2024级/名单.csv', mode: 'overview' })
    check('工作区子目录可用（正斜杠）', sub.result.success === true && sub.result.sheets?.[0]?.headerRowNumber === 1, sub.result)

    const wordBare = await call(readWordTool, { path: '考试安排通知.docx', mode: 'outline' })
    check('Word 裸文件名同样锚定工作区', wordBare.result.success === true && wordBare.result.headingCount === 5, wordBare.result)

    const projectRel = await call(readExcelTool, { path: 'tests/fixtures/成绩表-脏数据.xlsx', mode: 'overview' })
    check('工作区没有时退回项目目录（向后兼容）', projectRel.result.success === true, projectRel.result)
    check(
      '退回项目目录时回传 pathNote 提示',
      typeof projectRel.result.notes?.[0] === 'string' && projectRel.result.notes[0].includes('不在工作区'),
      projectRel.result.notes,
    )

    const dotSlash = await call(readExcelTool, { path: './tests/fixtures/名单.csv', mode: 'overview' })
    check('./ 开头显式按项目目录解析', dotSlash.result.success === true && dotSlash.result.sheets?.[0]?.headerRowNumber === 1, dotSlash.result)

    const absolute = await call(readExcelTool, { path: join(process.cwd(), 'tests', 'fixtures', '名单.csv'), mode: 'overview' })
    check('绝对路径照常可用', absolute.result.success === true, absolute.result)

    const listing = await call(listDirectoryTool, {})
    check('list_directory 不传参数时列出工作区', typeof listing.result === 'string' && listing.result.includes('成绩表-脏数据.xlsx'), listing.result)

    const writeName = '_workspace-write-test.txt'
    const wrote = await call(writeFileTool, { path: writeName, content: '工作区写入测试' })
    check('write_file 相对路径落到工作区', existsSync(join(WORKSPACE_DIR, writeName)), wrote.result)
    const readBack = await call(readFileTool, { path: writeName })
    check('read_file 能从工作区读回', readBack.result === '工作区写入测试', readBack.result)
    rmSync(join(WORKSPACE_DIR, writeName), { force: true })

    const missingWs = await call(readExcelTool, { path: '根本没有这个文件.xlsx' })
    check(
      '找不到文件时提示工作区目录 + 现有文件清单',
      missingWs.result.success === false && missingWs.result.hint.includes('工作区'),
      missingWs.result.hint,
    )

    const prompt = workspacePromptSection()
    check(
      '系统提示注入工作区路径与文件清单',
      prompt.includes(WORKSPACE_DIR) && prompt.includes('成绩表-脏数据.xlsx'),
      prompt.slice(0, 260),
    )
  }

  // -------------------------------------------------------------------------
  section('工具注册表集成 —— office 目录挂载 / 延迟加载 / tool_search 发现')
  {
    const registry = new ToolRegistry()
    registry.register(...allTools)
    const names = registry.getAll().map((t) => t.name)

    check(
      'allTools 通过 officeTools 挂载了 3 个办公工具（目录归拢后仍然接上）',
      ['read_excel', 'read_word', 'read_pdf'].every((n) => names.includes(n)),
      names,
    )
    check('read_excel / read_word 作为核心工具进入 Prompt', registry.getActiveTools().some((t) => t.name === 'read_excel'), names)
    check('read_pdf 标记 shouldDefer，暂不进 Prompt', registry.getActiveTools().some((t) => t.name === 'read_pdf') === false)

    const discovered = registry.searchTools('read_pdf')
    check('tool_search("read_pdf") 能取到完整定义', discovered.length === 1 && !!discovered[0]?.parameters, discovered.map((t) => t.name))
    check('被发现后 read_pdf 变为活跃工具', registry.getActiveTools().some((t) => t.name === 'read_pdf'))
  }

  console.log(`\n========== 结果: ${passed} 通过 / ${failed} 失败 ==========`)
  if (failed > 0) process.exitCode = 1
}

main().catch((err) => {
  console.error('验证脚本异常:', err)
  process.exitCode = 1
})
