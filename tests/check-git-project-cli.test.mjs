import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,rm,mkdir,writeFile,appendFile,readdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {checkGitProject} from '../scripts/check-git-project.mjs';

const exec=promisify(execFile);
const script=fileURLToPath(new URL('../scripts/check-git-project.mjs',import.meta.url));
const hookSink=process.platform==='win32'?'NUL':'/dev/null';

function git(cwd,args){
 return exec('git',['-c',`core.hooksPath=${hookSink}`,'-c','user.name=Test','-c','user.email=test@example.com','-c','commit.gpgsign=false',...args],{cwd,shell:false,windowsHide:true});
}

async function makeRepo(parent,name){
 const root=path.join(parent,name);
 await mkdir(root,{recursive:true});
 await git(root,['init','-b','main']);
 return root;
}

async function seed(root){
 await writeFile(path.join(root,'README.md'),'# demo\n');
 await git(root,['add','.']);
 await git(root,['commit','-m','init']);
}

async function makePartialClone(parent,name){
 const source=await makeRepo(parent,`${name}-source`);
 await writeFile(path.join(source,'.gitattributes'),'*.txt text\n');
 await writeFile(path.join(source,'file.txt'),'original\n');
 await writeFile(path.join(source,'other.txt'),'other\n');
 await git(source,['add','.']);
 await git(source,['commit','-m','init']);
 await git(source,['config','uploadpack.allowFilter','true']);
 const root=path.join(parent,name);
 await exec('git',['-c',`core.hooksPath=${hookSink}`,'clone','--quiet','--no-checkout','--filter=blob:none',pathToFileURL(source).href,root],{shell:false,windowsHide:true});
 await git(root,['remote','rename','origin','cache']);
 await git(root,['remote','add','origin','https://github.com/acme/partial.git']);
 await git(root,['read-tree','HEAD']);
 await writeFile(path.join(root,'file.txt'),'changed\n');
 return root;
}

async function runCli(args){
 try{
  const result=await exec(process.execPath,[script,...args],{shell:false,windowsHide:true});
  return {code:0,stdout:result.stdout,stderr:result.stderr};
 }catch(error){
  return {code:error.code,stdout:error.stdout??'',stderr:error.stderr??''};
 }
}

async function snapshot(root){
 const entries=[];
 async function walk(relative){
  for(const entry of await readdir(path.join(root,relative),{withFileTypes:true})){
   const next=path.join(relative,entry.name);
   entries.push(next);
   if(entry.isDirectory())await walk(next);
  }
 }
 await walk('.');
 return entries.sort();
}

test('clean repository with a GitHub HTTPS origin is ready, including a path with spaces',async()=>{
 const parent=await mkdtemp(path.join(tmpdir(),'loom git check '));
 try{
  const root=await makeRepo(parent,'repo with spaces');
  await seed(root);
  await git(root,['remote','add','origin','https://github.com/acme/widgets.git']);
  const report=await checkGitProject(root);
  assert.equal(report.ready,true);
  assert.equal(report.branch,'main');
  assert.match(report.commit,/^[0-9a-f]{40}$/);
  assert.equal(report.repository,'acme/widgets');
  assert.deepEqual(report.issues,[]);
  const cli=await runCli([root]);
  assert.equal(cli.code,0);
  assert.deepEqual(JSON.parse(cli.stdout),report);
  assert.equal(cli.stderr,'');
 }finally{await rm(parent,{recursive:true,force:true});}
});

test('SSH origins are recognized while unsupported and credential-bearing origins are rejected without leaking them',async()=>{
 const parent=await mkdtemp(path.join(tmpdir(),'loom-git-origin-'));
 try{
  const ssh=await makeRepo(parent,'ssh');
  await seed(ssh);
  await git(ssh,['remote','add','origin','git@github.com:acme/widgets.git']);
  const sshReport=await checkGitProject(ssh);
  assert.equal(sshReport.ready,true);
  assert.equal(sshReport.repository,'acme/widgets');
  assert.deepEqual(sshReport.issues,[]);

  const missing=await makeRepo(parent,'missing');
  await seed(missing);
  const missingReport=await checkGitProject(missing);
  assert.equal(missingReport.ready,false);
  assert.equal(missingReport.repository,null);
  assert.equal(missingReport.branch,'main');
  assert.ok(missingReport.issues.some(issue=>/origin/i.test(issue)));

  const other=await makeRepo(parent,'other');
  await seed(other);
  await git(other,['remote','add','origin','https://gitlab.com/acme/widgets.git']);
  const otherReport=await checkGitProject(other);
  assert.equal(otherReport.ready,false);
  assert.equal(otherReport.repository,null);
  assert.ok(otherReport.issues.some(issue=>/GitHub/.test(issue)));

  const secret='ghp_secret_token_value';
  const credential=await makeRepo(parent,'credential');
  await seed(credential);
  await git(credential,['remote','add','origin',`https://x-access-token:${secret}@github.com/acme/widgets.git`]);
  const credentialReport=await checkGitProject(credential);
  assert.equal(credentialReport.ready,false);
  assert.equal(credentialReport.repository,null);
  assert.ok(!JSON.stringify(credentialReport).includes(secret));
 }finally{await rm(parent,{recursive:true,force:true});}
});

test('repository without a HEAD commit is not ready',async()=>{
 const parent=await mkdtemp(path.join(tmpdir(),'loom-git-empty-'));
 try{
  const root=await makeRepo(parent,'empty');
  const report=await checkGitProject(root);
  assert.equal(report.ready,false);
  assert.equal(report.commit,null);
  assert.ok(report.issues.some(issue=>/HEAD commit/.test(issue)));
  const cli=await runCli([root]);
  assert.equal(cli.code,1);
  assert.deepEqual(JSON.parse(cli.stdout),report);
 }finally{await rm(parent,{recursive:true,force:true});}
});

test('tracked modifications and untracked files block readiness',async()=>{
 const parent=await mkdtemp(path.join(tmpdir(),'loom-git-dirty-'));
 try{
  const tracked=await makeRepo(parent,'tracked');
  await seed(tracked);
  await git(tracked,['remote','add','origin','https://github.com/acme/widgets.git']);
  await writeFile(path.join(tracked,'README.md'),'changed\n');
  const dirty=await checkGitProject(tracked);
  assert.equal(dirty.ready,false);
  assert.equal(dirty.branch,'main');
  assert.equal(dirty.repository,'acme/widgets');
  assert.ok(dirty.issues.some(issue=>/working tree/i.test(issue)));

  const untracked=await makeRepo(parent,'untracked');
  await seed(untracked);
  await git(untracked,['remote','add','origin','https://github.com/acme/widgets.git']);
  await writeFile(path.join(untracked,'scratch.txt'),'not committed\n');
  const withUntracked=await checkGitProject(untracked);
  assert.equal(withUntracked.ready,false);
  assert.ok(withUntracked.issues.some(issue=>/working tree/i.test(issue)));

  await git(untracked,['config','status.showUntrackedFiles','no']);
  const hiddenUntracked=await checkGitProject(untracked);
  assert.equal(hiddenUntracked.ready,false);
  assert.ok(hiddenUntracked.issues.some(issue=>/working tree/i.test(issue)));
  const hiddenCli=await runCli([untracked]);
  assert.equal(hiddenCli.code,1);
  assert.equal(JSON.parse(hiddenCli.stdout).ready,false);
 }finally{await rm(parent,{recursive:true,force:true});}
});

test('detached HEAD is not ready and reports no branch',async()=>{
 const parent=await mkdtemp(path.join(tmpdir(),'loom-git-detached-'));
 try{
  const root=await makeRepo(parent,'repo');
  await seed(root);
  await git(root,['remote','add','origin','https://github.com/acme/widgets.git']);
  await git(root,['checkout','--detach']);
  const report=await checkGitProject(root);
  assert.equal(report.ready,false);
  assert.equal(report.branch,null);
  assert.match(report.commit,/^[0-9a-f]{40}$/);
  assert.ok(report.issues.some(issue=>/detached/i.test(issue)));
 }finally{await rm(parent,{recursive:true,force:true});}
});

test('linked worktree roots are ready while subdirectories are not',async()=>{
 const parent=await mkdtemp(path.join(tmpdir(),'loom-git-worktree-'));
 try{
  const main=await makeRepo(parent,'main');
  await seed(main);
  await git(main,['remote','add','origin','https://github.com/acme/widgets.git']);
  await mkdir(path.join(main,'src'));
  await writeFile(path.join(main,'src','app.js'),'export {};\n');
  await git(main,['add','.']);
  await git(main,['commit','-m','source']);
  const worktree=path.join(parent,'feature worktree');
  await git(main,['worktree','add','-b','feature',worktree]);

  const worktreeReport=await checkGitProject(worktree);
  assert.equal(worktreeReport.ready,true);
  assert.equal(worktreeReport.branch,'feature');
  assert.equal(worktreeReport.repository,'acme/widgets');

  const mainReport=await checkGitProject(main);
  assert.equal(mainReport.ready,true);
  assert.equal(mainReport.branch,'main');

  const subReport=await checkGitProject(path.join(main,'src'));
  assert.equal(subReport.ready,false);
  assert.equal(subReport.branch,'main');
  assert.ok(subReport.issues.some(issue=>/repository root/i.test(issue)));
 }finally{await rm(parent,{recursive:true,force:true});}
});

test('CLI reports usage errors on stderr with exit 2 and unavailable folders with exit 1',async()=>{
 const parent=await mkdtemp(path.join(tmpdir(),'loom-git-cli-'));
 try{
  const missingArgs=await runCli([]);
  assert.equal(missingArgs.code,2);
  assert.equal(missingArgs.stdout,'');
  assert.match(missingArgs.stderr,/Usage:/);

  const extraArgs=await runCli([parent,'extra']);
  assert.equal(extraArgs.code,2);
  assert.equal(extraArgs.stdout,'');
  assert.match(extraArgs.stderr,/Usage:/);

  const absentParent=await mkdtemp(path.join(tmpdir(),'loom-git-absent-'));
  try{
   const unavailable=await runCli([path.join(absentParent,'not-created')]);
   assert.equal(unavailable.code,1);
   assert.equal(unavailable.stderr,'');
   const unavailableReport=JSON.parse(unavailable.stdout);
   assert.equal(unavailableReport.ready,false);
   assert.ok(unavailableReport.issues.some(issue=>/Folder/.test(issue)));
  }finally{await rm(absentParent,{recursive:true,force:true});}

  const file=path.join(parent,'plain.txt');
  await writeFile(file,'not a folder\n');
  const notDirectory=await runCli([file]);
  assert.equal(notDirectory.code,1);
  assert.equal(JSON.parse(notDirectory.stdout).ready,false);
  assert.ok(JSON.parse(notDirectory.stdout).issues.some(issue=>/directory/i.test(issue)));
 }finally{await rm(parent,{recursive:true,force:true});}
});

test('checks never create files in the inspected repository',async()=>{
 const parent=await mkdtemp(path.join(tmpdir(),'loom-git-readonly-'));
 try{
  const root=await makeRepo(parent,'repo');
  await seed(root);
  await git(root,['remote','add','origin','https://github.com/acme/widgets.git']);
  const before=await snapshot(root);
  await checkGitProject(root);
  assert.deepEqual(await snapshot(root),before);
  await runCli([root]);
  assert.deepEqual(await snapshot(root),before);

  const untracked=await makeRepo(parent,'untracked');
  await seed(untracked);
  const dirtyBefore=await snapshot(untracked);
  await checkGitProject(untracked);
  assert.deepEqual(await snapshot(untracked),dirtyBefore);
 }finally{await rm(parent,{recursive:true,force:true});}
});

test('submodule changes hidden by ignore configuration still block readiness',async()=>{
 const parent=await mkdtemp(path.join(tmpdir(),'loom-git-submodule-'));
 try{
  const child=await makeRepo(parent,'child');
  await writeFile(path.join(child,'child.txt'),'child\n');
  await git(child,['add','.']);
  await git(child,['commit','-m','child init']);

  const root=await makeRepo(parent,'parent');
  await writeFile(path.join(root,'readme.txt'),'parent\n');
  await git(root,['add','.']);
  await git(root,['commit','-m','parent init']);
  await git(root,['-c','protocol.file.allow=always','submodule','add',child,'child']);
  await git(root,['commit','-m','add child']);
  await git(root,['remote','add','origin','https://github.com/acme/widgets.git']);

  const clean=await checkGitProject(root);
  assert.equal(clean.ready,true);
  assert.deepEqual(clean.issues,[]);

  await git(root,['config','diff.ignoreSubmodules','all']);
  await git(path.join(root,'child'),['commit','--allow-empty','-m','advance']);
  const hidden=await git(root,['status','--porcelain','--untracked-files=all']);
  assert.equal(hidden.stdout.trim(),'');

  const report=await checkGitProject(root);
  assert.equal(report.ready,false);
  assert.ok(report.issues.some(issue=>/working tree/i.test(issue)));
  const cli=await runCli([root]);
  assert.equal(cli.code,1);
  assert.equal(JSON.parse(cli.stdout).ready,false);
 }finally{await rm(parent,{recursive:true,force:true});}
});

test('configured Git content filters cannot run or create files during inspection',async()=>{
 const parent=await mkdtemp(path.join(tmpdir(),'loom-git-filter-'));
 try{
  const root=await makeRepo(parent,'repo');
  await writeFile(path.join(root,'file.txt'),'original\n');
  await writeFile(path.join(root,'.gitattributes'),'*.txt filter=probe\n');
  await git(root,['add','.']);
  await git(root,['commit','-m','init']);
  await git(root,['remote','add','origin','https://github.com/acme/widgets.git']);

  const marker=path.join(parent,'filter-ran.txt');
  const driver=path.join(parent,'driver.mjs');
  await writeFile(driver,`import{readFileSync,writeFileSync}from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)},'ran');\nprocess.stdout.write(readFileSync(0));\n`);
  await git(root,['config','filter.probe.clean',`"${process.execPath}" "${driver}"`]);
  await writeFile(path.join(root,'file.txt'),'modified\n');

  const before=await snapshot(root);
  const report=await checkGitProject(root);
  assert.equal(existsSync(marker),false);
  assert.deepEqual(await snapshot(root),before);
  assert.equal(report.ready,false);
  assert.ok(report.issues.some(issue=>/working tree/i.test(issue)));

  const cli=await runCli([root]);
  assert.equal(cli.code,1);
  assert.equal(existsSync(marker),false);
  assert.deepEqual(await snapshot(root),before);
 }finally{await rm(parent,{recursive:true,force:true});}
});

test('submodule-local content filters cannot run or create files during inspection',async()=>{
 const parent=await mkdtemp(path.join(tmpdir(),'loom-git-submodule-filter-'));
 try{
  const child=await makeRepo(parent,'child');
  await writeFile(path.join(child,'file.txt'),'original\n');
  await writeFile(path.join(child,'.gitattributes'),'*.txt filter=childOnly\n');
  await git(child,['add','.']);
  await git(child,['commit','-m','child init']);

  const root=await makeRepo(parent,'repo');
  await writeFile(path.join(root,'readme.txt'),'repo\n');
  await git(root,['add','.']);
  await git(root,['commit','-m','repo init']);
  await git(root,['-c','protocol.file.allow=always','submodule','add',child,'child']);
  await git(root,['commit','-m','add child']);
  await git(root,['remote','add','origin','https://github.com/acme/widgets.git']);

  const marker=path.join(parent,'submodule-filter-ran.txt');
  const driver=path.join(parent,'driver.mjs');
  await writeFile(driver,`import{readFileSync,writeFileSync}from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)},'ran');\nprocess.stdout.write(readFileSync(0));\n`);
  await git(path.join(root,'child'),['config','filter.childOnly.clean',`"${process.execPath}" "${driver}"`]);
  await writeFile(path.join(root,'child','file.txt'),'modified\n');

  const childKeys=(await git(path.join(root,'child'),['config','--name-only','--get-regexp','^filter\\.'])).stdout;
  let rootKeys='';
  try{rootKeys=(await git(root,['config','--name-only','--get-regexp','^filter\\.'])).stdout;}catch{rootKeys='';}
  assert.match(childKeys,/filter\.childOnly\.clean/);
  assert.equal(rootKeys.trim(),'');
  assert.equal(existsSync(marker),false);

  const before=await snapshot(root);
  const report=await checkGitProject(root);
  assert.equal(existsSync(marker),false);
  assert.deepEqual(await snapshot(root),before);
  assert.equal(report.ready,false);
  assert.ok(report.issues.some(issue=>/working tree/i.test(issue)));

  const cli=await runCli([root]);
  assert.equal(cli.code,1);
  assert.equal(existsSync(marker),false);
  assert.deepEqual(await snapshot(root),before);
 }finally{await rm(parent,{recursive:true,force:true});}
});

test('failed filter discovery fails closed without running filters',async()=>{
 const parent=await mkdtemp(path.join(tmpdir(),'loom-git-filter-discovery-'));
 const filteredSubmodule=async(name)=>{
  const child=await makeRepo(parent,`${name}-child`);
  await writeFile(path.join(child,'file.txt'),'original\n');
  await writeFile(path.join(child,'.gitattributes'),'*.txt filter=probe\n');
  await git(child,['add','.']);
  await git(child,['commit','-m','child init']);

  const root=await makeRepo(parent,`${name}-repo`);
  await writeFile(path.join(root,'readme.txt'),'repo\n');
  await git(root,['add','.']);
  await git(root,['commit','-m','repo init']);
  await git(root,['-c','protocol.file.allow=always','submodule','add',child,'child']);
  await git(root,['commit','-m','add child']);
  await git(root,['remote','add','origin','https://github.com/acme/widgets.git']);

  const marker=path.join(root,'filter-created.txt');
  const driver=path.join(parent,`${name}-driver.mjs`);
  await writeFile(driver,`import{readFileSync,writeFileSync}from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)},'ran');\nprocess.stdout.write(readFileSync(0));\n`);
  const submodule=path.join(root,'child');
  await git(submodule,['config','filter.probe.clean',`"${process.execPath}" "${driver}"`]);
  const config=(await git(submodule,['rev-parse','--path-format=absolute','--git-path','config'])).stdout.trim();
  return {root,submodule,marker,config};
 };
 try{
  const oversized=await filteredSubmodule('oversized');
  const pad='x'.repeat(180);
  let bloat=`[bloat "${pad}"]\n`;
  for(let i=0;i<6000;i++)bloat+=`\tk${i} = 1\n`;
  await appendFile(oversized.config,bloat);
  const names=await exec('git',['config','--name-only','--list'],{cwd:oversized.submodule,maxBuffer:64*1024*1024});
  assert.ok(Buffer.byteLength(names.stdout)>1024*1024,'fixture must exceed the discovery output limit');
  await writeFile(path.join(oversized.submodule,'file.txt'),'modified\n');
  assert.equal(existsSync(oversized.marker),false);

  const before=await snapshot(oversized.root);
  const report=await checkGitProject(oversized.root);
  assert.equal(report.ready,false);
  assert.ok(report.issues.some(issue=>/filters could not be disabled/.test(issue)));
  assert.equal(existsSync(oversized.marker),false);
  assert.deepEqual(await snapshot(oversized.root),before);

  const cli=await runCli([oversized.root]);
  assert.equal(cli.code,1);
  const cliReport=JSON.parse(cli.stdout);
  assert.equal(cliReport.ready,false);
  assert.ok(cliReport.issues.some(issue=>/filters could not be disabled/.test(issue)));
  assert.equal(existsSync(oversized.marker),false);
  assert.deepEqual(await snapshot(oversized.root),before);

  const malformed=await filteredSubmodule('malformed');
  await appendFile(malformed.config,'[broken\nthis is not valid config syntax\n');
  await writeFile(path.join(malformed.submodule,'file.txt'),'modified\n');
  const malformedReport=await checkGitProject(malformed.root);
  assert.equal(malformedReport.ready,false);
  assert.ok(malformedReport.issues.some(issue=>/filters could not be disabled/.test(issue)));
  assert.equal(existsSync(malformed.marker),false);
 }finally{await rm(parent,{recursive:true,force:true});}
});

test('subdirectory inspection does not run sibling submodule content filters',async()=>{
 const parent=await mkdtemp(path.join(tmpdir(),'loom-git-subdir-filter-'));
 try{
  const child=await makeRepo(parent,'child');
  await writeFile(path.join(child,'file.txt'),'original\n');
  await writeFile(path.join(child,'.gitattributes'),'*.txt filter=childOnly\n');
  await git(child,['add','.']);
  await git(child,['commit','-m','child init']);

  const root=await makeRepo(parent,'repo');
  await mkdir(path.join(root,'src'));
  await writeFile(path.join(root,'src','app.txt'),'app\n');
  await git(root,['add','.']);
  await git(root,['commit','-m','repo init']);
  await git(root,['-c','protocol.file.allow=always','submodule','add',child,'child']);
  await git(root,['commit','-m','add child']);
  await git(root,['remote','add','origin','https://github.com/acme/widgets.git']);

  const inspected=path.join(root,'src');
  const marker=path.join(inspected,'filter-created.txt');
  const driver=path.join(parent,'driver.mjs');
  await writeFile(driver,`import{readFileSync,writeFileSync}from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)},'ran');\nprocess.stdout.write(readFileSync(0));\n`);
  await git(path.join(root,'child'),['config','filter.childOnly.clean',`"${process.execPath}" "${driver}"`]);
  await writeFile(path.join(root,'child','file.txt'),'modified\n');
  assert.equal(existsSync(marker),false);

  const before=await snapshot(root);
  const report=await checkGitProject(inspected);
  assert.equal(report.ready,false);
  assert.ok(report.issues.some(issue=>/repository root/i.test(issue)));
  assert.equal(existsSync(marker),false);
  assert.deepEqual(await snapshot(root),before);

  const cli=await runCli([inspected]);
  assert.equal(cli.code,1);
  assert.equal(existsSync(marker),false);
  assert.deepEqual(await snapshot(root),before);

  const rootReport=await checkGitProject(root);
  assert.equal(rootReport.ready,false);
  assert.ok(rootReport.issues.some(issue=>/working tree/i.test(issue)));
  assert.equal(existsSync(marker),false);
  assert.deepEqual(await snapshot(root),before);
 }finally{await rm(parent,{recursive:true,force:true});}
});

test('partial clones are not inspected so Git cannot fetch missing objects',async()=>{
 const parent=await mkdtemp(path.join(tmpdir(),'loom-git-partial-'));
 try{
  const root=await makePartialClone(parent,'partial');
  const promisor=(await git(root,['config','--get-regexp','^remote\\..*\\.promisor$'])).stdout;
  assert.match(promisor,/remote\.cache\.promisor\s+true/);
  const packs=await readdir(path.join(root,'.git','objects','pack'));
  assert.ok(packs.some(name=>name.endsWith('.promisor')),'fixture must be a real partial clone');

  const before=await snapshot(root);
  const report=await checkGitProject(root);
  assert.equal(report.ready,false);
  assert.equal(report.branch,'main');
  assert.equal(report.repository,'acme/partial');
  assert.ok(report.issues.some(issue=>/partial clone/i.test(issue)));
  assert.deepEqual(await snapshot(root),before);

  const cli=await runCli([root]);
  assert.equal(cli.code,1);
  assert.equal(cli.stderr,'');
  const cliReport=JSON.parse(cli.stdout);
  assert.equal(cliReport.ready,false);
  assert.ok(cliReport.issues.some(issue=>/partial clone/i.test(issue)));
  assert.deepEqual(await snapshot(root),before);
 }finally{await rm(parent,{recursive:true,force:true});}
});

test('importing the module has no CLI side effects',async()=>{
 assert.equal(typeof checkGitProject,'function');
 const moduleUrl=pathToFileURL(script).href;
 const result=await exec(process.execPath,['--input-type=module','-e',`const module=await import(${JSON.stringify(moduleUrl)});if(typeof module.checkGitProject!=='function')process.exit(3);`],{shell:false,windowsHide:true});
 assert.equal(result.stdout,'');
 assert.equal(result.stderr,'');
});
