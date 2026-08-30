import test from 'node:test';
import assert from 'node:assert/strict';
import { canEditDecision, validateDecision, hasDecisionFields } from '../src/decision.js';
import { validateFeedback } from '../src/domain.js';

test('decision values, routing and expected version are strict', () => {
  const base = {chris_decision:'to_do',decision_destination:'auto',decision_note:'',expected_version:0};
  for (const [chris_decision, decision_destination] of [['to_triage','none'],['to_do','auto'],['to_do','chatgpt'],['to_do','codex'],['to_discuss','chatgpt'],['not_needed','none']]) {
    assert.ok(validateDecision({...base,chris_decision,decision_destination}));
  }
  for (const extra of [{chris_decision:'unknown'},{chris_decision:'toString'},{decision_destination:'root'},{chris_decision:'to_discuss',decision_destination:'codex'},{chris_decision:'not_needed',decision_destination:'chatgpt'},{expected_version:-1},{expected_version:'0'},{expected_version:1.5},{expected_version:2147483647},{decision_note:null},{decision_note:'a'.repeat(1001)},{decision_note:'a\0b'},{status:'closed'}]) {
    assert.equal(validateDecision({...base,...extra}),null);
  }
  for (const value of [null,[],true,'to_do',{}]) assert.equal(validateDecision(value),null);
  assert.equal(validateDecision({...base,chris_decision:['to_do']}),null);
  assert.equal(validateDecision({...base,decision_note:'  Discussion  '}).decision_note,'Discussion');
  assert.ok(validateDecision({...base,decision_note:'😀'.repeat(1000)}));
});

test('only an authorized human session can decide, not even a full admin bearer', () => {
  const actor={kind:'service',session_hash:'test',credential_id:'test',scopes:['feedback:read','feedback:write']};
  assert.equal(canEditDecision(actor),true);
  for (const extra of [{session_hash:undefined},{credential_id:undefined},{kind:'installation'},{scopes:['feedback:read']}]) assert.equal(canEditDecision({...actor,...extra}),false);
  assert.equal(canEditDecision(null),false);
});

test('SDK reporters cannot assign Chris decision fields', () => {
  for(const key of ['chris_decision','decision_destination','decision_note','decision_version','decision_updated_at','expected_version']) {
    assert.equal(hasDecisionFields({[key]:'forged'}),true);
    assert.equal(validateFeedback({type:'bug',message:'test',[key]:'forged'}),null);
  }
  assert.ok(validateFeedback({type:'bug',message:'ordinary report'}));
});
