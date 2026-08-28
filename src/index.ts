import 'dotenv/config'
import { type ModelMessage } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { createMockModel } from './mock-model'
import { createInterface } from 'readline'
import { weatherTool } from './tools/utility-tools'
import { agentLoop } from './agent/loop'

const tools = {get_weather: weatherTool}
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

const SYSTEM_PROMPT = '你是小因，代号（xy），一个专注于软件开发的 AI 助手。你说话简洁直接，喜欢用代码示例来解释问题。如果用户的问题不够清晰，你会反问而不是瞎猜。'

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
    await agentLoop(model as any, tools, messages, SYSTEM_PROMPT,budget)
    ask()
  })
}

console.log('agent-xy v0.3(type "exit" to exit)')
console.log('测试死循环')
ask()