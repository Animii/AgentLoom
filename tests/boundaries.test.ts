import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,readFile,symlink,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { listProjects,prepareWorkspace,listRunFiles,readRunFile } from '../src/server/workspaces.js';
import { parseAgentLine } from '../src/server/providers.js';

test('workspace snapshots exclude credentials and never overwrite sources or existing runs',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'loom-files-'));
 try{const p=path.join(root,'projects/demo');await mkdir(path.join(p,'nested'),{recursive:true});await writeFile(path.join(p,'README.md'),'source');await writeFile(path.join(p,'.env'),'secret');await writeFile(path.join(p,'.env.example'),'public');await writeFile(path.join(p,'nested','.env.local'),'secret');
 assert.deepEqual(await listProjects(root),[{id:'demo',name:'demo'}]);const work=await prepareWorkspace(root,'demo','run-1');await writeFile(path.join(work,'README.md'),'changed');assert.equal(await readFile(path.join(p,'README.md'),'utf8'),'source');
 const paths=(await listRunFiles(root,'run-1')).map(f=>f.path);assert.ok(paths.includes('.env.example'));assert.ok(!paths.includes('.env'));assert.ok(!paths.includes('nested/.env.local'));await assert.rejects(()=>prepareWorkspace(root,'demo','run-1'));assert.equal(await readRunFile(root,'run-1','README.md'),'changed');
 for(const bad of ['../README.md','/etc/passwd','C:/Users/test','nested/../../x','..\\secret'])await assert.rejects(()=>readRunFile(root,'run-1',bad));
 await assert.rejects(()=>prepareWorkspace(root,'../demo','bad'));await assert.rejects(()=>listRunFiles(root,'../bad'));
 }finally{await rm(root,{recursive:true,force:true});}
});

test('symlinked project directories cannot escape workspace root',async()=>{const root=await mkdtemp(path.join(tmpdir(),'loom-link-'));try{await mkdir(path.join(root,'outside'));await mkdir(path.join(root,'projects'));await symlink(path.join(root,'outside'),path.join(root,'projects','linked'),process.platform==='win32'?'junction':'dir');await assert.rejects(()=>prepareWorkspace(root,'linked','r'));assert.deepEqual(await listProjects(root),[]);}finally{await rm(root,{recursive:true,force:true});}});

test('provider stream parsing preserves real output, errors, session identifiers and cost',()=>{
 const claude=parseAgentLine('claude',JSON.stringify({type:'result',subtype:'success',result:'Done',session_id:'c1',total_cost_usd:.02}));assert.equal(claude.text,'Done');assert.equal(claude.sessionId,'c1');assert.equal(claude.costUsd,.02);
 assert.ok(parseAgentLine('claude',JSON.stringify({type:'result',is_error:true,result:'Not signed in'})).error);
 assert.equal(parseAgentLine('codex',JSON.stringify({type:'thread.started',thread_id:'t1'})).sessionId,'t1');
 assert.equal(parseAgentLine('codex',JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Reviewed'}})).text,'Reviewed');
 assert.ok(parseAgentLine('codex',JSON.stringify({type:'turn.failed',error:{message:'No access'}})).error);
 assert.equal(parseAgentLine('opencode',JSON.stringify({type:'text',sessionID:'o1',part:{text:'Built'}})).text,'Built');
 assert.equal(parseAgentLine('opencode',JSON.stringify({type:'step_finish',part:{cost:.001}})).costUsd,.001);
 assert.ok(parseAgentLine('opencode',JSON.stringify({type:'error',error:{name:'APIError',data:{message:'Invalid credentials'}}})).error);
 assert.doesNotThrow(()=>parseAgentLine('claude','plain non-JSON warning'));
});

test('Claude partial text streams before completion without duplicate assistant or result text',async()=>{
 const {AgentTextStream}=await import('../src/server/provider-stream.js');const stream=new AgentTextStream('claude');
 const accept=(data:unknown)=>stream.accept(parseAgentLine('claude',JSON.stringify(data)));
 assert.deepEqual(accept({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'Hello '}}}),{type:'output',message:'Hello '});assert.equal(stream.output,'Hello ');
 assert.deepEqual(accept({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'world'}}}),{type:'output',message:'world'});
 assert.equal(accept({type:'assistant',message:{content:[{type:'text',text:'Hello world'}]}}),undefined);assert.equal(stream.output,'Hello world');
 assert.deepEqual(accept({type:'result',result:'Hello world',subtype:'success'}),{type:'output',message:'Hello world',replace:true});assert.equal(stream.output,'Hello world');
 assert.equal(parseAgentLine('claude',JSON.stringify({type:'stream_event',event:{type:'content_block_delta',delta:{type:'thinking_delta',thinking:'private'}}})).text,undefined);
});
