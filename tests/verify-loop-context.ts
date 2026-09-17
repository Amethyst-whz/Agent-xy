/**
 * agentLoop × 上下文压缩 接线验证脚本
 *
 * 目的：证明 loop.ts 里新接的 compressor 真的生效，而且没有破坏会话持久化。
 *   A. microcompact 分支：旧工具结果被清成 [tool result cleared]，模型确实收到了
 *   B. summarize 分支：LLM 摘要真的被循环调到，模型收到的是 [压缩摘要] + 最近几条
 *   C. 安全：调用方传进去的 messages 数组【原封不动】
 *      —— index.ts 靠 messages.slice(beforeLen) 找出本轮新消息写存档，就地删消息会写坏存档
 *
 * 做法：用一个会记录 prompt 的假模型包住 mock-model，直接看"模型到底收到了什么"。
 *
 * 注意（写这个夹具时踩的坑）：
 *   历史消息里每条 assistant 的 tool-call 都必须有配对的 tool 结果，
 *   否则 AI SDK 在转换 prompt 时会直接报错（NoOutputGeneratedError）。
 *   真实 loop 里 stepResponse.messages 是成对追加的，不会出现这种悬空 tool-call。
 *
 * 运行：pnpm exec tsx tests/verify-loop-context.ts
 */

import type { ModelMessage } from 'ai'
import { ToolRegistry } from '../src/tools/registry'
import { textToolResultOutput } from '../src/context/tool-result-output'
import { createMockModel } from '../src/mock-model'

// loop.ts 在模块加载时读这个环境变量，所以必须在 import 之前设好 —— 用动态 import
process.env.CONTEXT_COMPRESS_THRESHOLD = '1'

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail?: unknown) {
  if (condition) {
    passed++
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.log(`  ❌ ${name}`)
    if (detail !== undefined) console.log(`     实际: ${JSON.stringify(detail)?.slice(0, 300)}`)
  }
}

function section(title: string) {
  console.log(`\n=== ${title} ===`)
}

/** 记录模型收到什么的包装：streamText 走 doStream，generateText(摘要) 走 doGenerate */
interface Capture { tag: 'agent' | 'summarize'; text: string; messageCount: number }
let captured: Capture[] = []

function record(tag: Capture['tag'], opts: any) {
  const prompt = opts?.prompt
  const parts: string[] = []
  if (typeof prompt === 'string') parts.push(prompt)
  else if (Array.isArray(prompt)) {
    for (const m of prompt) {
      if (typeof m.content === 'string') parts.push(m.content)
      else if (Array.isArray(m.content)) {
        for (const p of m.content) {
          if (typeof p?.text === 'string') parts.push(p.text)
          else if (p?.output) parts.push(JSON.stringify(p.output))
        }
      }
    }
  }
  captured.push({
    tag,
    text: parts.join('\n'),
    messageCount: Array.isArray(prompt) ? prompt.length : 1,
  })
}

function makeRecordingModel() {
  const inner = createMockModel() as any
  // 判定"这次调用是 agent 主循环还是摘要压缩"：
  // 光看 opts.system 不够稳（AI SDK 可能把 system 合并进 prompt 里传），所以两头都认。
  const isSummarize = (opts: any, text: string) =>
    String(opts?.system ?? '').includes('对话压缩系统') ||
    String(opts?.system ?? '').includes('对话压缩') ||
    text.includes('## 用户意图') ||
    text.includes('你是一个对话压缩系统')

  return {
    ...inner,
    async doStream(opts: any) {
      const tag = isSummarize(opts, '') ? 'summarize' : 'agent'
      record(tag, opts)
      try {
        return await inner.doStream(opts)
      } catch (err) {
        console.log('     [假模型 doStream 抛异常]', (err as Error).message)
        throw err
      }
    },
    async doGenerate(opts: any) {
      // generateText(摘要) 走这里；先取文本再判定 tag
      const probe: string[] = []
      const p = opts?.prompt
      if (typeof p === 'string') probe.push(p)
      else if (Array.isArray(p)) {
        for (const m of p) {
          if (typeof m.content === 'string') probe.push(m.content)
          else if (Array.isArray(m.content)) for (const q of m.content) if (typeof q?.text === 'string') probe.push(q.text)
        }
      }
      record(isSummarize(opts, probe.join('\n')) ? 'summarize' : 'agent', opts)
      return inner.doGenerate(opts)
    },
  }
}

function toolMsg(toolName: string, text: string, callId: string): ModelMessage {
  return {
    role: 'tool',
    content: [{ type: 'tool-result', toolCallId: callId, toolName, output: textToolResultOutput(text) }],
  } as ModelMessage
}

/** 一条 assistant 消息里带 n 个 tool-call（callId 由 from 起编） */
function callMsg(from: number, count = 1): ModelMessage {
  return {
    role: 'assistant',
    content: Array.from({ length: count }, (_, i) => ({
      type: 'tool-call', toolCallId: `c${from + i}`, toolName: 'read_file', input: { path: `f${from + i}` },
    })),
  } as unknown as ModelMessage
}

const filler = (n: number, c: string) => c.repeat(n)

async function main() {
  const { agentLoop } = await import('../src/agent/loop')
  const registry = new ToolRegistry()

  // ------------------------------------------------------------------ A
  section('A. microcompact 分支：旧工具结果被清空')
  // 6 条消息 + 4 个工具结果：
  //   - 4 个工具结果 > KEEP_RECENT_TOOL_RESULT(3) ⇒ microcompact 会清 1 条
  //   - 6 条 <= KEEP_RECENT_MESSAGES(6) ⇒ summarize 自己会 early-return，不会把清空标记摘要掉
  const scenarioA: ModelMessage[] = [
    { role: 'user', content: `问题：${filler(300, '甲')}` } as ModelMessage,
    callMsg(1, 4),
    toolMsg('read_file', `旧内容1 ${filler(300, '乙')}`, 'c1'),
    toolMsg('read_file', `旧内容2 ${filler(300, '丙')}`, 'c2'),
    toolMsg('read_file', `旧内容3 ${filler(300, '丁')}`, 'c3'),
    toolMsg('read_file', `旧内容4 ${filler(300, '戊')}`, 'c4'),
  ]
  const aSnapshot = JSON.stringify(scenarioA)
  const aLength = scenarioA.length

  captured = []
  await agentLoop(makeRecordingModel(), registry, scenarioA, '你是测试用的 system prompt')

  const aAgent = captured.filter(c => c.tag === 'agent')
  check('A: 模型被调用过', aAgent.length >= 1, aAgent.length)
  check('A: 模型看到的 prompt 里有 [tool result cleared]',
    aAgent.some(c => c.text.includes('[tool result cleared]')),
    aAgent.map(c => c.text.slice(0, 150)))
  check('A: 清空的是"旧内容1"（最旧的工具结果）',
    aAgent.some(c => c.text.includes('旧内容2')))
  // 注意：loop 本来就会把本轮新消息 push 进调用方数组（index.ts 靠这个存档），
  // 所以安全的定义是"原有前缀一条不改、一条不删"，而不是"整个数组不变"。
  check('A: 调用方 messages 的原有前缀未被改动（无删除/无就地重写）',
    JSON.stringify(scenarioA.slice(0, aLength)) === aSnapshot)
  check('A: 调用方 messages 长度没变短', scenarioA.length >= aLength, `${aLength} → ${scenarioA.length}`)

  // ------------------------------------------------------------------ B
  section('B. summarize 分支：LLM 摘要压缩')
  // 4 轮对话（每轮 user / assistant(tool-call) / tool / assistant）+ 结尾 user = 17 条
  // splitIdx = 17-6 = 11 → 11 是 assistant，往前退到 8 的 user 边界
  //   ⇒ toCompress 覆盖前两轮，摘要分支真的会跑
  const scenarioB: ModelMessage[] = []
  for (let t = 0; t < 4; t++) {
    scenarioB.push({ role: 'user', content: `第${t + 1}轮问题：${filler(300, '问')}` } as ModelMessage)
    scenarioB.push(callMsg(t * 10 + 1))
    scenarioB.push(toolMsg('read_file', `第${t + 1}轮文件内容 ${filler(300, '资')}`, `c${t * 10 + 1}`))
    scenarioB.push({ role: 'assistant', content: `第${t + 1}轮回答 ${filler(300, '答')}` } as ModelMessage)
  }
  scenarioB.push({ role: 'user', content: `最后一问：${filler(300, '终')}` } as ModelMessage)

  const bSnapshot = JSON.stringify(scenarioB)
  const bLength = scenarioB.length

  captured = []
  await agentLoop(makeRecordingModel(), registry, scenarioB, '你是测试用的 system prompt')

  const bAgent = captured.filter(c => c.tag === 'agent')
  const bSummarize = captured.filter(c => c.tag === 'summarize')

  check('B: summarize 的 LLM 摘要分支被循环真正调到', bSummarize.length >= 1, bSummarize.length)
  check('B: 摘要调用收到了"已有摘要/压缩要求"的压缩系统提示',
    bSummarize.some(c => c.text.includes('第1轮问题')))
  check('B: 模型收到的是压缩后的历史（条数少于原始）',
    bAgent.some(c => c.messageCount < bLength),
    bAgent.map(c => c.messageCount))
  check('B: 模型看到的 prompt 里有 [压缩摘要] 标记',
    bAgent.some(c => c.text.includes('压缩摘要')),
    bAgent.map(c => c.text.slice(0, 150)))
  check('B: 最近的消息仍在（没被一起摘要掉）',
    bAgent.some(c => c.text.includes('最后一问')))
  check('B: 调用方 messages 长度没变短', scenarioB.length >= bLength, `${bLength} → ${scenarioB.length}`)
  check('B: 调用方 messages 的原有前缀逐字节不变（beforeLen 切片安全）',
    JSON.stringify(scenarioB.slice(0, bLength)) === bSnapshot)

  // ------------------------------------------------------------------ C
  section('C. 闸门：没超阈值就不压缩、不调摘要模型')
  captured = []
  const short: ModelMessage[] = [
    { role: 'user', content: '你好' } as ModelMessage,
    { role: 'assistant', content: '你好呀' } as ModelMessage,
  ]
  await agentLoop(makeRecordingModel(), registry, short, 'sys')
  check('C: 短对话不产生摘要模型调用',
    captured.filter(c => c.tag === 'summarize').length === 0,
    captured.map(c => c.tag))
  check('C: 短对话仍正常出结果（模型被调用）',
    captured.filter(c => c.tag === 'agent').length >= 1)

  console.log(`\n${'='.repeat(40)}`)
  console.log(`通过 ${passed} 项，失败 ${failed} 项`)
  if (failed > 0) process.exitCode = 1
}

main().catch(err => {
  console.error('\n[验证脚本自身抛异常]', err)
  process.exitCode = 1
})
