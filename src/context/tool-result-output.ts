import type { ToolResultPart } from "ai";

// 工具调用的结果输出xxxxxx ==> [tool result cleared]

type ToolResultOutput = ToolResultPart['output']

export function textToolResultOutput(value: string): ToolResultOutput {
  return {
    type: 'text',
    value: value,
  }
}

export function toolResultOutputToText(output: ToolResultOutput): string {
  switch (output.type) {
    case 'text':
    case 'error-text':
      return output.value
    case 'json':
    case 'error-json':
      return JSON.stringify(output.value)
    case 'content':
      return output.value
        .map(part => {
          if (part.type === 'text') return part.text
          const mediaType = 'mediaType' in part ? part.mediaType : undefined
          return `[media:${mediaType ?? part.type}]`
        })
        .join('\n')
    // [自己加的] 修 bug：AI SDK 的 ToolResultOutput 一共 6 种变体（text / json /
    // execution-denied / error-text / error-json / content），原来漏了 execution-denied，
    // 于是这个函数会返回 undefined；而 compressor.ts 的 estimateTokens 里是
    // `toolResultOutputToText(part.output).length`，undefined.length 直接抛
    // TypeError: Cannot read properties of undefined (reading 'length')。
    // 触发条件：用户拒绝工具执行（ToolApprovalResponse 选 deny）时会生成这种 part。
    case 'execution-denied':
      return `[工具执行被拒绝${output.reason ? `：${output.reason}` : ''}]`
    // [自己加的] 兜底：以后 AI SDK 再加新的 output 变体时，宁可返回一句占位文本，
    // 也不要让 undefined 漏出去把整个上下文压缩搞崩。
    default:
      return '[未知的工具结果类型]'
  }
}

