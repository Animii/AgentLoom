import { buildArguments } from '../src/server/provider-process.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createExecutor } from '../src/server/providers.js';
import type { StepDefinition, AgentEvent } from '../src/shared/types.js';
const step:StepDefinition={id:'build',name:'Build',role:'Implementer',provider:'opencode',model:'deepseek/deepseek-flash',effort:'max',instructions:'',access:'workspace-write',approval:true};
test('real process boundary: argv, Unicode streams, errors, caps, timeout and cancellation',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'loom-process-'));const fixture=path.join(root,'fake.cjs');const previous=process.env.NODE_OPTIONS;const previousJev=process.env.TYPESAFE_API_KEY;process.env.TYPESAFE_API_KEY='isolated-jev-fixture';
 await writeFile(fixture,`const mode=process.env.LOOM_TEST_MODE;const emit=x=>process.stdout.write(JSON.stringify(x)+'\\n');
 if(mode==='ok'){emit({type:'text',part:{text:'Unicode: café 🧵'},sessionID:'test-session'});emit({type:'step_finish',part:{reason:'stop',cost:0.01}});setTimeout(()=>process.exit(0),10);}
 else if(mode==='codex'){emit({type:'item.started',item:{id:'command-1',type:'command_execution',command:'npm test'}});emit({type:'item.completed',item:{id:'command-1',type:'command_execution',command:'npm test',exit_code:0}});emit({type:'item.completed',item:{type:'agent_message',text:'Inspecting...'}});emit({type:'item.completed',item:{type:'agent_message',text:'BLOCKED: Missing input'}});emit({type:'turn.completed'});process.exit(0);}
 else if(mode==='claude-args'){emit({type:'result',result:JSON.stringify(process.argv.slice(1))});process.exit(0);}
 else if(mode==='codex-args'){emit({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(process.argv.slice(1))}});process.exit(0);}
 else if(mode==='quiet-tool'){emit({type:'tool_use',part:{callID:'quiet',tool:'bash',state:{status:'running',input:{command:'long-build'}}}});setTimeout(()=>{emit({type:'tool_use',part:{callID:'quiet',tool:'bash',state:{status:'completed'}}});emit({type:'text',part:{text:'Build finished'}});process.exit(0);},2500);}
 else if(mode==='args'){emit({type:'text',part:{text:JSON.stringify({argv:process.argv.slice(1),hasJevKey:Boolean(process.env.TYPESAFE_API_KEY),config:JSON.parse(process.env.OPENCODE_CONFIG_CONTENT)})}});process.exit(0);}
 else if(mode==='truncated'){emit({type:'text',part:{text:'Partial'}});emit({type:'step_finish',part:{reason:'length'}});setTimeout(()=>process.exit(0),20);}
 else if(mode==='error'){emit({type:'error',error:{name:'APIError',data:{message:'Credentials rejected'}}});setTimeout(()=>process.exit(0),20);}
 else if(mode==='cap'){process.stdout.write('x'.repeat(5000));setTimeout(()=>process.exit(0),20);}
 else if(mode==='empty'){process.exit(0);}
 else if(mode==='nonzero'){process.stderr.write('fixture failure');process.exit(7);}
 else if(mode==='invalid'){process.stdout.write('not json\\n');setTimeout(()=>process.exit(0),20);}
 else {setInterval(()=>{},1000);}
 `);
 await writeFile(path.join(root,'run'),'');
 process.env.NODE_OPTIONS=`--require "${fixture.replaceAll('\\','/')}"`;
 const run=(mode:string,timeout=3000,cap=10000,signal=new AbortController().signal,idleTimeout=0)=>{process.env.LOOM_TEST_MODE=mode;const events:AgentEvent[]=[];return createExecutor({dataDir:root,workspaceRoot:root,host:'127.0.0.1',port:4317,cliTimeoutMs:timeout,cliIdleTimeoutMs:idleTimeout,maxOutputBytes:cap,binaries:{opencode:process.execPath}})(step,'Multiline\nrequest with "quotes" and $literal',root,signal,e=>events.push(e));};
 try {
  await t.test('streams Unicode and real session/cost',async()=>{const result=await run('ok');assert.equal(result.output,'Unicode: café 🧵');assert.equal(result.sessionId,'test-session');assert.equal(result.costUsd,0.01);});
  await t.test('Codex message boundaries preserve blocked final results',async()=>{process.env.LOOM_TEST_MODE='codex';const events:AgentEvent[]=[];const result=await createExecutor({dataDir:root,workspaceRoot:root,host:'127.0.0.1',port:4317,cliTimeoutMs:3000,maxOutputBytes:10000,binaries:{codex:process.execPath}})({...step,provider:'codex',effort:'high'},'Inspect',root,new AbortController().signal,e=>events.push(e));assert.deepEqual(events.filter(e=>e.type==='tool').map(e=>e.toolCall?.status),['running','completed']);assert.ok(!events.some(e=>e.type==='log'&&e.message.includes('command_execution')));assert.equal(result.output,'Inspecting...\n\nBLOCKED: Missing input');assert.equal(events.filter(e=>e.type==='output').map(e=>e.message).join(''),result.output);});
  await t.test('preserves workspace, arguments and max effort; allows shell',async()=>{const result=JSON.parse((await run('args')).output);assert.equal(result.hasJevKey,false);assert.ok(result.argv.includes('max'));assert.equal(result.argv[result.argv.indexOf('--dir')+1],root);assert.equal(result.argv.at(-1),'Multiline\nrequest with "quotes" and $literal');assert.equal(result.config.permission.bash,'allow');});
  await t.test('Claude and Codex allow noninteractive shell execution for validation roles',async()=>{
    for(const provider of ['claude','codex'] as const){const argv=buildArguments({...step,provider,access:'read-only',effort:'high'},'Validate',root);if(provider==='claude'){assert.ok(argv.includes('--dangerously-skip-permissions'));assert.ok(argv[argv.indexOf('--tools')+1].includes('Bash'));assert.ok(!argv.includes('--safe-mode'));}else{assert.equal(argv[argv.indexOf('-s')+1],'danger-full-access');assert.ok(argv.includes('approval_policy="never"'));}}

  });
  for(const [mode,pattern] of [['truncated',/truncat|length|limit/i],['error',/Credentials rejected/],['empty',/no output/],['nonzero',/code 7/],['invalid',/valid JSON/]] as const){await t.test(mode,async()=>{await assert.rejects(run(mode),pattern);});}
  await t.test('caps total bytes',async()=>{await assert.rejects(run('cap',3000,500),/byte limit/);});
  await t.test('idle detection stops silence separately from the runtime cap',async()=>{await assert.rejects(run('hang',3000,10000,new AbortController().signal,250),/inactive/);});
  await t.test('a running tool can be silent longer than the idle limit',async()=>{assert.equal((await run('quiet-tool',10000,10000,new AbortController().signal,1500)).output,'Build finished');});
  await t.test('timeout terminates process',async()=>{await assert.rejects(run('hang',150),/timed out/);});
  await t.test('abort terminates process',async()=>{const controller=new AbortController();const promise=run('hang',3000,10000,controller.signal);setTimeout(()=>controller.abort(),150);await assert.rejects(promise,/aborted/);});
 } finally {if(previous===undefined)delete process.env.NODE_OPTIONS;else process.env.NODE_OPTIONS=previous;if(previousJev===undefined)delete process.env.TYPESAFE_API_KEY;else process.env.TYPESAFE_API_KEY=previousJev;delete process.env.LOOM_TEST_MODE;await rm(root,{recursive:true,force:true});}
});
