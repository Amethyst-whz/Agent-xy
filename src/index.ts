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
// 教程当前版：下面是老师最新版的 4 个 pipe
import { PromptBuilder, coreRules, toolGuide, deferredTools, sessionContext, type PromptContext } from './context/prompt-builder'
// [自己加的] 工作区目录（配 src/workspace.ts）+ 你自己加的两个 pipe
import { WORKSPACE_DIR, ensureWorkspace } from './workspace'
import { officeGuide, workspaceContext } from './context/custom-sections'


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


  // [老师早期版本] 工具统计：老师早期版本里有，最新版（PromptBuilder 那版）删了；留着只是启动时方便看
  const allCount = registry.getAll().length;
  const activeTools = registry.getActiveTools();
  const estimate = registry.countTokenEstimate();
  console.log(`\n=== 工具统计 ===`);
  console.log(`总工具数: ${allCount}`);
  console.log(`活跃工具数: ${activeTools.length}`);
  console.log(`延迟工具数: ${allCount - activeTools.length}`);
  console.log(`估算token数: ~${estimate.active}(活跃) + ~${estimate.deferred}(延迟，不占prompt)`);

  // [自己加的] 工作区：把 Excel/Word/PDF 放进来，直接说文件名即可
  ensureWorkspace();
  //console.log(`\n=== 工作区 ===`);
  //console.log(`目录: ${WORKSPACE_DIR}`);
  //console.log(`把办公文档放进该目录，然后直接说文件名即可（如：读 成绩表.xlsx 统计各班人数）`);


  // Prompt Pipe 组装 system prompt（顺序即优先级，也即 KV Cache 的友好度：静态在前、易变在后）
  const builder = new PromptBuilder()
    .pipe('coreRules', coreRules())            // 教程当前版：身份 + 行为准则
    .pipe('toolGuide', toolGuide())            // 教程当前版：工具数量
    .pipe('deferredTools', deferredTools())    // 教程当前版：延迟工具清单
    .pipe('sessionContext', sessionContext())  // 教程当前版：历史消息条数
    // ↓↓↓ [自己加的] 重做 index.ts 时记得补回这两行（实现在 custom-sections.ts）↓↓↓
    .pipe('officeGuide', officeGuide())              // 办公文档提示词
    .pipe('workspaceContext', workspaceContext())    // 工作区说明：含文件清单，易变 → 必须最后
    // ↑↑↑ [自己加的] ↑↑↑

  // 注意：这里用的就是教程里的 PromptContext，没有自己加的字段
  const promptCtx: PromptContext = {
    toolCount: registry.getActiveTools().length,  // 活跃工具数
    deferredToolSummary: registry.getDeferredToolSummary(),  // 延迟工具摘要
    sessionMessageCount: messages.length,
    sessionId,
  }

  const SYSTEM = builder.build(promptCtx)

  // [自己加的] 默认不打印（debug 会把每个 pipe 再跑一遍）；排查提示词拼装时加 --debug-prompt
  if (process.argv.includes('--debug-prompt')) builder.debug(promptCtx)

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