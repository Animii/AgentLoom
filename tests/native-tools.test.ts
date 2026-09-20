import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeToolStream } from '../src/shared/native-tools.js';

test('Codex native tools update by ID, preserve start and report command failure without raw output',()=>{
 const parser=new NativeToolStream('codex');
 const start=parser.accept(JSON.stringify({type:'item.started',item:{id:'item_1',type:'command_execution',command:'npm test',status:'in_progress'}}),'2026-01-01T00:00:00Z')[0];
 const end=parser.accept(JSON.stringify({type:'item.completed',item:{id:'item_1',type:'command_execution',command:'npm test',exit_code:1,aggregated_output:'private file content'}}),'2026-01-01T00:00:01Z')[0];
 assert.equal(start.status,'running');assert.equal(end.id,start.id);assert.equal(end.startedAt,start.startedAt);assert.equal(end.status,'failed');assert.equal(end.summary,'Exit code 1');assert.ok(!JSON.stringify(end).includes('private file content'));
});
test('legacy truncated command completion is visible without claiming success',()=>{
 const parser=new NativeToolStream('codex');
 const call=parser.accept('{"type":"item.completed","item":{"id":"item_4","type":"command_execution","command":"cat README.md","aggregated_output":"too long', 'now')[0];
 assert.equal(call.input.command,'cat README.md');assert.equal(call.status,'unknown');
});
test('Claude joins tool use and results, OpenCode maps errors, and credentials are redacted',()=>{
 const parser=new NativeToolStream('claude');
 parser.accept(JSON.stringify({type:'assistant',message:{content:[{type:'tool_use',id:'tool-1',name:'Bash',input:{command:'TOKEN=secret-value npm test'}}]}}),'1');
 const call=parser.accept(JSON.stringify({type:'user',message:{content:[{type:'tool_result',tool_use_id:'tool-1',is_error:true,content:'private output'}]}}),'2')[0];
 assert.equal(call.name,'Bash');assert.equal(call.status,'failed');assert.equal(call.startedAt,'1');assert.ok(!JSON.stringify(call).includes('secret-value'));
 const open=new NativeToolStream('opencode').accept(JSON.stringify({type:'tool_use',part:{callID:'call1',tool:'read',state:{status:'completed',input:{filePath:'README.md'},output:'file content'}}}),'3')[0];
 assert.equal(open.status,'completed');assert.equal(open.input.filePath,'README.md');
 assert.equal(new NativeToolStream('codex').accept('{"type":"item.completed","item":{"type":"agent_message","text":"hello"}}','4').length,0);
});
