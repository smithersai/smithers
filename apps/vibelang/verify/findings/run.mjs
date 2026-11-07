// Concrete runtime counterexamples; these execute the production module, not a model.
import assert from 'node:assert/strict'
import { apply, decide, empty } from '../../src/core/conversation.ts'
const reply = apply(empty, { type: 'ReplyStarted', seq: 1, id: '' })
assert.equal(reply.agent, 'working')
assert.equal(reply.replying, '')
console.log(JSON.stringify({ finding: 'empty reply id', input: { type: 'ReplyStarted', seq: 1, id: '' }, output: reply, invariant: (reply.agent === 'working') === (reply.replying !== '') }))
const event = { type: 'Posted', seq: 1, id: 'm1', clientId: '', name: 'Ada', text: 'hi' }
const twice = apply(apply(empty, event), { ...event, seq: 2, id: 'm2' })
assert.equal(twice.entries.length, 2)
assert.equal(twice.entries[0].clientId, twice.entries[1].clientId)
console.log(JSON.stringify({ finding: 'empty person client id', inputs: [event, { ...event, seq: 2, id: 'm2' }], output: twice, invariant: false }))
const huge = { ...empty, seq: 9007199254740992 }
const decision = decide(huge, { type: 'StartReply', id: 'r1' })
assert.equal(decision.ok, true)
assert.equal(decision.event.seq, huge.seq)
console.log(JSON.stringify({ finding: 'outside safe sequence bound', input: huge.seq, eventSeq: decision.event.seq, advances: decision.event.seq > huge.seq }))
