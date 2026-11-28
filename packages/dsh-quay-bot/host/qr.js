/**
 * 零依赖 QR 编码器（byte 模式，纠错等级 M，版本 1–10）。
 *
 * 只需要把一条 URL（≤ 213 字节）编码成可扫描的矩阵，所以砍掉了多模式混合、
 * 版本 11+、其他纠错等级等分支；矩阵生成、掩码选择、RS 纠错都按 ISO/IEC 18004 走。
 *
 * 对外接口：
 *   qrMatrix(text)              → { size, modules: boolean[][], version, mask, ec }
 *   qrSvg(text, options)        → SVG 字符串（含静区）
 *   qrDataUrl(text, options)    → data:image/svg+xml;base64,…
 */

const EC_M = 'M'
const EC_M_FORMAT_BITS = 0b00 // M = 00

const CAPACITY_BYTES_M = [0, 14, 26, 42, 62, 84, 106, 122, 152, 180, 213]
// [数据块数, 每块数据码字, 每块纠错码字]（版本 1–10，等级 M）
const BLOCKS_M = {
  1: [[1, 16, 10]],
  2: [[1, 28, 16]],
  3: [[1, 44, 26]],
  4: [[2, 32, 18]],
  5: [[2, 43, 24]],
  6: [[4, 27, 16]],
  7: [[4, 31, 18]],
  8: [[2, 38, 22], [2, 39, 22]],
  9: [[3, 36, 22], [2, 37, 22]],
  10: [[4, 43, 26], [1, 44, 26]],
}
// 字符计数指示符位宽：版本 1–9 为 8，10+ 为 16
const COUNT_BITS = (version) => (version <= 9 ? 8 : 16)
const ALIGNMENT = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50],
}

function totalCodewords(version) {
  let total = 0
  for (const [count, dataLen, ecLen] of BLOCKS_M[version]) total += count * (dataLen + ecLen)
  return total
}

function dataCodewords(version) {
  let total = 0
  for (const [count, dataLen] of BLOCKS_M[version]) total += count * dataLen
  return total
}

function pickVersion(byteLength) {
  for (let version = 1; version <= 10; version += 1) {
    if (byteLength <= CAPACITY_BYTES_M[version]) return version
  }
  throw new Error(`内容过长（${byteLength} 字节），本编码器上限 ${CAPACITY_BYTES_M[10]} 字节`)
}

// ───────────────────────── GF(256) / Reed–Solomon ─────────────────────────

const EXP = new Uint8Array(512)
const LOG = new Uint8Array(256)
;(() => {
  let value = 1
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = value
    LOG[value] = i
    value <<= 1
    if (value & 0x100) value ^= 0x11d
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255]
})()

const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]])

function rsGenerator(degree) {
  let poly = [1]
  for (let i = 0; i < degree; i += 1) {
    const next = new Array(poly.length + 1).fill(0)
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j]
      next[j + 1] ^= gfMul(poly[j], EXP[i])
    }
    poly = next
  }
  return poly
}

function rsEncode(data, ecLen) {
  const generator = rsGenerator(ecLen)
  const remainder = new Uint8Array(ecLen)
  for (const byte of data) {
    const factor = byte ^ remainder[0]
    remainder.copyWithin(0, 1)
    remainder[ecLen - 1] = 0
    if (factor !== 0) {
      for (let i = 0; i < ecLen; i += 1) remainder[i] ^= gfMul(generator[i + 1], factor)
    }
  }
  return remainder
}

// ───────────────────────── 位流 ─────────────────────────

class BitBuffer {
  constructor() {
    this.bits = []
  }

  push(value, length) {
    for (let i = length - 1; i >= 0; i -= 1) this.bits.push((value >>> i) & 1)
  }

  get length() {
    return this.bits.length
  }

  toBytes() {
    const bytes = []
    for (let i = 0; i < this.bits.length; i += 8) {
      let byte = 0
      for (let j = 0; j < 8; j += 1) byte = (byte << 1) | (this.bits[i + j] ?? 0)
      bytes.push(byte)
    }
    return Buffer.from(bytes)
  }
}

function buildDataCodewords(text, version) {
  const data = Buffer.from(text, 'utf8')
  const capacityBits = dataCodewords(version) * 8
  const buffer = new BitBuffer()
  buffer.push(0b0100, 4) // byte mode
  buffer.push(data.length, COUNT_BITS(version))
  for (const byte of data) buffer.push(byte, 8)
  const terminator = Math.min(4, capacityBits - buffer.length)
  if (terminator > 0) buffer.push(0, terminator)
  while (buffer.length % 8 !== 0) buffer.push(0, 1)
  const bytes = [...buffer.toBytes()]
  let pad = 0
  while (bytes.length < dataCodewords(version)) {
    bytes.push(pad % 2 === 0 ? 0xec : 0x11)
    pad += 1
  }
  if (bytes.length !== dataCodewords(version)) throw new Error('数据码字填充异常')
  return bytes
}

function splitBlocks(version, dataBytes) {
  const blocks = []
  let cursor = 0
  for (const [count, dataLen, ecLen] of BLOCKS_M[version]) {
    for (let i = 0; i < count; i += 1) {
      const data = dataBytes.slice(cursor, cursor + dataLen)
      cursor += dataLen
      blocks.push({ data, ec: rsEncode(data, ecLen), ecLen })
    }
  }
  if (cursor !== dataBytes.length) throw new Error('分块长度与容量不匹配')
  return blocks
}

function interleave(blocks) {
  const out = []
  const maxData = Math.max(...blocks.map((block) => block.data.length))
  for (let i = 0; i < maxData; i += 1) {
    for (const block of blocks) {
      if (i < block.data.length) out.push(block.data[i])
    }
  }
  const maxEc = Math.max(...blocks.map((block) => block.ec.length))
  for (let i = 0; i < maxEc; i += 1) {
    for (const block of blocks) {
      if (i < block.ec.length) out.push(block.ec[i])
    }
  }
  return Buffer.from(out)
}

// ───────────────────────── 矩阵 ─────────────────────────

const MASKS = [
  (row, col) => (row + col) % 2 === 0,
  (row) => row % 2 === 0,
  (row, col) => col % 3 === 0,
  (row, col) => (row + col) % 3 === 0,
  (row, col) => (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0,
  (row, col) => ((row * col) % 2) + ((row * col) % 3) === 0,
  (row, col) => (((row * col) % 2) + ((row * col) % 3)) % 2 === 0,
  (row, col) => (((row + col) % 2) + ((row * col) % 3)) % 2 === 0,
]

function createMatrix(version) {
  const size = version * 4 + 17
  const modules = Array.from({ length: size }, () => new Array(size).fill(false))
  const reserved = Array.from({ length: size }, () => new Array(size).fill(false))
  const set = (row, col, dark) => {
    if (row < 0 || col < 0 || row >= size || col >= size) return
    modules[row][col] = dark
    reserved[row][col] = true
  }
  const finder = (row, col) => {
    for (let r = -1; r <= 7; r += 1) {
      for (let c = -1; c <= 7; c += 1) {
        const rr = row + r
        const cc = col + c
        if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue
        const inside = r >= 0 && r <= 6 && c >= 0 && c <= 6
        const ring = inside && (r === 0 || r === 6 || c === 0 || c === 6)
        const core = inside && r >= 2 && r <= 4 && c >= 2 && c <= 4
        set(rr, cc, ring || core)
      }
    }
  }
  finder(0, 0)
  finder(0, size - 7)
  finder(size - 7, 0)

  for (let i = 8; i < size - 8; i += 1) {
    set(6, i, i % 2 === 0)
    set(i, 6, i % 2 === 0)
  }
  const centers = ALIGNMENT[version]
  for (const row of centers) {
    for (const col of centers) {
      if ((row <= 7 && col <= 7) || (row <= 7 && col >= size - 8) || (row >= size - 8 && col <= 7)) continue
      for (let r = -2; r <= 2; r += 1) {
        for (let c = -2; c <= 2; c += 1) {
          const dark = Math.max(Math.abs(r), Math.abs(c)) !== 1
          set(row + r, col + c, dark)
        }
      }
    }
  }

  // 固定功能：暗模块、格式信息占位、版本信息（v>=7）
  set(size - 8, 8, true)
  for (let i = 0; i <= 8; i += 1) {
    if (i !== 6) {
      set(8, i, false)
      set(i, 8, false)
    }
  }
  for (let i = 0; i < 8; i += 1) {
    set(8, size - 1 - i, false)
    set(size - 1 - i, 8, false)
  }
  if (version >= 7) {
    for (let i = 0; i < 18; i += 1) {
      const row = Math.floor(i / 3)
      const col = (i % 3) + size - 11
      set(row, col, false)
      set(col, row, false)
    }
  }
  return { size, modules, reserved, set }
}

function formatBits(mask) {
  const data = (EC_M_FORMAT_BITS << 3) | mask
  let value = data << 10
  const generator = 0b10100110111
  for (let i = 4; i >= 0; i -= 1) {
    if ((value >>> (10 + i)) & 1) value ^= generator << i
  }
  return ((data << 10) | value) ^ 0b101010000010010
}

function versionBits(version) {
  let value = version << 12
  const generator = 0b1111100100101
  for (let i = 5; i >= 0; i -= 1) {
    if ((value >>> (12 + i)) & 1) value ^= generator << i
  }
  return (version << 12) | value
}

function placeFormat(matrix, mask) {
  const bits = formatBits(mask)
  const { size, set } = matrix
  const bit = (i) => ((bits >>> i) & 1) === 1
  for (let i = 0; i < 15; i += 1) {
    const dark = bit(i)
    // 竖排副本（列 8）：左上 0–5、7–8，左下 size-7…size-1
    if (i < 6) set(i, 8, dark)
    else if (i < 8) set(i + 1, 8, dark)
    else set(size - 15 + i, 8, dark)
    // 横排副本（行 8）：右上 size-1…size-8，左上 7、5…0
    if (i < 8) set(8, size - 1 - i, dark)
    else if (i < 9) set(8, 7, dark)
    else set(8, 14 - i, dark)
  }
  set(size - 8, 8, true)
}

function placeVersion(matrix, version) {
  if (version < 7) return
  const bits = versionBits(version)
  const { size, set } = matrix
  for (let i = 0; i < 18; i += 1) {
    const dark = ((bits >>> i) & 1) === 1
    const row = Math.floor(i / 3)
    const col = (i % 3) + size - 11
    set(row, col, dark)
    set(col, row, dark)
  }
}

function placeData(matrix, codewords, maskIndex) {
  const { size, modules, reserved } = matrix
  const mask = MASKS[maskIndex]
  let bitIndex = 0
  const totalBits = codewords.length * 8
  let upward = true
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col -= 1
    for (let step = 0; step < size; step += 1) {
      const row = upward ? size - 1 - step : step
      for (let c = 0; c < 2; c += 1) {
        const actualCol = col - c
        if (reserved[row][actualCol]) continue
        const bit = bitIndex < totalBits ? ((codewords[bitIndex >> 3] >>> (7 - (bitIndex & 7))) & 1) === 1 : false
        modules[row][actualCol] = bit !== mask(row, actualCol)
        bitIndex += 1
      }
    }
    upward = !upward
  }
  if (bitIndex < totalBits) throw new Error('数据未完全排布')
}

function penalty(modules) {
  const size = modules.length
  let score = 0
  // N1: 连续同色 ≥5
  for (let i = 0; i < size; i += 1) {
    let runRow = 1
    let runCol = 1
    for (let j = 1; j < size; j += 1) {
      if (modules[i][j] === modules[i][j - 1]) runRow += 1
      else {
        if (runRow >= 5) score += 3 + (runRow - 5)
        runRow = 1
      }
      if (modules[j][i] === modules[j - 1][i]) runCol += 1
      else {
        if (runCol >= 5) score += 3 + (runCol - 5)
        runCol = 1
      }
    }
    if (runRow >= 5) score += 3 + (runRow - 5)
    if (runCol >= 5) score += 3 + (runCol - 5)
  }
  // N2: 2x2 同色块
  for (let r = 0; r < size - 1; r += 1) {
    for (let c = 0; c < size - 1; c += 1) {
      const value = modules[r][c]
      if (value === modules[r][c + 1] && value === modules[r + 1][c] && value === modules[r + 1][c + 1]) score += 3
    }
  }
  // N3: 1:1:3:1:1 比例（两侧 4 白）
  const pattern = [true, false, true, true, true, false, true]
  const matches = (line, start) => {
    for (let i = 0; i < 7; i += 1) if (line[start + i] !== pattern[i]) return false
    const before = line.slice(Math.max(0, start - 4), start)
    const after = line.slice(start + 7, start + 11)
    return before.every((value) => value === false) || after.every((value) => value === false)
  }
  for (let i = 0; i < size; i += 1) {
    const row = modules[i]
    const col = modules.map((line) => line[i])
    for (let j = 0; j <= size - 7; j += 1) {
      if (matches(row, j)) score += 40
      if (matches(col, j)) score += 40
    }
  }
  // N4: 暗色比例
  let dark = 0
  for (const row of modules) for (const value of row) if (value) dark += 1
  const ratio = (dark * 100) / (size * size)
  score += Math.floor(Math.abs(ratio - 50) / 5) * 10
  return score
}

/** 生成矩阵（不缓存，调用方自行按内容缓存）。 */
export function qrMatrix(text, { ec = EC_M } = {}) {
  if (ec !== EC_M) throw new Error(`仅支持纠错等级 ${EC_M}`)
  const payload = String(text ?? '')
  if (payload.length === 0) throw new Error('内容不能为空')
  const version = pickVersion(Buffer.byteLength(payload, 'utf8'))
  const dataBytes = buildDataCodewords(payload, version)
  const blocks = splitBlocks(version, dataBytes)
  const codewords = interleave(blocks)

  let best = null
  for (let mask = 0; mask < 8; mask += 1) {
    const matrix = createMatrix(version)
    placeData(matrix, codewords, mask)
    placeFormat(matrix, mask)
    placeVersion(matrix, version)
    const score = penalty(matrix.modules)
    if (!best || score < best.score) best = { score, mask, matrix }
  }
  return {
    size: best.matrix.size,
    modules: best.matrix.modules,
    version,
    mask: best.mask,
    ec,
    dataCodewords: dataCodewords(version),
    totalCodewords: totalCodewords(version),
  }
}

/** 渲染为 SVG（静区默认 4 模块）。 */
export function qrSvg(text, { scale = 6, margin = 4, dark = '#0b0d10', light = '#ffffff' } = {}) {
  const { size, modules } = qrMatrix(text)
  const dimension = (size + margin * 2) * scale
  const parts = []
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      if (!modules[row][col]) continue
      parts.push(`<rect x="${(col + margin) * scale}" y="${(row + margin) * scale}" width="${scale}" height="${scale}"/>`)
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${dimension}" height="${dimension}" viewBox="0 0 ${dimension} ${dimension}" shape-rendering="crispEdges"><rect width="${dimension}" height="${dimension}" fill="${light}"/><g fill="${dark}">${parts.join('')}</g></svg>`
}

export function qrDataUrl(text, options) {
  return `data:image/svg+xml;base64,${Buffer.from(qrSvg(text, options), 'utf8').toString('base64')}`
}