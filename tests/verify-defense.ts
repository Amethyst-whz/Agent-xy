import type { ModelMessage } from 'ai'
import { ToolRegistry } from '../src/tools/registry'
import { textToolResultOutput } from '../src/context/tool-result-output'
import {
  TokenTracker,
  canTruncateToolResult,
  estimateMessageTokens,
  estimateMessagesTokens,
  estimateTextTokens,
  pruneOldHistory,
  pruneToolResultsByTtl,
} from '../src/context/defense'

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail?: unknown) {
  if (condition) {
    passed++
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.log(`  ❌ ${name}`)
    if (detail !== undefined) console.log(`     实际: ${JSON.stringify(detail)}`)
  }
}

async function main() {
  check('英文按 4 字符约 1 Token 估算', estimateTextTokens('a'.repeat(40)) === 10)
  check('中文估算增加 1.2 倍安全系数', estimateTextTokens('中'.repeat(10)) === 3)

  const tracker = new TokenTracker()
  tracker.recordUsage(120, 30)
  const addedEstimate = tracker.estimateAddedMessages([{ role: 'user', content: 'x'.repeat(40) }])
  check('TokenTracker 保留 API 精确用量', tracker.exactUsage.totalTokens === 150)
  check('TokenTracker 记录新增消息估算值', addedEstimate === 10 && tracker.estimatedAddedTokensTotal === 10)

  check(
    '小工具结果且上下文低于 75% 时不截断',
    !canTruncateToolResult('x'.repeat(200), 100, 1000),
  )
  check(
    '预计总上下文超过 75% 时触发截断',
    canTruncateToolResult('x'.repeat(200), 720, 1000),
  )
  check(
    '单个工具结果超过窗口 50% 时触发截断',
    canTruncateToolResult('x'.repeat(2200), 100, 1000),
  )

  const registry = new ToolRegistry()
  registry.register({
    name: 'large_result',
    description: 'Returns a large test result',
    parameters: { type: 'object', properties: {} },
    maxResultChars: 20,
    execute: async () => 'x'.repeat(200),
  })
  const roomyResult = await registry.toAISDKFormat({
    contextTokens: 100,
    contextWindowTokens: 1000,
  }).large_result.execute({})
  const crowdedResult = await registry.toAISDKFormat({
    contextTokens: 720,
    contextWindowTokens: 1000,
  }).large_result.execute({})
  check('动态截断接线：上下文充裕时跳过字符上限', roomyResult.length === 200)
  check('动态截断接线：上下文拥挤时应用工具字符上限', crowdedResult.length < 200, crowdedResult.length)

  const callId = 'ttl-call'
  const oldToolMessage = {
    role: 'tool',
    content: [{
      type: 'tool-result',
      toolCallId: callId,
      toolName: 'read_file',
      output: textToolResultOutput(`${'h'.repeat(900)}${'t'.repeat(900)}`),
    }],
  } as ModelMessage
  const freshToolMessage = {
    role: 'tool',
    content: [{
      type: 'tool-result',
      toolCallId: 'fresh-call',
      toolName: 'read_file',
      output: textToolResultOutput('fresh'),
    }],
  } as ModelMessage
  const now = Date.now()
  const ttl = pruneToolResultsByTtl(
    [oldToolMessage, freshToolMessage],
    [now - 2 * 60 * 60 * 1000, now],
    now,
  )
  const softText = (ttl.messages[0] as any).content[0].output.value as string
  check('超过软 TTL 时保留结果头尾并压缩中间内容', ttl.softPruned === 1 && softText.startsWith('h') && softText.endsWith('t'.repeat(600)))
  check('TTL 修剪不改写新鲜结果', (ttl.messages[1] as any).content[0].output.value === 'fresh')
  const hard = pruneToolResultsByTtl([oldToolMessage], [now - 25 * 60 * 60 * 1000], now)
  check('超过硬 TTL 时替换为过期占位符', hard.hardCleared === 1 && (hard.messages[0] as any).content[0].output.value === '[tool result expired]')

  const history: ModelMessage[] = []
  for (let turn = 0; turn < 3; turn++) {
    history.push({ role: 'user', content: `q${turn}${'u'.repeat(39)}` })
    history.push({ role: 'assistant', content: `a${turn}${'a'.repeat(39)}` })
  }
  const oldHistory = pruneOldHistory(history, 50, 25)
  check('超预算时剔除完整旧对话并保留最新轮次', oldHistory.removed === 4 && oldHistory.messages[0].role === 'user')
  check('历史裁剪后的 token 估算达到目标', estimateMessagesTokens(oldHistory.messages) <= 25)
  check('单条消息 token 估算与批量估算一致', estimateMessageTokens(history[0]) <= estimateMessagesTokens(history))

  console.log(`\n通过 ${passed} 项，失败 ${failed} 项`)
  if (failed > 0) process.exitCode = 1
}

main().catch(error => {
  console.error('[验证脚本自身抛异常]', error)
  process.exitCode = 1
})
