import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { CommandRunner, findWindowsBash } from '../src/core/commandRunner'

let pty: typeof import('node-pty') | undefined
try { pty = createRequire(import.meta.url)('node-pty') } catch { /* unavailable on some CI hosts */ }
const bash = process.platform === 'win32' ? findWindowsBash() : fs.existsSync('/bin/bash')

describe.skipIf(!pty || !bash || process.env.WSB_SKIP_REAL_PTY === '1')('真实 Bash 特殊字符', () => {
  it.each([
    [String.raw`printf '%s' "hello!!"`, 'hello!!'],
    [String.raw`printf '%s' 'C:\temp\folder\name'`, String.raw`C:\temp\folder\name`],
    [String.raw`printf '%s' "a\\b"`, String.raw`a\b`],
    [String.raw`printf '%s' 'single "double" $literal'`, 'single "double" $literal'],
    [String.raw`WSB_TEST_VALUE=expanded; printf '%s' "$WSB_TEST_VALUE"`, 'expanded']
  ])('保持正常 shell 语义：%s', async (command, expected) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-chars-'))
    const runner = new CommandRunner({ loadPty: async () => pty! })
    try {
      await runner.run('characters', root, { command: 'echo previous-history-entry', timeout_ms: 30000 })
      const result = await runner.run('characters', root, { command, timeout_ms: 30000 })
      expect(result.status).toBe('completed')
      expect(result.exit_code).toBe(0)
      expect(result.output.trim()).toBe(expected)
    } finally {
      runner.dispose()
      await new Promise((resolve) => setTimeout(resolve, 500))
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    }
  }, 60000)
})
