/**
 * 生成验证夹具（故意做成"脏数据"）：
 *   - 大标题合并行 + 空行 + 两行复合表头（横向/纵向合并）
 *   - 中途重复的表头行（跨页打印）、完全空白行
 *   - 公式单元格（带缓存值）、日期单元格、空单元格、学号用数字存储
 *   - 多工作表 + 空工作表 + 前置空行的工作表
 *   - 旧版 .xls（BIFF8）与 .csv
 *   - 中文 .docx（自建 ZIP：无第三方依赖，用于验证标题样式映射与表格还原）
 *
 * 运行：pnpm exec tsx tests/make-fixtures.ts
 */

import * as XLSX from 'xlsx'
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const OUT = join(process.cwd(), 'tests', 'fixtures')
mkdirSync(OUT, { recursive: true })

// ---------------------------------------------------------------------------
// 1. 脏数据 Excel
// ---------------------------------------------------------------------------
{
  // 第 1 行：大标题（A1:J1 合并）；第 2 行空行留白；第 3~4 行：两行复合表头
  const rows: unknown[][] = [
    ['2024学年第一学期期末考试成绩汇总表'],
    [],
    ['学号', '姓名', '语文', null, '数学', null, '班级', '考场', '总分', '报名日期'],
    [null, null, '期中', '期末', '期中', '期末', null, null, null, null],
    [20240101, '张三', 88, 92, 79, 85, '高一(1)班', '第3考场', null, new Date(2024, 8, 1)],
    [20240102, '李四', 76.5, 81, 90, 88.5, '高一(1)班', '第3考场', null, new Date(2024, 8, 1)],
    [], // 空行
    ['学号', '姓名', '语文', '语文', '数学', '数学', '班级', '考场', '总分', '报名日期'], // 跨页重复表头
    [20240103, '王五', 90, 95, 88, 91, '高一(2)班', '第5考场', null, new Date(2024, 8, 2)],
    [20240104, '赵六', null, 66, 72, null, '高一(2)班', '第5考场', null, null], // 含空单元格
  ]
  const ws = XLSX.utils.aoa_to_sheet(rows)

  ws['!merges'] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: 9 } }, // 大标题
    { s: { r: 2, c: 0 }, e: { r: 3, c: 0 } }, // 学号（纵向合并）
    { s: { r: 2, c: 1 }, e: { r: 3, c: 1 } }, // 姓名
    { s: { r: 2, c: 2 }, e: { r: 2, c: 3 } }, // 语文（横向合并）
    { s: { r: 2, c: 4 }, e: { r: 2, c: 5 } }, // 数学（横向合并）
    { s: { r: 2, c: 6 }, e: { r: 3, c: 6 } }, // 班级
    { s: { r: 2, c: 7 }, e: { r: 3, c: 7 } }, // 考场
    { s: { r: 2, c: 8 }, e: { r: 3, c: 8 } }, // 总分
    { s: { r: 2, c: 9 }, e: { r: 3, c: 9 } }, // 报名日期
  ]

  // 公式单元格（带 Excel 写入的缓存值，模拟真实文件）
  ws['I5'] = { t: 'n', f: 'SUM(C5:F5)', v: 344 }
  ws['I6'] = { t: 'n', f: 'SUM(C6:F6)', v: 336 }
  ws['I9'] = { t: 'n', f: 'SUM(C9:F9)', v: 364 }
  ws['!cols'] = [{ wch: 12 }, { wch: 10 }, { wch: 8 }, { wch: 8 }, { wch: 8 }, { wch: 8 }, { wch: 12 }, { wch: 10 }, { wch: 8 }, { wch: 12 }]

  // 第 2 张表：结构简单、用于跨表检索（张三 同时出现在两张表）
  const kaochang = XLSX.utils.aoa_to_sheet([
    ['考场', '班级', '学号', '姓名', '座位号'],
    ['第3考场', '高一(1)班', 20240101, '张三', 12],
    ['第3考场', '高一(1)班', 20240102, '李四', 13],
    ['第5考场', '高一(2)班', 20240103, '王五', 7],
    ['第5考场', '高一(2)班', 20240104, '赵六', 8],
  ])

  // 第 3 张表：前置 3 行空行，表头在第 4 行
  const linshi = XLSX.utils.aoa_to_sheet([
    [],
    [],
    [],
    ['序号', '姓名', '备注'],
    [1, '张三', '已缴费'],
    [2, '周七', '未缴费'],
  ])

  // 第 4 张表：完全空白
  const empty = XLSX.utils.aoa_to_sheet([[]])

  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, '成绩汇总')
  XLSX.utils.book_append_sheet(wb, kaochang, '考场安排')
  XLSX.utils.book_append_sheet(wb, linshi, '临时名单')
  XLSX.utils.book_append_sheet(wb, empty, '空表')

  writeFileSync(join(OUT, '成绩表-脏数据.xlsx'), XLSX.write(wb, { bookType: 'xlsx', type: 'buffer', cellDates: true }))

  // 旧版 .xls（BIFF8）
  const legacy = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(
    legacy,
    XLSX.utils.aoa_to_sheet([
      ['学号', '姓名', '班级', '考场'],
      [20240101, '张三', '高一(1)班', '第3考场'],
    ]),
    '旧版成绩',
  )
  writeFileSync(join(OUT, '旧版成绩.xls'), XLSX.write(legacy, { bookType: 'biff8', type: 'buffer' }))
}

// ---------------------------------------------------------------------------
// 2. CSV
// ---------------------------------------------------------------------------
{
  const csv = ['姓名,班级,考场,座位号', '张三,高一(1)班,第3考场,12', '李四,高一(1)班,第3考场,13', '周七,高一(3)班,第1考场,4'].join('\n')
  writeFileSync(join(OUT, '名单.csv'), '\uFEFF' + csv, 'utf-8')
}

// ---------------------------------------------------------------------------
// 3. 中文 docx（手写最小 ZIP，避免引入额外依赖）
// ---------------------------------------------------------------------------

/** 极简 ZIP 打包器（store 模式，够 Word 解析器使用） */
function zip(files: Array<{ name: string; content: string }>): Buffer {
  const crc32 = (buf: Buffer): number => {
    let crc = 0xffffffff
    for (const byte of buf) {
      crc ^= byte
      for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
    }
    return (crc ^ 0xffffffff) >>> 0
  }

  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0

  for (const file of files) {
    const nameBuf = Buffer.from(file.name, 'utf-8')
    const data = Buffer.from(file.content, 'utf-8')
    const crc = crc32(data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0x0800, 6) // UTF-8 flag
    local.writeUInt16LE(0, 8) // store
    local.writeUInt16LE(0, 10) // time
    local.writeUInt16LE(0x2821, 12) // date(2000-01-01)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, nameBuf, data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4) // version made by
    central.writeUInt16LE(20, 6) // version needed
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0x2821, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBuf)

    offset += local.length + nameBuf.length + data.length
  }

  const centralBuf = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)
  return Buffer.concat([...locals, centralBuf, eocd])
}

function docx(documentXml: string, stylesXml: string): Buffer {
  return zip([
    {
      name: '[Content_Types].xml',
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`,
    },
    {
      name: '_rels/.rels',
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
    },
    {
      name: 'word/_rels/document.xml.rels',
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
    },
    { name: 'word/styles.xml', content: stylesXml },
    { name: 'word/document.xml', content: documentXml },
  ])
}

const p = (text: string, styleId?: string) =>
  `<w:p>${styleId ? `<w:pPr><w:pStyle w:val="${styleId}"/></w:pPr>` : ''}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`

const cell = (text: string) => `<w:tc><w:tcPr/><w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p></w:tc>`
const row = (...cells: string[]) => `<w:tr>${cells.map(cell).join('')}</w:tr>`

{
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>
<w:style w:type="paragraph" w:styleId="Biaoti2"><w:name w:val="标题 2"/></w:style>
<w:style w:type="paragraph" w:styleId="Biaoti3"><w:name w:val="标题 3"/></w:style>
</w:styles>`

  const body = [
    p('关于2024学年第一学期期末考试安排的通知', 'Heading1'),
    p('各班级、各位同学：'),
    p('现将本次期末考试考场安排及相关要求通知如下，请遵照执行。'),
    p('一、考试时间', 'Biaoti2'),
    p('2024年11月4日至11月6日，每天上午9:00开始。'),
    p('二、考场分配', 'Biaoti2'),
    p('具体考场分配见下表：'),
    `<w:tbl>${row('考场', '班级', '学号', '姓名', '座位号')}${row('第3考场', '高一(1)班', '20240101', '张三', '12')}${row('第3考场', '高一(1)班', '20240102', '李四', '13')}${row('第5考场', '高一(2)班', '20240103', '王五', '7')}</w:tbl>`,
    p('三、注意事项', 'Biaoti2'),
    p('1. 考生须携带准考证入场；'),
    p('2. 开考15分钟后不得入场；'),
    p('3. 张三、李四两位同学需提前30分钟到考务室报到。'),
    p('考务办公室', 'Biaoti3'),
    p('2024年10月28日'),
  ].join('')

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`

  writeFileSync(join(OUT, '考试安排通知.docx'), docx(documentXml, styles))
}

// ---------------------------------------------------------------------------
// 4. PDF（手写最小 PDF，用于验证按页提取、页码引用与检索）
// ---------------------------------------------------------------------------
{
  /** 生成一个多页 PDF，每页一段 ASCII 文本 */
  function buildPdf(pages: string[]): Buffer {
    const fontObjNum = 3 + pages.length * 2
    const objects: Array<{ num: number; body: string }> = [
      { num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
      {
        num: 2,
        body: `<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + i * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`,
      },
    ]

    pages.forEach((text, i) => {
      const pageNum = 3 + i * 2
      const contentNum = pageNum + 1
      const escaped = text.replace(/([()\\])/g, '\\$1')
      const stream = `BT /F1 12 Tf 72 760 Td (${escaped}) Tj ET`
      objects.push({
        num: pageNum,
        body: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontObjNum} 0 R >> >> /Contents ${contentNum} 0 R >>`,
      })
      objects.push({ num: contentNum, body: `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream` })
    })

    objects.push({ num: fontObjNum, body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>' })
    objects.sort((a, b) => a.num - b.num)

    let pdf = '%PDF-1.4\n'
    const offsets = new Map<number, number>()
    for (const obj of objects) {
      offsets.set(obj.num, Buffer.byteLength(pdf, 'latin1'))
      pdf += `${obj.num} 0 obj\n${obj.body}\nendobj\n`
    }

    const xrefOffset = Buffer.byteLength(pdf, 'latin1')
    const maxNum = fontObjNum
    pdf += `xref\n0 ${maxNum + 1}\n0000000000 65535 f \n`
    for (let n = 1; n <= maxNum; n++) {
      const off = offsets.get(n) ?? 0
      pdf += `${String(off).padStart(10, '0')} 00000 n \n`
    }
    pdf += `trailer\n<< /Size ${maxNum + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
    return Buffer.from(pdf, 'latin1')
  }

  writeFileSync(
    join(OUT, '考场安排.pdf'),
    buildPdf([
      'Exam Arrangement Notice 2024 - Page one. Room 3: Zhang San, Li Si. Room 5: Wang Wu.',
      'Page two continues: candidates must arrive 30 minutes early. Contact: Zhang San.',
      'Page three appendix: seat numbers 12, 13, 7, 8.',
    ]),
  )
}

// ---------------------------------------------------------------------------
// 5. 工作区样本：验证"直接说文件名"的相对路径锚定
// ---------------------------------------------------------------------------
{
  const WS = join(process.cwd(), 'workspace')
  mkdirSync(join(WS, '2024级'), { recursive: true })
  copyFileSync(join(OUT, '成绩表-脏数据.xlsx'), join(WS, '成绩表-脏数据.xlsx'))
  copyFileSync(join(OUT, '考试安排通知.docx'), join(WS, '考试安排通知.docx'))
  copyFileSync(join(OUT, '名单.csv'), join(WS, '2024级', '名单.csv'))
  console.log(`工作区样本已放置: ${WS}`)
}

console.log(`夹具已生成: ${OUT}`)
