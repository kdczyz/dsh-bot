/**
 * The Bot page renders a Host-folded transcript because a Bot Session never
 * enters the Client Session list. These cases pin the folding contract: real
 * user turns only, assistant prose plus its reasoning and tool trajectory, and
 * a cursor so a polling reader pays for the new turn rather than the log.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { foldTranscript } from '../host/transcript.js'

const user = (seq, text, source = 'user') => ({
  type: 'user/message',
  seq,
  time: seq,
  data: { content: [{ type: 'text', text }], source: { kind: source }, role: 'user' },
})

const assistant = (seq, parts) => ({
  type: 'assistant/message',
  seq,
  time: seq,
  data: { turn: 1, step: 1, message: { role: 'assistant', content: parts } },
})

const call = (seq, callId, name, args) => ({
  type: 'tool/call',
  seq,
  time: seq,
  data: { turn: 1, step: 1, callId, name, arguments: JSON.stringify(args) },
})

const result = (seq, callId, text) => ({
  type: 'tool/result',
  seq,
  time: seq,
  data: { turn: 1, step: 1, message: { role: 'tool', toolCallId: callId, content: [{ type: 'text', text }] } },
})

test('foldTranscript: keeps a typed turn and drops host injections', () => {
  const turns = foldTranscript([
    user(1, '介绍一下自己'),
    user(2, 'The user changed the approval policy', 'user-approval'),
    user(3, 'current time is 09:00', 'time-context'),
    assistant(4, [{ type: 'text', text: '我是 lead。' }]),
  ])
  assert.deepEqual(turns.map(turn => turn.kind), ['user', 'assistant'])
  assert.equal(turns[0].text, '介绍一下自己')
  assert.equal(turns[1].blocks.length, 1)
  assert.deepEqual(turns[1].blocks[0], { kind: 'text', text: '我是 lead。' })
})

test('foldTranscript: reasoning and the tool trajectory survive', () => {
  const turns = foldTranscript([
    user(1, '跑一下测试'),
    assistant(2, [
      { type: 'reasoning', text: '先看目录' },
      { type: 'tool-call', id: 'call_a', name: 'bash', arguments: '{"command":"ls"}' },
    ]),
    call(3, 'call_a', 'bash', { command: 'ls' }),
    result(4, 'call_a', 'a.txt\nb.txt'),
    assistant(5, [{ type: 'text', text: '都通过了。' }]),
  ])
  assert.equal(turns.length, 3)
  const blocks = turns[1].blocks
  assert.equal(blocks[0].kind, 'reasoning')
  assert.equal(blocks[1].kind, 'tool')
  assert.equal(blocks[1].name, 'bash')
  assert.equal(blocks[1].call.status, 'done')
  assert.equal(blocks[1].call.output, 'a.txt\nb.txt')
  assert.equal(turns[1].streaming, false)
})

test('foldTranscript: a re-emitted turn carries the output it did not have yet', () => {
  const events = [
    assistant(2, [{ type: 'tool-call', id: 'call_c', name: 'bash', arguments: '{}' }]),
    result(3, 'call_c', 'done later'),
  ]
  // A cursor past the assistant message emits nothing until the overlap re-reads it.
  assert.deepEqual(foldTranscript(events, { after: 2 }), [])
  const reemitted = foldTranscript(events, { after: 1 })
  assert.equal(reemitted.length, 1)
  assert.equal(reemitted[0].key, 'a2')
  assert.equal(reemitted[0].blocks[0].call.status, 'done')
  assert.equal(reemitted[0].blocks[0].call.output, 'done later')
})

test('foldTranscript: a tool call without a result settles empty instead of vanishing', () => {
  const turns = foldTranscript([assistant(1, [{ type: 'tool-call', id: 'call_b', name: 'grep', arguments: '{}' }])])
  assert.equal(turns.length, 1)
  assert.equal(turns[0].blocks[0].call.status, 'done')
  assert.equal(turns[0].blocks[0].call.output, '')
})

test('foldTranscript: after emits only newer turns, limit keeps the newest', () => {
  const events = []
  for (let index = 0; index < 4; index += 1) {
    events.push(user(index * 2 + 1, `第 ${index} 条`))
    events.push(assistant(index * 2 + 2, [{ type: 'text', text: `回答 ${index}` }]))
  }
  const all = foldTranscript(events, 0)
  assert.equal(all.length, 8)
  const tail = foldTranscript(events, { limit: 3 })
  assert.deepEqual(tail.map(turn => turn.text ?? turn.blocks[0].text), ['回答 2', '第 3 条', '回答 3'])
  const fresh = foldTranscript(events, { after: 5 })
  assert.deepEqual(fresh.map(turn => turn.seq), [6, 7, 8])
  assert.deepEqual(foldTranscript([], 10), [])
  assert.deepEqual(foldTranscript(null, 10), [])
})

test('foldTranscript: image parts count without inventing prose', () => {
  const turns = foldTranscript([{
    type: 'user/message',
    seq: 1,
    time: 1,
    data: {
      content: [{ type: 'image', mediaType: 'image/png', attachmentId: 'sha256:abc' }, { type: 'text', text: '看图' }],
      source: { kind: 'user' },
    },
  }])
  assert.equal(turns.length, 1)
  assert.equal(turns[0].text, '看图')
  assert.equal(turns[0].images, 1)
})

test('foldTranscript: turn/end surfaces a failure and a stop', () => {
  const turns = foldTranscript([
    { type: 'turn/end', seq: 1, time: 1, data: { reason: { kind: 'error', error: { message: 'model exploded' } } } },
    { type: 'turn/end', seq: 2, time: 2, data: { reason: { kind: 'aborted' } } },
  ])
  assert.equal(turns[0].kind, 'error')
  assert.equal(turns[0].text, 'model exploded')
  assert.equal(turns[1].kind, 'notice')
})