#!/usr/bin/env node
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {stat,realpath} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import path from 'node:path';

const exec=promisify(execFile);
const hookSink=process.platform==='win32'?'NUL':'/dev/null';
const githubOrigin=/^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*?)(?:\.git)?\/?$/;

function git(folder,args,overrides=[],options={}){
 return exec('git',[
  '-c',`core.hooksPath=${hookSink}`,
  '-c','core.fsmonitor=false',
  '-c',`safe.directory=${folder}`,
  ...overrides,
  ...args
 ],{
  cwd:folder,
  shell:false,
  windowsHide:true,
  timeout:30000,
  maxBuffer:1024*1024,
  env:{...process.env,GIT_TERMINAL_PROMPT:'0',GIT_OPTIONAL_LOCKS:'0',GIT_PAGER:'cat',GIT_NO_LAZY_FETCH:'1'},
  ...options
 });
}

function truthyConfigValue(value){
 return value===''||!/^(?:false|no|off|0)$/i.test(value);
}

async function partialCloneState(folder){
 const state={partial:false,promisor:false,known:true};
 try{
  state.partial=(await git(folder,['config','--get','extensions.partialClone'])).stdout.trim()!=='';
 }catch(error){
  if(error.code!==1)state.known=false;
 }
 try{
  const listing=(await git(folder,['config','--get-regexp','^remote\\..*\\.promisor$'])).stdout;
  state.promisor=listing.split('\n').some(line=>{
   const trimmed=line.trim();
   if(!trimmed)return false;
   const separator=trimmed.indexOf(' ');
   return truthyConfigValue(separator===-1?'':trimmed.slice(separator+1).trim());
  });
 }catch(error){
  if(error.code!==1)state.known=false;
 }
 return state;
}

async function submoduleFolders(folder){
 const folders=[];
 const listing=(await git(folder,['ls-files','--stage','-z'],[],{maxBuffer:64*1024*1024})).stdout;
 for(const entry of listing.split('\0')){
  if(!entry.startsWith('160000 '))continue;
  const tab=entry.indexOf('\t');
  if(tab===-1)continue;
  const candidate=path.resolve(folder,entry.slice(tab+1));
  try{
   await stat(path.join(candidate,'.git'));
   folders.push(candidate);
  }catch{}
 }
 return folders;
}

async function filterOverrides(repositoryRoot){
 const overrides=[];
 const visited=new Set();
 const pending=[repositoryRoot];
 while(pending.length){
  const dir=pending.shift();
  if(visited.has(dir))continue;
  visited.add(dir);
  const keys=(await git(dir,['config','--name-only','--list'])).stdout.split('\n');
  for(const key of keys){
   if(!/^filter\./i.test(key))continue;
   if(/\.(?:clean|smudge|process)$/i.test(key))overrides.push('-c',`${key}=`);
   else if(/\.required$/i.test(key))overrides.push('-c',`${key}=false`);
  }
  pending.push(...await submoduleFolders(dir));
 }
 return overrides;
}

export async function checkGitProject(folder){
 const issues=[];
 const report={ready:false,branch:null,commit:null,repository:null,issues};
 if(typeof folder!=='string'||!folder.trim()){
  issues.push('A folder path is required.');
  return report;
 }
 const requested=path.resolve(folder);
 let root;
 try{
  const entry=await stat(requested);
  if(!entry.isDirectory()){
   issues.push('Folder is not a directory.');
   return report;
  }
  root=await realpath(requested);
 }catch{
  issues.push('Folder is not available.');
  return report;
 }
 let top;
 try{
  top=path.resolve((await git(root,['rev-parse','--show-toplevel'])).stdout.trim());
 }catch{
  issues.push('Folder is not a Git repository.');
  return report;
 }
 if(top!==root)issues.push('Folder is not the repository root.');

 try{
  report.commit=(await git(root,['rev-parse','--verify','HEAD'])).stdout.trim();
 }catch{
  issues.push('Repository has no HEAD commit.');
 }

 try{
  report.branch=(await git(root,['symbolic-ref','--quiet','--short','HEAD'])).stdout.trim();
 }catch{
  issues.push('HEAD is detached; check out a branch.');
 }

 if(top===root){
  const fetch=await partialCloneState(top);
  if(!fetch.known){
   issues.push('Repository fetch configuration could not be read; the working tree was not checked.');
  }else if(fetch.partial||fetch.promisor){
   issues.push('Repository is a partial clone; the working tree was not checked because Git could fetch missing objects.');
  }else{
   let overrides;
   try{
    overrides=await filterOverrides(top);
   }catch{
    issues.push('Repository content filters could not be disabled; the working tree was not checked.');
   }
   if(overrides){
    try{
     const status=await git(root,['status','--porcelain','--untracked-files=all','--ignore-submodules=none'],overrides);
     if(status.stdout.trim())issues.push('Working tree has uncommitted or untracked changes.');
    }catch{
     issues.push('Working tree status could not be read.');
    }
   }
  }
 }

 try{
  const origin=(await git(root,['remote','get-url','origin'])).stdout.trim();
  const match=githubOrigin.exec(origin);
  if(match)report.repository=match[1];
  else issues.push('Origin remote is not a GitHub HTTPS or SSH URL.');
 }catch{
  issues.push('Origin remote is missing.');
 }

 report.ready=issues.length===0;
 return report;
}

async function main(args){
 if(args.length!==1){
  process.stderr.write('Usage: node scripts/check-git-project.mjs FOLDER\n');
  return 2;
 }
 const report=await checkGitProject(args[0]);
 process.stdout.write(`${JSON.stringify(report,null,2)}\n`);
 return report.ready?0:1;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 process.exitCode=await main(process.argv.slice(2));
}
