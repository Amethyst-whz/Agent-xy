import type { ModelMessage } from 'ai'
import { textToolResultOutput, toolResultOutputToText } from './tool-result-output'

export class TokenTracker {
  private lastPreciseCount = 0
  private pendingChars = 0
  private exactInputTokens = 0
  private exactOutputTokens = 0
  private estimatedAddedTokens = 0

  updateFromAPI(promptTokens: number): void {
    this.lastPreciseCount = promptTokens
    this.pendingChars = 0
  }

  addMessage(message: ModelMessage): void {
    this.pendingChars += countMessageChars(message)
  }

  addMessages(messages: ModelMessage[]): void {
    for (const message of messages) {
      this.addMessage(message)
    }
  }

  repleaceMessage(before: ModelMessage[], after: ModelMessage[]): void {
    this.pendingChars += countMessagesChars(after) - countMessagesChars(before)
  }

  recordUsage(inputTokens: number, outputTokens: number): void {
    this.exactInputTokens += inputTokens
    this.exactOutputTokens += outputTokens
  }

  estimateAddedMessages(messages: ModelMessage[]): number {
    const estimate = estimateMessagesTokens(messages)
    this.estimatedAddedTokens += estimate
    return estimate
  }

  get estimatetokens(): number {
    return Math.max(0, this.lastPreciseCount + Math.ceil(this.pendingChars / 4))
  }

  get status(): { tokens: number; percent: number; needsAction: boolean } {
    const tokens = this.estimatetokens
    const percent = Math.round((tokens / CONST_WIDOW) * 100)
    return {
      tokens,
      percent,
      needsAction: percent > 75,
    }
  }

  get exactUsage(): { inputTokens: number; outputTokens: number; totalTokens: number } {
    return {
      inputTokens: this.exactInputTokens,
      outputTokens: this.exactOutputTokens,
      totalTokens: this.exactInputTokens + this.exactOutputTokens,
    }
  }

  get estimatedAddedTokensTotal(): number {
    return this.estimatedAddedTokens
  }
}

const CONTEXT_WINDOW = 200_000

function countMessageChars(message: ModelMessage): number {
  if (typeof message.content === 'string') return message.content.length
  if (!Array.isArray(message.content)) return 0

  return message.content.reduce((chars, part) => {
    if ('text' in part && typeof part.text === 'string') {
      return chars + part.text.length
    }
    if ('output' in part && part.output !== undefined) {
      return chars + (toolResultOutputToText(part.output) as string).length
    }
    if ('input' in part) {
      return chars + (JSON.stringify(part.input)?.length ?? 0)
    }
    return chars
  }, 0)
}

function countMessagesChars(messages: ModelMessage[]): number {
  return messages.reduce((chars, message) => chars + countMessageChars(message), 0)
}


//----------------------------------------------

export function truncateToolResult(
  messages: ModelMessage[],
  config = {
    maxSingleResult: CONTEXT_WINDOW * 0.5 * 2,  // 50%窗口，2倍安全系数
    contextBudgetChars: CONTEXT_WINDOW * 0.75 * 4,  // 75%窗口，4倍安全系数
  }
): { messages: ModelMessage[]; truncated: number, compacted: number } {
  let truncated = 0
  let compacted = 0

  // 1. 单条截断 -- 超过窗口50%的工具结果做 head/tail 分割
  let result = messages.map(msg => {
    if (msg.role !== 'tool' || !Array.isArray(msg.content)) return msg;

    const newContent = msg.content.map((part: any) => {
      if (!part.output) return part;
      const outputText = toolResultOutputToText(part.output) as string;
      if (outputText.length <= config.maxSingleResult) return part;

      truncated++;
      const maxChars = config.maxSingleResult;
      const headSize = Math.floor(maxChars * 0.6);
      const tailSize = Math.floor(maxChars * 0.4);
      const head = outputText.slice(0, headSize);
      const tail = outputText.slice(-tailSize);

      return {
        ...part,
        output: textToolResultOutput(`${head}\n\n[truncated: ${outputText.length} → ${maxChars} chars]\n\n${tail}`),
      };
    });

    return { ...msg, content: newContent };
  });
  // 2. 总上下文超过窗口75%， 从最老的 tool result 开始清理 (将 output 替换为 占位符)
  let totalChars = result.reduce((sum, msg) => {
    if (typeof msg.content === 'string') return sum + msg.content.length;
    if (Array.isArray(msg.content)) {
      return sum + (msg.content as any[]).reduce((s, p) =>
        s + (p.output ? (toolResultOutputToText(p.output) as string).length : (p.text as string)?.length || 0), 0);
    }
    return sum;
  }, 0);

  if (totalChars > config.contextBudgetChars) {
    for (let i = 0; i < result.length && totalChars > config.contextBudgetChars; i++) {
      const msg = result[i];
      if (msg.role !== 'tool' || !Array.isArray(msg.content)) continue;
      const toolName = ((msg.content as any[])[0])?.toolName || 'unknown';
      const oldSize = (msg.content as any[]).reduce((s: number, p: any) =>
        s + (p.output ? (toolResultOutputToText(p.output) as string).length : 0), 0);
      result[i] = {
        ...msg,
        content: (msg.content as any[]).map((p: any) => ({
          ...p,
          output: textToolResultOutput(`[compacted: ${toolName} output removed to free context]`),
        })),
      };
      totalChars -= oldSize;
      compacted++;
    }
  }

  return { messages: result, truncated, compacted }
}



















export const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000
export const DEFAULT_SOFT_TOOL_RESULT_TTL_MS = 60 * 60 * 1000
export const DEFAULT_HARD_TOOL_RESULT_TTL_MS = 24 * 60 * 60 * 1000

export function estimateTextTokens(text: string): number {
  if (!text) return 0
  const chineseSafetyFactor = /[\u3400-\u9fff]/.test(text) ? 1.2 : 1
  return Math.ceil((text.length / 4) * chineseSafetyFactor)
}

export function estimateMessageTokens(message: ModelMessage): number {
  if (typeof message.content === 'string') return estimateTextTokens(message.content)
  if (!Array.isArray(message.content)) return 0

  return message.content.reduce((tokens, part) => {
    if ('text' in part && typeof part.text === 'string') {
      return tokens + estimateTextTokens(part.text)
    }
    if ('output' in part) {
      return tokens + estimateTextTokens(toolResultOutputToText(part.output))
    }
    if ('input' in part) {
      return tokens + estimateTextTokens(JSON.stringify(part.input) ?? '')
    }
    return tokens
  }, 0)
}

export function estimateMessagesTokens(messages: ModelMessage[]): number {
  return messages.reduce((tokens, message) => tokens + estimateMessageTokens(message), 0)
}




export function estimateTokens(message: ModelMessage): number {
  return estimateMessageTokens(message)
}

export function canTruncateToolResult(
  result: string,
  currentContextTokens: number,
  contextWindowTokens: number,
): boolean {
  const resultTokens = estimateTextTokens(result)
  return resultTokens > contextWindowTokens * 0.5
    || currentContextTokens + resultTokens > contextWindowTokens * 0.75
}

export type MessageTimestamp = number | string | Date | undefined

export interface TtlPruneResult {
  messages: ModelMessage[]
  softPruned: number
  hardCleared: number
}

function timestampMs(timestamp: MessageTimestamp): number | undefined {
  if (timestamp === undefined) return undefined
  const value = timestamp instanceof Date ? timestamp.getTime() : new Date(timestamp).getTime()
  return Number.isFinite(value) ? value : undefined
}

function softPruneText(text: string): string {
  const maxChars = 1200
  if (text.length <= maxChars) return text
  const headSize = Math.floor(maxChars / 2)
  const tailSize = maxChars - headSize
  const omitted = text.length - maxChars
  return `${text.slice(0, headSize)}\n\n... [软修剪，省略${omitted}个字符] ...\n\n${text.slice(-tailSize)}`
}

export function pruneToolResultsByTtl(
  messages: ModelMessage[],
  timestamps: MessageTimestamp[],
  now = Date.now(),
  softTtlMs = DEFAULT_SOFT_TOOL_RESULT_TTL_MS,
  hardTtlMs = DEFAULT_HARD_TOOL_RESULT_TTL_MS,
): TtlPruneResult {
  if (hardTtlMs < softTtlMs) {
    throw new RangeError('hardTtlMs must be greater than or equal to softTtlMs')
  }

  let softPruned = 0
  let hardCleared = 0
  const pruned = messages.map((message, index) => {
    if (message.role !== 'tool' || !Array.isArray(message.content)) return message

    const createdAt = timestampMs(timestamps[index])
    if (createdAt === undefined) return message
    const age = now - createdAt
    if (age < softTtlMs) return message

    let changed = false
    const content = message.content.map(part => {
      if (!('output' in part)) return part
      const text = toolResultOutputToText(part.output)
      if (age >= hardTtlMs) {
        changed = true
        hardCleared++
        return { ...part, output: textToolResultOutput('[tool result expired]') }
      }
      const shortened = softPruneText(text)
      if (shortened === text) return part
      changed = true
      softPruned++
      return { ...part, output: textToolResultOutput(shortened) }
    })

    return changed ? { ...message, content } : message
  })

  return { messages: pruned, softPruned, hardCleared }
}

export interface OldHistoryPruneResult {
  messages: ModelMessage[]
  removed: number
}

export function pruneOldHistory(
  messages: ModelMessage[],
  maxTokens: number,
  targetTokens: number,
): OldHistoryPruneResult {
  if (targetTokens < 0 || maxTokens < targetTokens) {
    throw new RangeError('targetTokens must be non-negative and no greater than maxTokens')
  }
  if (estimateMessagesTokens(messages) <= maxTokens) return { messages, removed: 0 }

  const userBoundaries = messages
    .map((message, index) => message.role === 'user' && index > 0 ? index : -1)
    .filter(index => index >= 0)

  for (const boundary of userBoundaries) {
    const remaining = messages.slice(boundary)
    if (estimateMessagesTokens(remaining) <= targetTokens) {
      return { messages: remaining, removed: boundary }
    }
  }

  return { messages, removed: 0 }
}

