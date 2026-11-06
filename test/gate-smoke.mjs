// 闸门判定回归测试：只 import 插件并注入假 ctx，不安装、不改任何文件。
// 运行：node dsh-workspace-mgr/test/gate-smoke.mjs
import { apply } from '../index.js'

const listeners = {}
const effects = []
const ctx = {
  logger: { info() {}, warn: (...a) => console.warn('[warn]', ...a) },
  get(name) {
    if (name === 'systemPrompt') return { section: () => () => {} }
    return undefined
  },
  on(event, fn) {
    listeners[event] = fn
    return () => {}
  },
  effect(fn) {
    const d = fn()
    effects.push(d)
    return () => {}
  },
}

await apply(ctx, { scanRoots: [] })
const gate = listeners['tools/pre-execute']
if (!gate) throw new Error('pre-execute listener 未注册')

const next = async () => ({ kind: 'allow' })
const cases = [
  ['新建 C 盘目录', { name: 'ops_bash', arguments: { command: 'mkdir -p "C:\\\\w9\\\\dec"' } }, 'deny'],
  ['读 C 盘既有目录', { name: 'ops_bash', arguments: { command: 'ls "C:\\\\Windows"' } }, 'allow'],
  ['write 到 C 盘', { name: 'write', arguments: { file_path: 'C:\\\\w9\\\\a.txt' } }, 'deny'],
  ['write 到工作区', { name: 'write', arguments: { file_path: 'E:\\\\DSH項目\\\\x.txt' } }, 'allow'],
  ['只读工具', { name: 'read', arguments: { file_path: 'C:\\\\w9\\\\a.txt' } }, 'allow'],
  ['bash 里带 C 盘输出重定向', { name: 'ops_bash', arguments: { command: 'apktool d in.apk -o C:/rev/dec' } }, 'deny'],
  ['temp 白名单', { name: 'write', arguments: { file_path: 'C:\\\\Users\\\\Administrator\\\\AppData\\\\Local\\\\Temp\\\\x.txt' } }, 'allow'],
]

let fail = 0
for (const [label, exec, expect] of cases) {
  const decision = await gate(exec, next)
  const got = decision?.kind ?? 'undefined'
  const ok = got === expect
  if (!ok) fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  期望=${expect} 实际=${got}`)
  if (!ok && decision?.reason) console.log('       reason:', String(decision.reason).split('\n')[0])
}

// 打印一次完整 deny reason，检查给模型看的指令是否可执行
const sample = await gate({ name: 'ops_bash', arguments: { command: 'mkdir -p C:\\\\w1' }, agent: { id: 'session-test' } }, next)
console.log('\n--- deny reason 样例 ---')
console.log(sample.reason)

process.exit(fail === 0 ? 0 : 1)
