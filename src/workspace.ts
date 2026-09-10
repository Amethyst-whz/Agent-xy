/**
 * 工作区（workspace）
 *
 * 为什么需要：所有工具的路径原本都按 process.cwd() 解析 —— 你在哪个目录执行 `pnpm start`，
 * 相对路径就以哪个目录为基准。换个终端、换个启动脚本，agent 就找不到文件了。
 *
 * 约定（相对路径的解析顺序）：
 *   1. 绝对路径           → 原样使用（仍可访问工作区外的任意文件）
 *   2. "./" "../" 开头     → 相对项目目录(process.cwd())，作为显式逃生舱
 *   3. 其它相对路径        → 先在工作区里找；找不到再退回项目目录（向后兼容，并给出提示）
 *
 * 也就是说：把 Excel 丢进工作区，然后直接说「读 成绩表.xlsx」就能用，不必关心启动目录。
 */

import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'

/** 工作区根目录：环境变量 WORKSPACE_DIR 优先，默认 <项目目录>/workspace */
export const WORKSPACE_DIR = process.env.WORKSPACE_DIR?.trim()
  ? resolve(process.env.WORKSPACE_DIR.trim())
  : resolve('workspace')

/** 确保工作区目录存在（首次调用时创建） */
export function ensureWorkspace(): string {
  if (!existsSync(WORKSPACE_DIR)) {
    try {
      mkdirSync(WORKSPACE_DIR, { recursive: true })
    } catch {
      /* 目录创建失败时不阻塞工具执行，后续会以"文件不存在"报错 */
    }
  }
  return WORKSPACE_DIR
}

export type PathBase = 'absolute' | 'project' | 'workspace'

export interface ResolvedPath {
  /** 最终使用的绝对路径 */
  path: string
  /** 该路径是按哪个基准解析出来的 */
  base: PathBase
  /** 相对路径未命中工作区、退回项目目录时的提示（供工具回传给模型） */
  note?: string
}

/** 是否为显式的"项目目录相对路径"（./ 或 ../ 开头） */
export function isProjectRelative(input: string): boolean {
  return /^\.\.?[\\/]/.test(input) || input === '.' || input === '..'
}

/**
 * 把模型给的路径解析成绝对路径。读取与写入共用同一套顺序：
 * 工作区命中优先，其次项目目录，都不存在时按工作区路径返回（由调用方报"文件不存在"）
 */
export function resolveWorkspacePath(input: string): ResolvedPath {
  const raw = input.trim()
  if (isAbsolute(raw)) return { path: raw, base: 'absolute' }
  if (isProjectRelative(raw)) return { path: resolve(raw), base: 'project' }

  const inWorkspace = join(WORKSPACE_DIR, raw)
  if (existsSync(inWorkspace)) return { path: inWorkspace, base: 'workspace' }

  const inProject = resolve(raw)
  if (existsSync(inProject)) {
    return {
      path: inProject,
      base: 'project',
      note: `"${raw}" 不在工作区(${WORKSPACE_DIR})内，已按项目目录解析到 ${inProject}`,
    }
  }
  return { path: inWorkspace, base: 'workspace' }
}

/** 工作区路径 → 展示用的相对路径（工作区外的文件返回原路径） */
export function displayPath(absolutePath: string): string {
  const rel = relative(WORKSPACE_DIR, absolutePath)
  if (rel === '') return '.'
  if (rel.startsWith('..') || isAbsolute(rel)) return absolutePath
  return rel.replace(/\\/g, '/')
}

/** 列出工作区顶层内容（供系统提示与 list_directory 使用） */
export function listWorkspaceEntries(max = 25): string[] {
  const root = ensureWorkspace()
  let names: string[]
  try {
    names = readdirSync(root)
  } catch {
    return []
  }

  const lines: string[] = []
  for (const name of names.sort()) {
    const full = join(root, name)
    try {
      const stat = statSync(full)
      if (stat.isDirectory()) {
        let count = 0
        try {
          count = readdirSync(full).length
        } catch {
          /* ignore */
        }
        lines.push(`  - ${name}/  (目录, ${count} 项)`)
      } else {
        const kb = Math.max(1, Math.round(stat.size / 1024))
        lines.push(`  - ${name}  (${kb} KB)`)
      }
    } catch {
      lines.push(`  - ${name}`)
    }
  }

  if (lines.length > max) {
    return [...lines.slice(0, max), `  ... 还有 ${lines.length - max} 项（可用 list_directory 查看全部）`]
  }
  return lines
}

/**
 * 注入系统提示的工作区说明。
 * 注意：这里含"会变化的内容"（文件清单），所以放在系统提示的最后一段，避免破坏前面静态内容的 KV Cache 命中。
 */
export function workspacePromptSection(): string {
  const root = ensureWorkspace()
  const entries = listWorkspaceEntries()

  return `

# 工作区
用户的办公文档（Excel / Word / PDF）统一放在工作区：${root}
用相对路径时默认就在这里找，例如 read_excel({ path: "成绩表.xlsx", mode: "overview" })。
${entries.length > 0 ? `工作区当前内容：\n${entries.join('\n')}` : '工作区当前为空 —— 如果用户提到某个文档却找不到，请提示他把文件放进该目录。'}
访问项目代码等其它文件时，用 "./" 开头的相对路径（如 "./src/index.ts"），或直接用绝对路径。`
}
