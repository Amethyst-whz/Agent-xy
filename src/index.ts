import 'dotenv/config'
import { type ModelMessage } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { createMockModel } from './mock-model'
import { createInterface } from 'readline'
//import { weatherTool } from './tools/utility-tools'
import { allTools } from './tools/tools'
import { ToolRegistry } from './tools/tool-registry'
import { agentLoop, type BudgetState } from './agent/loop'

//const tools = {get_weather: weatherTool}
const registry = new ToolRegistry()
registry.register(...allTools)
console.log(`已注册: ${registry.getAll().length} 个工具`);
for (const tool of registry.getAll()) {
  const flags = [
    tool.isConcurrencySafe ? '可并发' : '串行',
    tool.isReadOnly ? '只读' : '读写',
  ].join(', ')  
  console.log(` -- ${tool.name}: ${flags}`)
}

const messages: ModelMessage[] = []
const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
})

const qwen = createOpenAI({
  baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  apiKey: process.env.DASHSCOPE_API_KEY,
})

const model = process.env.DASHSCOPE_API_KEY ? qwen.chat('qwen3.8-27b') : createMockModel()

// async function main() {
//   const result  = streamText({
//     model: model as any,
//     prompt: '用一句话介绍你自己',
//   })

//   for await (const chunk of result.textStream) {
//     process.stdout.write(chunk)
//   }
// }
// main()

const budget = {used:0,limit:15000}

const SYSTEM = `你是 Super Agent，一个有工具调用能力的 AI 助手。
你有以下工具可用：get_weather, calculator, read_file, write_file, list_directory, editFileTool, globTool, grepTool, bashTool。
需要查询信息或操作文件时，主动使用工具，不要编造数据。
可以同时调用多个互不冲突的工具来提高效率。
回答要简洁直接。`;
function ask(){
  rl.question('\nYou: ', async(input) =>{
    const trimmed = input.trim()
    if(!trimmed || trimmed === 'exit'){
      console.log('Bye!')
      rl.close()
      return
    }

    messages.push({role: 'user', content: trimmed})

    process.stdout.write('Assistant: ')
    await agentLoop(model as any, registry, messages, SYSTEM,budget)
    ask()
  })
}

console.log('agent-xy v0.3(type "exit" to exit)')
console.log('测试死循环')
ask()