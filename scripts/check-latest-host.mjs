#!/usr/bin/env node
/**
 * 宿主兼容性检查：用 **npm 最新版** 的 @deepseek-ai 类型给本插件的 src 做一次 typecheck。
 *
 * 为什么需要它：上游这些包的 peerDependencies 钉死在具体 rc 上，直接把自己的
 * devDependencies 升到最新版时，npm 会连带删掉中间传递依赖（例如 @deepseek-ai/dsh-scope），
 * 本地树就坏了。所以做法是——本地 devDependencies 跟随"当前已装版本"，
 * 另开一个临时目录装最新版类型来跑 tsc，两边都过才算兼容。
 *
 * 用法：node scripts/check-latest-host.mjs        （默认 latest）
 *      node scripts/check-latest-host.mjs 0.2.1-rc.5
 */
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const version = process.argv[2] ?? 'latest'
const PKGS = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/schemastery',
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-attachment',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-tools',
  // 类型检查还要这两个：Node 内置类型、ws 的类型
  '@types/node',
  '@types/ws',
]

const work = join(tmpdir(), 'dsh-napcat-host-compat-' + Date.now())
const env = { ...process.env }
delete env.npm_config_allow_scripts // npm 12 会因此报 EALLOWSCRIPTS

function run(command, args, cwd) {
  return execFileSync(command, args, { cwd, env, stdio: 'inherit', shell: process.platform === 'win32' })
}

try {
  mkdirSync(work, { recursive: true })
  cpSync(join(root, 'src'), join(work, 'src'), { recursive: true })
  cpSync(join(root, 'tsconfig.json'), join(work, 'tsconfig.json'))
  writeFileSync(join(work, 'package.json'), JSON.stringify({ name: 'host-compat-check', private: true, type: 'module' }, null, 2))

  // cordis / schemastery 用 latest 自己的 dist-tag（它们的版本号独立于 dsh）
  const specs = PKGS.map(pkg => pkg.startsWith('@types/') || pkg.endsWith('cordis') || pkg.endsWith('schemastery') ? pkg : pkg + '@' + version)
  console.log('[compat] 安装宿主类型：' + specs.join(' '))
  run('npm', ['install', '--no-save', '--legacy-peer-deps', '--no-audit', '--no-fund', ...specs], work)

  console.log('[compat] 用这些类型 typecheck 本插件 src（目标：' + version + '）')
  const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc')
  run(process.execPath, [tsc, '-p', join(work, 'tsconfig.json'), '--noEmit'], work)
  console.log('[compat] ✓ 与 ' + version + ' 类型兼容')
} catch (error) {
  console.error('[compat] ✗ 不兼容：' + (error instanceof Error ? error.message : String(error)))
  process.exitCode = 1
} finally {
  rmSync(work, { recursive: true, force: true })
}
