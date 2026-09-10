/**
 * MCP 连接诊断 / 回归验证（临时脚本，前缀 _ 不参与 pnpm run test:docs）
 *
 * 运行：pnpm exec tsx tests/_mcp-diag.ts
 * 期望：第 3 条用项目真实代码路径（githubMcpLaunch + MCPClient）连上 GitHub MCP，
 *       拿到 26 个工具，并且真的能调用其中一个工具。
 */
import 'dotenv/config'
import { spawn } from 'node:child_process'
import { MCPClient, githubMcpLaunch } from '../src/tools/mcp-client'

const token = process.env.GITHUB_PERSONAL_ACCESS_TOKEN
console.log(`1) GITHUB_PERSONAL_ACCESS_TOKEN: ${token ? `有值 (${token.slice(0, 4)}***, 长度 ${token.length})` : '缺失'}`)

function probe(label: string, cmd: string, args: string[], shell = false, timeoutMs = 20000): Promise<void> {
  return new Promise((resolve) => {
    let out = ''
    let settled = false
    const done = (msg: string) => {
      if (settled) return
      settled = true
      console.log(`   ${label} → ${msg}`)
      resolve()
    }

    let child
    try {
      child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], shell })
    } catch (err) {
      done(`spawn 抛异常: ${(err as Error).message}`)
      return
    }

    child.stdout?.on('data', (d: Buffer) => (out += d.toString()))
    child.stderr?.on('data', (d: Buffer) => (out += d.toString()))
    child.on('error', (err: NodeJS.ErrnoException) => done(`spawn error: code=${err.code} ${err.message}`))
    child.on('exit', (code, signal) => done(`exit=${code} sig=${signal} 输出=${JSON.stringify(out.trim().slice(0, 160))}`))

    setTimeout(() => {
      child.kill()
      done(`超时 ${timeoutMs}ms（未退出）`)
    }, timeoutMs)
  })
}

// ---------------------------------------------------------------------------
console.log('2) 裸 spawn 探针（解释为什么原来会失败）：')
await probe("spawn('pnpm', ['--version'])", 'pnpm', ['--version'], false)
await probe("spawn('cmd.exe', ['/c','pnpm','--version'])", 'cmd.exe', ['/c', 'pnpm', '--version'], false)

// ---------------------------------------------------------------------------
console.log('3) 项目真实代码路径（githubMcpLaunch + MCPClient，与 src/index.ts 一致）：')
{
  const launch = githubMcpLaunch()
  console.log(`   启动方式: ${launch.command} ${launch.args.join(' ')}`)
  const client = new MCPClient(launch.command, launch.args, {
    GITHUB_PERSONAL_ACCESS_TOKEN: token ?? '',
  } as Record<string, string>)
  try {
    await client.connect()
    console.log('   ✅ initialize 成功')
    const tools = await client.listTools()
    console.log(`   ✅ tools/list 成功：${tools.length} 个工具`)

    const target = tools.find((t) => t.name === 'search_repositories') ?? tools[0]
    const out = await client.callTool(target.name, { query: 'octocat', perPage: 1 })
    console.log(`   ✅ tools/call 成功：${target.name} 返回 ${String(out).length} 字`)
    console.log(`      片段: ${String(out).replace(/\s+/g, ' ').slice(0, 120)}`)
  } catch (err) {
    console.log(`   ❌ 失败: ${(err as Error).message}`)
  } finally {
    await client.close().catch(() => undefined)
  }
}

// ---------------------------------------------------------------------------
console.log('4) 备选方案对照：绕过 pnpm，直接用本地 node_modules 里的 server')
{
  const client = new MCPClient(
    process.execPath,
    ['node_modules/@modelcontextprotocol/server-github/dist/index.js'],
    { GITHUB_PERSONAL_ACCESS_TOKEN: token ?? '' } as Record<string, string>,
  )
  try {
    await client.connect()
    const tools = await client.listTools()
    console.log(`   ✅ ${tools.length} 个工具（启动不依赖 pnpm）`)
  } catch (err) {
    console.log(`   ❌ 失败: ${(err as Error).message}`)
  } finally {
    await client.close().catch(() => undefined)
  }
}
