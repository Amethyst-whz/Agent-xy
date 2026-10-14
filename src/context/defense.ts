import type { ModelMessage } from 'ai'
import { textToolResultOutput, toolResultOutputToText } from './tool-result-output'

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
      return tokens + estimateTextTokens(JSON.stringify(part.input))
    }
    return tokens
  }, 0)
}

export function estimateMessagesTokens(messages: ModelMessage[]): number {
  return messages.reduce((tokens, message) => tokens + estimateMessageTokens(message), 0)
}

export class TokenTracker {
  private exactInputTokens = 0
  private exactOutputTokens = 0
  private estimatedAddedTokens = 0

  recordUsage(inputTokens: number, outputTokens: number): void {
    this.exactInputTokens += inputTokens
    this.exactOutputTokens += outputTokens
  }

  estimateAddedMessages(messages: ModelMessage[]): number {
    const estimate = estimateMessagesTokens(messages)
    this.estimatedAddedTokens += estimate
    return estimate
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
    const content = message.content.map((part) => {
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