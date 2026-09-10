/**
 * MCP 连接诊断（临时脚本）
 * 目的：定位 connectMCP 失败的具体环节 —— spawn 能否启动 pnpm / dlx 能否取到包 / 握手能否成功 / token 是否有效
 */
import 'dotenv/config'
import { spawn } from 'node:child_process'
import { MCPClient } from '../src/tools/mcp-client'

const token = process.env.GITHUB_PERSONAL_ACCESS_TOKEN
console.log(`1) GITHUB_PERSONAL_ACCESS_TOKEN: ${token ? `有值 (${token.slice(0, 4)}***, 长度 ${token.length})` : '缺失'}`)

function probe(label: string, cmd: string, args: string[], shell = false, timeoutMs = 45000): Promise<void> {
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
    child.on('exit', (code, signal) => done(`exit=${code} sig=${signal} 输出=${JSON.stringify(out.trim().slice(0, 180))}`))

    setTimeout(() => {
      child.kill()
      done(`超时 ${timeoutMs}ms（未退出）输出=${JSON.stringify(out.trim().slice(0, 180))}`)
    }, timeoutMs)
  })
}

console.log('2) spawn 探针：')
await probe("spawn('pnpm', ['--version'])", 'pnpm', ['--version'], false, 20000)
await probe("spawn('pnpm.cmd', ['--version'])", 'pnpm.cmd', ['--version'], false, 20000)
await probe("spawn('pnpm', ['--version'], {shell:true})", 'pnpm', ['--version'], true, 20000)

console.log('3) 用项目自己的 MCPClient 连 GitHub MCP（与 src/index.ts 完全一致）：')
{
  const client = new MCPClient('pnpm', ['dlx', '@modelcontextprotocol/server-github'], {
    GITHUB_PERSONAL_ACCESS_TOKEN: token ?? '',
  } as Record<string, string>)
  try {
    await client.connect()
    console.log('   initialize 成功')
    const tools = await client.listTools()
    console.log(`   tools/list 成功：${tools.length} 个工具，示例 ${tools.slice(0, 3).map((t) => t.name).join(', ')}`)
  } catch (err) {
    console.log(`   失败: ${(err as Error).message}`)
  } finally {
    await client.close().catch(() => undefined)
  }
}

console.log('5) 用 cmd.exe 包一层走 pnpm dlx（候选修复方案，验证 dlx 本身在这台机器上能否工作）：')
{
  const client = new MCPClient('cmd.exe', ['/c', 'pnpm', 'dlx', '@modelcontextprotocol/server-github'], {
    GITHUB_PERSONAL_ACCESS_TOKEN: token ?? '',
  } as Record<string, string>)
  try {
    await client.connect()
    console.log('   initialize 成功')
    const tools = await client.listTools()
    console.log(`   tools/list 成功：${tools.length} 个工具`)
  } catch (err) {
    console.log(`   失败: ${(err as Error).message}`)
  } finally {
    await client.close().catch(() => undefined)
  }
}

console.log('4) 绕过 dlx，直接用本地 node_modules 里的 server 握手：')
{
  const client = new MCPClient(
    process.execPath,
    ['node_modules/@modelcontextprotocol/server-github/dist/index.js'],
    { GITHUB_PERSONAL_ACCESS_TOKEN: token ?? '' } as Record<string, string>,
  )
  try {
    await client.connect()
    console.log('   initialize 成功')
    const tools = await client.listTools()
    console.log(`   tools/list 成功：${tools.length} 个工具，示例 ${tools.slice(0, 3).map((t) => t.name).join(', ')}`)
  } catch (err) {
    console.log(`   失败: ${(err as Error).message}`)
  } finally {
    await client.close().catch(() => undefined)
  }
}
