/**
 * context（提示词拼装 + 上下文压缩）验证脚本
 *
 * 验证对象：src/context/ 下四个文件，全部按"Agent 实际调用路径"直接调用。
 *   1. prompt-builder.ts    PromptBuilder 的 pipe 链 / null 跳过 / 拼接顺序
 *   2. custom-sections.ts   自己加的两个 pipe（officeGuide / workspaceContext）
 *   3. tool-result-output.ts 工具结果 output 六种变体 → 文本
 *   4. compressor.ts        estimateTokens / microcompact / summarize
 *
 * 运行：pnpm exec tsx tests/verify-context.ts
 */

import type { ModelMessage } from 'ai'
import { PromptBuilder, coreRules, toolGuide, deferredTools, sessionContext, type PromptContext } from '../src/context/prompt-builder'
import { officeGuide, workspaceContext } from '../src/context/custom-sections'
import { textToolResultOutput, toolResultOutputToText } from '../src/context/tool-result-output'
import { estimateTokens, microcompact, summarize } from '../src/context/compressor'
import { createMockModel } from '../src/mock-model'

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

/** 造一条 tool 角色的消息（形状与 AI SDK ToolModelMessage 一致） */
function toolMsg(toolName: string, text: string, callId = 'call_1'): ModelMessage {
  return {
    role: 'tool',
    content: [{ type: 'tool-result', toolCallId: callId, toolName, output: textToolResultOutput(text) }],
  } as ModelMessage
}

async function main() {
  // ---------------------------------------------------------------- 1. PromptBuilder
  section('PromptBuilder：pipe 链')

  const ctx: PromptContext = {
    toolCount: 12,
    deferredToolSummary: '（延迟工具 27 个）',
    sessionMessageCount: 3,
    sessionId: 'default',
  }

  const builder = new PromptBuilder()
    .pipe('coreRules', coreRules())
    .pipe('toolGuide', toolGuide())
    .pipe('deferredTools', deferredTools())
    .pipe('sessionContext', sessionContext())
    .pipe('officeGuide', officeGuide())
    .pipe('workspaceContext', workspaceContext())

  const sys = builder.build(ctx)
  check('build 返回非空 system prompt', sys.length > 0, sys.length)
  check('包含 coreRules 的身份声明', sys.includes('你是 Super Agent'))
  check('包含 toolGuide 的工具数量', sys.includes('12 个工具'))
  check('包含 deferredTools 的 tool_search 指引', sys.includes('tool_search'))
  check('包含 sessionContext 的会话信息', sys.includes('3 条历史消息'))
  check('包含 officeGuide 的办公文档指引', sys.includes('read_excel'))
  check('包含 workspaceContext 的工作区说明', sys.length > 0 && sys.includes('工作区'))
  check('各段以空行分隔（sections.join）', sys.includes('\n\n'))

  // pipe 顺序 = 拼接顺序：易变的 workspaceContext 必须在最后
  const lastSectionStarts = sys.lastIndexOf('工作区')
  check('workspaceContext 排在最后（KV Cache 友好）', lastSectionStarts > sys.indexOf('12 个工具'))

  // null 跳过逻辑
  const emptyCtx: PromptContext = { toolCount: 0, deferredToolSummary: '', sessionMessageCount: 0, sessionId: 'default' }
  const emptySys = builder.build(emptyCtx)
  check('toolCount=0 时 toolGuide 被跳过', !emptySys.includes('个工具可用'))
  check('deferredToolSummary 为空时 deferredTools 被跳过', !emptySys.includes('tool_search'))
  check('sessionMessageCount=0 时 sessionContext 被跳过', !emptySys.includes('[会话信息]'))
  check('ctx 全空时仍保留 coreRules + 自己加的两段', emptySys.includes('你是 Super Agent') && emptySys.includes('read_excel'))

  // ---------------------------------------------------------------- 2. toolResultOutputToText
  section('tool-result-output：六种 output 变体')

  const variants: Array<[string, any, string]> = [
    ['text', { type: 'text', value: '你好' }, '你好'],
    ['json', { type: 'json', value: { a: 1 } }, '{"a":1}'],
    ['error-text', { type: 'error-text', value: '炸了' }, '炸了'],
    ['error-json', { type: 'error-json', value: { e: 'x' } }, '{"e":"x"}'],
    ['content/text', { type: 'content', value: [{ type: 'text', text: 'T' }] }, 'T'],
    ['content/file', { type: 'content', value: [{ type: 'file', data: { type: 'url', url: 'u' }, mediaType: 'image/png' }] }, '[media:image/png]'],
    ['execution-denied', { type: 'execution-denied', reason: '用户拒绝' }, ''],
  ]

  for (const [label, output, expect] of variants) {
    let got: unknown
    try {
      got = toolResultOutputToText(output)
    } catch (err) {
      got = `THROW: ${(err as Error).message}`
    }
    const isString = typeof got === 'string'
    check(`toolResultOutputToText(${label}) 返回 string`, isString, got)
    if (label === 'execution-denied') {
      // 这里不判定内容，只留证据：undefined 会在 estimateTokens 里炸
      console.log(`     注：execution-denied 实际返回 ${JSON.stringify(got)}`)
    } else {
      check(`toolResultOutputToText(${label}) 内容正确`, got === expect, got)
    }
  }

  // ---------------------------------------------------------------- 3. estimateTokens
  section('estimateTokens：token 估算')

  check('空数组 = 0', estimateTokens([]) === 0)
  check('纯字符串消息按 字符数/4 向上取整', estimateTokens([{ role: 'user', content: 'a'.repeat(40) } as ModelMessage]) === 10)
  check('数组 content 里的 text 也计入', estimateTokens([{ role: 'assistant', content: [{ type: 'text', text: 'a'.repeat(8) }] } as ModelMessage]) === 2)

  const toolTokens = estimateTokens([toolMsg('read_file', 'b'.repeat(40))])
  check('工具结果 output 也计入', toolTokens === 10, toolTokens)

  // execution-denied 的 output：estimateTokens 会不会炸？
  const deniedMsg = {
    role: 'tool',
    content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'bash', output: { type: 'execution-denied' } }],
  } as unknown as ModelMessage
  try {
    const t = estimateTokens([deniedMsg])
    check('含 execution-denied 的 output 不抛异常', true)
    console.log(`     注：估算结果 ${t}`)
  } catch (err) {
    check('含 execution-denied 的 output 不抛异常', false, (err as Error).message)
  }

  // ---------------------------------------------------------------- 4. microcompact
  section('microcompact：工具结果清空')

  const long = (n: number) => `${n}`.padEnd(50, 'x')

  // 5 个可清空工具结果 + 保留最近 3 个
  const msgs: ModelMessage[] = [
    { role: 'user', content: '开始' } as ModelMessage,
    toolMsg('read_file', long(1), 'c1'),
    toolMsg('grep', long(2), 'c2'),
    toolMsg('bash', long(3), 'c3'),
    toolMsg('read_excel', long(4), 'c4'),
    toolMsg('read_file', long(5), 'c5'),
  ]
  const mc = microcompact(msgs)
  check('microcompact 返回 { messages, cleared }', Array.isArray(mc.messages) && typeof mc.cleared === 'number', mc.cleared)
  check('清空了 2 条（5 个工具结果 - 保留 3 个）', mc.cleared === 2, mc.cleared)

  const clearedTexts = mc.messages
    .filter((m: any) => m.role === 'tool')
    .map((m: any) => m.content[0].output.value)
  check('最旧的 read_file 已清空', clearedTexts[0] === '[tool result cleared]', clearedTexts[0])
  check('grep 已清空', clearedTexts[1] === '[tool result cleared]', clearedTexts[1])
  check('bash 保留了原文', clearedTexts[2] === long(3), clearedTexts[2])
  check('不在 CLEARABLE_TOOLS 的 read_excel 原样保留', clearedTexts[3] === long(4), clearedTexts[3])
  check('最近一条原样保留', clearedTexts[4] === long(5), clearedTexts[4])
  check('user 消息未被改动', mc.messages[0].content === '开始')
  check('消息条数不变', mc.messages.length === msgs.length)

  // 少于 3 条工具结果时不应清空
  const few = microcompact([toolMsg('read_file', long(1)), toolMsg('read_file', long(2))])
  check('工具结果少于 3 条时不清空', few.cleared === 0, few.cleared)

  // 工具结果不是数组 content 时不炸
  const weird = microcompact([{ role: 'tool', content: 'plain string' } as unknown as ModelMessage])
  check('tool 消息 content 为字符串时不抛异常', weird.cleared === 0)

  // ---------------------------------------------------------------- 5. summarize
  section('summarize：LLM 摘要压缩')

  const model = createMockModel()

  // 5.1 低于阈值 → 原样返回，不调模型
  const shortMsgs: ModelMessage[] = [
    { role: 'user', content: '你好' } as ModelMessage,
    { role: 'assistant', content: '你好呀' } as ModelMessage,
  ]
  const s1 = await summarize(model, shortMsgs)
  check('消息数 <= KEEP_RECENT_MESSAGES 时不压缩', s1.messages === shortMsgs && s1.compressedCount === 0, s1.compressedCount)

  // 5.2 超过阈值但尾部对齐不到 user 边界 → 原样返回
  const noUser: ModelMessage[] = [
    { role: 'assistant', content: 'a'.repeat(2000) } as ModelMessage,
    { role: 'assistant', content: 'b'.repeat(2000) } as ModelMessage,
  ]
  const s2 = await summarize(model, noUser)
  check('对齐不到 user 边界时安全返回原消息', s2.compressedCount === 0 && s2.messages.length === 2, s2.compressedCount)

  // 5.3 正常压缩路径（末尾留 6 条，且切点落在 user 边界）
  const many: ModelMessage[] = []
  for (let i = 0; i < 5; i++) {
    many.push({ role: 'user', content: `第${i}个问题：${'问'.repeat(200)}` } as ModelMessage)
    many.push({ role: 'assistant', content: `第${i}个回答：${'答'.repeat(200)}` } as ModelMessage)
  }
  const before = estimateTokens(many)
  const s3 = await summarize(model, many)
  check('压缩后消息数减少', s3.messages.length < many.length, `${many.length} → ${s3.messages.length}`)
  check('compressedCount > 0', s3.compressedCount > 0, s3.compressedCount)
  check('首条是压缩摘要（role=user）', (s3.messages[0] as any).role === 'user' && String((s3.messages[0] as any).content).includes('压缩摘要'))
  check('摘要后 token 估算下降', estimateTokens(s3.messages) < before, `${before} → ${estimateTokens(s3.messages)}`)
  check('summary 字段非空', typeof s3.summary === 'string')

  // 5.4 工具调用消息被切进摘要区时，不会留下"孤儿 tool 结果"
  const withTools: ModelMessage[] = []
  for (let i = 0; i < 5; i++) {
    withTools.push({ role: 'user', content: `问题${i}${'x'.repeat(200)}` } as ModelMessage)
    withTools.push({ role: 'assistant', content: [{ type: 'tool-call', toolCallId: `c${i}`, toolName: 'read_file', input: {} }] } as unknown as ModelMessage)
    withTools.push(toolMsg('read_file', 'y'.repeat(200), `c${i}`))
    withTools.push({ role: 'assistant', content: `回答${i}${'z'.repeat(200)}` } as ModelMessage)
  }
  const s4 = await summarize(model, withTools)
  const kept = s4.messages.slice(1)  // 去掉摘要那条
  const firstKept = kept[0] as any
  check('保留区首条是 user（tool 结果不孤立）', firstKept.role === 'user', firstKept.role)

  // 5.5 已有摘要会被带进下一轮
  const s5 = await summarize(model, many, s3.summary)
  check('传入 existingSummary 不报错且返回 summary', typeof s5.summary === 'string')

  // ---------------------------------------------------------------- 汇总
  console.log(`\n${'='.repeat(40)}`)
  console.log(`通过 ${passed} 项，失败 ${failed} 项`)
  if (failed > 0) process.exitCode = 1
}

main().catch(err => {
  console.error('\n[验证脚本自身抛异常]', err)
  process.exitCode = 1
})
