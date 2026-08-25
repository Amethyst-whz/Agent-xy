import 'dotenv/config'
import { streamText, type ModelMessage, stepCountIs } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { createMockModel } from './mock-model'
import { createInterface } from 'readline'


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

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
})

const messages: ModelMessage[] = []

function ask(){
  rl.question('\nYou: ', async(input) =>{
    const trimmed = input.trim()
    if(!trimmed || trimmed === 'exit'){
      console.log('Bye!')
      rl.close()
      return
    }

    messages.push({role: 'user', content: trimmed})
    
    const result = streamText({
      model: model as any,
      messages,
    })
    process.stdout.write('Assistant: ')
    let fullResponse = ''
    for await (const chunk of result.textStream) {
      process.stdout.write(chunk)
      fullResponse += chunk
    }
    console.log('\n')

    messages.push({ role: 'assistant', content: fullResponse })
    ask()
  })
}

console.log('super agent v0.1(type "exit" to exit)')
ask()