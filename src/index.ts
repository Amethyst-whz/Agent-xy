import 'dotenv/config'
import { type ModelMessage } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { createMockModel } from './mock-model'
import { createInterface } from 'readline'
import { allTools } from './tools'
import { ToolRegistry, type ToolDefinition } from './tools/registry'
import { agentLoop, type BudgetState } from './agent/loop'
import { MCPClient, githubMcpLaunch } from './tools/mcp-client'
import { SessionStore } from './session/store'
import { WORKSPACE_DIR, ensureWorkspace, workspacePromptSection } from './workspace'


const qwen = createOpenAI({  // 创建 OpenAI 模型, 用于生成文本
  baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  apiKey: process.env.DASHSCOPE_API_KEY,
})
const model = process.env.DASHSCOPE_API_KEY ? qwen.chat('qwen3.8-27b') : createMockModel()

// 注册内置工具
const registry = new ToolRegistry()
registry.register(...allTools)

// 注册 tool_search 元工具
const toolSearchTool: ToolDefinition = {
  name: 'tool_search',
  description: '获取延迟工具的完整定义，传入工具名（从系统提示的延迟工具列表中获取），返回该工具的完整参数 Schema',
  parameters: { type: 'object', properties: { query: { type: 'string', description: '工具名，如 "mcp__github__list_issues"。支持逗号分隔多个工具名' } }, required: ['query'] },
  isConcurrencySafe: true,
  isReadOnly: true,
  execute: async ({ query }: { query: string }) => {
    const results = registry.searchTools(query)  // 搜出来哪些工具的searchHint 包含 query 字符串
    return results.map(t => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }))
  },
}
registry.register(toolSearchTool)



// 连接MCP服务器
async function connectMCP() {
  const githubToken = process.env.GITHUB_PERSONAL_ACCESS_TOKEN;

  let canSpawn = true;
  try {
    const { execSync } = await import('node:child_process');
    execSync('echo test', { stdio: 'ignore' });
  } catch {
    canSpawn = false;
  }

  if (githubToken && canSpawn) {
    console.log('\n连接 GitHub MCP Server...');
    try {
      // Windows 上 pnpm 只有 .cmd 外壳，spawn 无法直接执行 → 内部按平台处理（见 githubMcpLaunch）
      const launch = githubMcpLaunch();
      const client = new MCPClient(
        launch.command, launch.args,
        { GITHUB_PERSONAL_ACCESS_TOKEN: githubToken },
      );
      const tools = await registry.registerMCPServer('github', client);
      console.log(`  已注册 ${tools.length} 个 MCP 工具`);
      return;
    } catch (err) {
      console.log(`  MCP 连接失败: ${err instanceof Error ? err.message : err}`);
    }
  }

  if (!githubToken) {
    console.log('\n未配置 GITHUB_PERSONAL_ACCESS_TOKEN，无法连接 GitHub MCP Server。');
  }
}

async function main() {
  await connectMCP();

  // Session 持久化
  const isContinue = process.argv.includes('--continue')
  const sessionId = 'default'
  const store = new SessionStore(sessionId)

  let messages: ModelMessage[] = []
  if (isContinue && store.exists()) {
    messages = store.load()
    console.log(`[Session] 恢复会话，共 ${messages.length} 条历史消息`);
  } else {
    console.log(`[Session] 新会话`);
  }


  const allCount = registry.getAll().length;
  const activeTools = registry.getActiveTools();
  const estimate = registry.countTokenEstimate();
  console.log(`\n=== 工具统计 ===`);
  console.log(`总工具数: ${allCount}`);
  console.log(`活跃工具数: ${activeTools.length}`);
  console.log(`延迟工具数: ${allCount - activeTools.length}`);
  console.log(`估算token数: ~${estimate.active}(活跃) + ~${estimate.deferred}(延迟，不占prompt)`);

  // 工作区提示：把 Excel/Word/PDF 放进来，直接说文件名即可
  ensureWorkspace();
  //console.log(`\n=== 工作区 ===`);
  //console.log(`目录: ${WORKSPACE_DIR}`);
  //console.log(`把办公文档放进该目录，然后直接说文件名即可（如：读 成绩表.xlsx 统计各班人数）`);
  

  const deferredSummary = registry.getDeferredToolSummary();  // 获取延迟工具的摘要
  const workspaceSection = workspacePromptSection();  // 工作区说明（含文件清单，内容易变 → 放系统提示最后，避免影响前面静态内容的 KV Cache）
  const SYSTEM = `你是 Super Agent，一个有工具调用能力的 AI 助手。
你有内置工具和 MCP 工具可用。
如果你需要的工具不在当前列表中，使用 tool_search 工具搜索可用工具。
处理 Excel / Word / PDF 办公文档时：先用 read_excel / read_word 的 overview / outline 模式确认文件结构，再做检索或统计。
引用任何数据都必须来自工具返回的真实内容；检索不到就如实说明"未在文件中检索到"，绝不推测或编造。
回答要简洁直接。${deferredSummary}${workspaceSection}`;


  
  const rl = createInterface({   // 创建 readline 接口, 用于从命令行读取用户输入
    input: process.stdin,
    output: process.stdout,
  })


  function ask() {
    rl.question('\nYou: ', async (input) => {
      const trimmed = input.trim();
      if (!trimmed || trimmed === 'exit') {
        console.log('Bye!');
        await registry.closeAllMCP();  // 关闭子进程的 MCP 连接
        rl.close();
        return;
      }

      const userMsg: ModelMessage = { role: 'user', content: trimmed }
      messages.push(userMsg);
      store.append(userMsg)

      const beforeLen = messages.length
      await agentLoop(model, registry, messages, SYSTEM)

      // 持久化本轮新增加的消息 （包含Agent Loop 中会往messages里面push的消息）
      const newMessages = messages.slice(beforeLen)
      store.appendAll(newMessages)  // 追加的只有AgentLoop产生的消息

      ask()
    });
  }

  console.log('Super Agent v0.6 — MCP (type "exit" to quit)\n');

  ask();

}

main().catch(console.error)