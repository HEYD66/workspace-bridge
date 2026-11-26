import fs from 'node:fs'
import path from 'node:path'

/** 小型 JSON 文件存储：同步读、原子写（临时文件 + rename），损坏时备份原文件再从空开始 */
export class JsonStore<T> {
  private data: T

  constructor(
    readonly file: string,
    private readonly empty: () => T,
    private readonly onChange?: () => void
  ) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    this.data = this.load()
  }

  private load(): T {
    if (!fs.existsSync(this.file)) return this.empty()
    try {
      return { ...this.empty(), ...JSON.parse(fs.readFileSync(this.file, 'utf8')) }
    } catch {
      // 不静默丢数据：损坏的文件留一份备份
      fs.copyFileSync(this.file, `${this.file}.corrupt-${Date.now()}`)
      return this.empty()
    }
  }

  get(): T {
    return this.data
  }

  set(next: T): void {
    this.data = next
    const tmp = `${this.file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
    fs.renameSync(tmp, this.file)
    this.onChange?.()
  }

  mutate(fn: (draft: T) => void): T {
    const draft = structuredClone(this.data)
    fn(draft)
    this.set(draft)
    return draft
  }
}
