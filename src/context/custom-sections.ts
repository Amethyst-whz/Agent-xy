/**
 * ============================================================================
 * 你自己加的部分 —— 老师课上没有，以后也不会有
 * ============================================================================
 *
 * 目前两样：
 *   - officeGuide()      办公文档（Excel / Word / PDF）提示词
 *   - workspaceContext() 工作区说明（配 src/workspace.ts 和 main() 里的 ensureWorkspace()）
 *
 * 为什么单独放一个文件：
 *   跟着老师的课往后做的时候，index.ts / prompt-builder.ts 很可能被整份替换掉。
 *   把"自己加的"内容集中在这里，重写时只要在 index.ts 里补回对应几行，
 *   不用在自己的代码和老师的代码之间来回翻、也不会顺手删掉。
 *
 * 重做 index.ts 时要补回的东西（全项目搜 "自己加的" 就能找齐）：
 *   1) import { officeGuide, workspaceContext } from './context/custom-sections'
 *   2) .pipe('officeGuide', officeGuide())
 *      .pipe('workspaceContext', workspaceContext())   ← 必须排在最后
 *   3) main() 里的 ensureWorkspace()
 *   4) --debug-prompt 那个开关（可有可无）
 *
 * 工作区是三样配套的，要留一起留、要删一起删：
 *   src/workspace.ts + main() 里的 ensureWorkspace() + 本文件的 workspaceContext()
 */

import type { PromptContext } from './prompt-builder'
import { workspacePromptSection } from '../workspace'

/**
 * prompt-builder.ts 里的 PipeFn 是私有的（没有 export），所以这里按同样的形状
 * 自己声明一份：只要是「收 ctx、返回 string 或 null」的函数，就能塞进 .pipe()。
 * 以后老师那个 PromptContext 改了字段名，改这里的 import 即可。
 */
type PipeFn = (ctx: PromptContext) => string | null

/**
 * 办公文档（Excel / Word / PDF）部分的提示词 —— 你自己加的，老师课上没有。
 *
 * 这里写的是你自己的那三个工具（read_excel / read_word / read_pdf）该怎么用。
 * 想调 agent 处理表格 / 文档的行为，改这一个函数就够了，不用动 prompt-builder.ts。
 */
export function officeGuide(): PipeFn {
  return () => `处理 Excel / Word / PDF 办公文档时：先用 read_excel / read_word 的 overview / outline 模式确认文件结构，再做检索或统计。
引用任何数据都必须来自工具返回的真实内容；检索不到就如实说明"未在文件中检索到"，绝不推测或编造。`
}

/**
 * 工作区说明 —— 也是你自己加的（配 src/workspace.ts，老师课上没有这套东西）。
 *
 * 必须排在所有 pipe 的最后一段：它含「工作区当前文件清单」，会话之间会变，
 * 放到前面会让它后面所有段的 KV Cache 全部失效。
 *
 * 这里直接在 pipe 里现算（每次启动只算一次，开销可忽略）；
 * 注意 --debug-prompt 会把每个 pipe 再跑一遍，也就是多扫一次工作区目录。
 */
export function workspaceContext(): PipeFn {
  return () => workspacePromptSection()
}
