import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { qrDataUrl, qrMatrix, qrSvg } from '../host/qr.js'

const fingerprint = (matrix) => createHash('sha256')
  .update(matrix.modules.map((row) => row.map((value) => (value ? '1' : '0')).join('')).join('\n'))
  .digest('hex')

test('矩阵尺寸与版本选择符合容量表', () => {
  assert.equal(qrMatrix('short').version, 1)
  assert.equal(qrMatrix('short').size, 21)
  assert.equal(qrMatrix('a'.repeat(14)).version, 1)
  assert.equal(qrMatrix('a'.repeat(15)).version, 2)
  assert.equal(qrMatrix('a'.repeat(26)).version, 2)
  assert.equal(qrMatrix('a'.repeat(27)).version, 3)
  assert.equal(qrMatrix('a'.repeat(213)).version, 10)
  assert.equal(qrMatrix('a'.repeat(213)).size, 57)
  assert.throws(() => qrMatrix('a'.repeat(214)), /内容过长/)
})

test('已知内容矩阵稳定（防回归）', () => {
  const a = qrMatrix('https://x.trycloudflare.com/#k=abcdefghijklmnopqrstuvwxyz0123456789ABCD')
  assert.equal(a.version, 5)
  assert.equal(a.mask, 2)
  assert.equal(fingerprint(a).startsWith('b12c8f39d0069040'), true)
})

test('功能性图形：三个定位角 + 时序线', () => {
  const { modules, size } = qrMatrix('hello')
  // 定位图案外圈应为暗
  assert.equal(modules[0][0], true)
  assert.equal(modules[0][6], true)
  assert.equal(modules[6][0], true)
  assert.equal(modules[3][3], true)
  assert.equal(modules[1][1], false)
  // 时序线交替
  for (let i = 8; i < size - 8; i += 1) {
    assert.equal(modules[6][i], i % 2 === 0)
    assert.equal(modules[i][6], i % 2 === 0)
  }
  // 暗模块固定位
  assert.equal(modules[size - 8][8], true)
})

test('不同内容产生不同矩阵', () => {
  const a = qrMatrix('https://a.example/#k=1')
  const b = qrMatrix('https://a.example/#k=2')
  assert.notEqual(fingerprint(a), fingerprint(b))
})

test('SVG 含静区且尺寸正确', () => {
  const svg = qrSvg('hello', { scale: 4, margin: 3 })
  const matrix = qrMatrix('hello')
  const expected = (matrix.size + 6) * 4
  assert.equal(svg.includes(`width="${expected}"`), true)
  assert.equal(svg.startsWith('<svg xmlns='), true)
  assert.equal(svg.includes('shape-rendering="crispEdges"'), true)
  assert.equal(svg.includes('<rect width='), true)
})

test('data URL 可被浏览器直接使用', () => {
  const url = qrDataUrl('hello')
  assert.equal(url.startsWith('data:image/svg+xml;base64,'), true)
  const decoded = Buffer.from(url.split(',')[1], 'base64').toString('utf8')
  assert.equal(decoded.startsWith('<svg'), true)
})

test('不可见字符也能编码（UTF-8 字节数决定版本）', () => {
  const zh = qrMatrix('远程访问🔒')
  assert.ok(zh.size >= 21)
  assert.equal(zh.ec, 'M')
})