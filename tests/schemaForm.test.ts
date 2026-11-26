import { describe, expect, it } from 'vitest'
import { argsToValues, defaultValues, prettyText, schemaToFields, valuesToArgs } from '../src/renderer/src/lib/schemaForm'

const schema = {
  type: 'object',
  properties: {
    limit: { type: 'integer', description: '最多几条', default: 30 },
    path: { type: 'string', description: '工作区相对路径' },
    content: { type: 'string' },
    ratio: { type: 'number' },
    recursive: { type: 'boolean' },
    mode: { type: 'string', enum: ['a', 'b'] },
    level: { enum: [1, 2, 3] },
    tags: { type: 'array', items: { type: 'string' } },
    ids: { type: 'array', items: { type: 'integer' } },
    opts: { type: 'object', properties: { x: { type: 'string' } } },
    maybe: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    nullable: { type: ['number', 'null'] },
    edits: { type: 'array', items: { type: 'object' } }
  },
  required: ['path', 'content']
}

describe('schemaToFields', () => {
  const fields = schemaToFields(schema)
  const by = Object.fromEntries(fields.map((f) => [f.name, f]))

  it('按类型选控件，必填排前面并标出来', () => {
    expect(fields.slice(0, 2).map((f) => f.name)).toEqual(['path', 'content'])
    expect(by.path).toMatchObject({ kind: 'string', required: true, description: '工作区相对路径' })
    // 参数名像正文的用多行文本
    expect(by.content).toMatchObject({ kind: 'text', required: true })
    expect(by.limit).toMatchObject({ kind: 'integer', required: false, default: 30 })
    expect(by.ratio.kind).toBe('number')
    expect(by.recursive.kind).toBe('boolean')
    expect(by.mode).toMatchObject({ kind: 'enum', options: ['a', 'b'] })
    expect(by.level).toMatchObject({ kind: 'enum', options: [1, 2, 3] })
    expect(by.tags).toMatchObject({ kind: 'lines', itemKind: 'string' })
    expect(by.ids).toMatchObject({ kind: 'lines', itemKind: 'integer' })
    expect(by.opts.kind).toBe('json')
    // 对象数组装不进「一行一项」
    expect(by.edits.kind).toBe('json')
  })

  it('可空类型去掉 null 分支；const 的 anyOf 当枚举', () => {
    expect(by.maybe.kind).toBe('string')
    expect(by.nullable.kind).toBe('number')
    const f = schemaToFields({ type: 'object', properties: { k: { oneOf: [{ const: 'x' }, { const: 'y' }] } } })
    expect(f[0]).toMatchObject({ kind: 'enum', options: ['x', 'y'] })
  })

  it('没有 properties：空表单', () => {
    expect(schemaToFields({ type: 'object' })).toEqual([])
    expect(schemaToFields(undefined)).toEqual([])
  })
})

describe('valuesToArgs', () => {
  const fields = schemaToFields(schema)

  it('按类型转换；空着的可选项不传', () => {
    const args = valuesToArgs(fields, {
      path: 'a.txt',
      content: '',
      limit: ' 5 ',
      ratio: '0.5',
      recursive: 'false',
      mode: '1',
      level: '2',
      tags: 'x\n\n  y  \n',
      ids: '1\n2',
      opts: '{"x":"1"}'
    })
    expect(args).toEqual({ path: 'a.txt', content: '', limit: 5, ratio: 0.5, recursive: false, mode: 'b', level: 3, tags: ['x', 'y'], ids: [1, 2], opts: { x: '1' } })
  })

  it('必填空着、格式不对时报错，报出参数名', () => {
    // 必填的字符串空着传 ''（合法值）；必填的非字符串空着才报错
    expect(valuesToArgs(fields, { path: '' })).toEqual({ path: '', content: '' })
    const req = schemaToFields({ type: 'object', properties: { n: { type: 'integer' }, tags: { type: 'array', items: { type: 'string' } } }, required: ['n', 'tags'] })
    expect(() => valuesToArgs(req, { tags: 'a' })).toThrow('「n」是必填项')
    expect(() => valuesToArgs(req, { n: '1', tags: '\n \n' })).toThrow('「tags」是必填项')
    expect(() => valuesToArgs(fields, { path: 'a', content: 'c', limit: '1.5' })).toThrow('「limit」要填整数')
    expect(() => valuesToArgs(fields, { path: 'a', content: 'c', ratio: 'abc' })).toThrow('「ratio」不是数字')
    expect(() => valuesToArgs(fields, { path: 'a', content: 'c', ids: '1\nx' })).toThrow('「ids」第 2 行')
    expect(() => valuesToArgs(fields, { path: 'a', content: 'c', opts: '{bad' })).toThrow('「opts」不是合法的 JSON')
  })
})

describe('argsToValues / defaultValues', () => {
  const fields = schemaToFields(schema)

  it('参数回填表单，再转回来不变', () => {
    const args = { path: 'a.txt', content: 'hi', limit: 3, recursive: true, mode: 'a', level: 1, tags: ['p', 'q'], opts: { x: 'y' } }
    const values = argsToValues(fields, args)
    expect(values).toMatchObject({ limit: '3', recursive: 'true', mode: '0', level: '0', tags: 'p\nq' })
    expect(valuesToArgs(fields, values)).toEqual(args)
  })

  it('不在选项里的枚举值、表单里没有的键不回填', () => {
    expect(argsToValues(fields, { mode: 'zzz', unknown: 1 })).toEqual({})
  })

  it('初始值取 schema 的 default', () => {
    expect(defaultValues(fields)).toEqual({ limit: '30' })
  })
})

describe('prettyText', () => {
  it('JSON 格式化，不是 JSON 原样', () => {
    expect(prettyText('{"a":1}')).toEqual({ json: true, text: '{\n  "a": 1\n}' })
    expect(prettyText('[1,2]').json).toBe(true)
    expect(prettyText('hello')).toEqual({ json: false, text: 'hello' })
    expect(prettyText('{not json')).toEqual({ json: false, text: '{not json' })
  })
})
