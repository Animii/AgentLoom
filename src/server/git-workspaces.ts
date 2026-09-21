import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,writeFile,rm,lstat,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import type {AppConfig,Run,RunGit,GitPreview} from '../shared/types.js';
const exec=promisify(execFile);
const locks=new Map<string,Promise<unknown>>();
async function serial<T>(key:string,action:()=>Promise<T>):Promise<T>{const before=locks.get(key)??Promise.resolve();const next=before.catch(()=>{}).then(action);locks.set(key,next);try{return await next;}finally{if(locks.get(key)===next)locks.delete(key);}}
async function command(binary:string,args:string[],cwd:string,env?:NodeJS.ProcessEnv){try{const result=await exec(binary,args,{cwd,env:{...process.env,GIT_TERMINAL_PROMPT:'0',...env},shell:false,windowsHide:true,timeout:120000,maxBuffer:2*1024*1024});return result.stdout;}catch{throw new Error(binary==='gh'?'GitHub command failed. Check gh auth status in the platform container and repository permissions.':'Git command failed. Check repository access, branch state and GitHub authentication.');}}
const git=(cwd:string,args:string[],env?:NodeJS.ProcessEnv)=>command('git',['-c','core.hooksPath='+ (process.platform==='win32'?'NUL':'/dev/null'),'-c','core.fsmonitor=false','-c','safe.directory='+cwd,...args],cwd,env);
export function githubRepository(remote:string):string|undefined {
 const match=/^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*?)(?:\.git)?\/?$/.exec(remote.trim());
 return match?.[1];
}
export async function checkGitSource(source:string){
 let top:string,commit:string,branch:string;
 try{top=(await git(source,['rev-parse','--show-toplevel'])).trim();commit=(await git(source,['rev-parse','--verify','HEAD'])).trim();branch=(await git(source,['symbolic-ref','--short','HEAD'])).trim();}catch{throw new Error('Worktree mode requires a Git repository with an initial commit and a checked-out branch.');}
 if(path.resolve(top)!==path.resolve(source))throw new Error('Connect the Git repository root to use worktree mode.');
 if((await git(source,['status','--porcelain'])).trim())throw new Error('Commit or stash local changes before starting a worktree run. Worktrees start from committed code.');
 let repository:string|undefined;try{repository=githubRepository(await git(source,['remote','get-url','origin']));}catch{}
 return {commit,branch,repository};
}
export async function prepareGitWorkspace(config:AppConfig,source:string,run:Run,onPlan?:(metadata:RunGit)=>void):Promise<{workspace:string;git:RunGit}>{
 if(!/^[a-zA-Z0-9_-]+$/.test(run.project))throw new Error('Invalid project identifier.');
 const root=path.resolve(config.dataDir,'git-repositories');const cache=path.join(root,run.project+'.git');
 return serial(cache,async()=>{
  const expected=path.resolve(config.workspaceRoot,'runs',run.id);
  if(run.git){try{await lstat(expected);await verifyWorkspace({...run,workspace:expected},config);return {workspace:expected,git:run.git};}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
  const info=await checkGitSource(source);
  await mkdir(root,{recursive:true});
  try{const entry=await lstat(cache);if(!entry.isDirectory()||entry.isSymbolicLink())throw new Error('Invalid managed Git repository.');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;await git(root,['init','--bare',cache]);}
  const metadata=run.git??{branch:`agentloom/${run.id}`,baseBranch:info.branch,baseCommit:info.commit,repository:info.repository};
  // Local fetch starts upload-pack, which drops command-scoped Git config.
  // Trust only this checked source in a temporary config inherited by that child.
  const fetchConfig=await mkdtemp(path.join(tmpdir(),'agentloom-fetch-'));
  try{
   const configFile=path.join(fetchConfig,'config');
   const sourceGitDir=(await git(source,['rev-parse','--absolute-git-dir'])).trim();
   for(const directory of [source,sourceGitDir])await git(cache,['config','--file',configFile,'--add','safe.directory',directory]);
   try{await git(cache,['fetch','--no-tags',source,metadata.baseCommit],{GIT_CONFIG_GLOBAL:configFile});}
   catch{throw new Error('Could not fetch the base commit from the connected local project. Check its mounted Git directory and file permissions, then retry this crate.');}
  }finally{await rm(fetchConfig,{recursive:true,force:true});}
  onPlan?.(metadata);
  const workspace=path.resolve(config.workspaceRoot,'runs',run.id);const branch=`agentloom/${run.id}`;
  await mkdir(path.dirname(workspace),{recursive:true});
  try{await lstat(workspace);throw new Error('Run workspace already exists. Inspect it before retrying.');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  // A previous interrupted creation may already own this branch; never reset or delete it.
  let existing:string|undefined;try{existing=(await git(cache,['rev-parse','--verify',`refs/heads/${branch}`])).trim();}catch{}
  if(existing){if(existing!==metadata.baseCommit)throw new Error('Run branch already has work. Inspect it before retrying.');await git(cache,['worktree','add',workspace,branch]);}
  else await git(cache,['worktree','add','-b',branch,workspace,metadata.baseCommit]);
  return {workspace,git:metadata};
 });
}
function sensitive(file:string){return /(^|\/)(?:\.env(?:\.(?!example$)[^/]*)?|\.auth|\.data|secrets?|credentials?|id_rsa|id_ed25519)(\/|$)|\.(?:pem|key|p12|pfx)$/i.test(file);}
async function verifyWorkspace(run:Run,config:AppConfig){
 if(!run.git||run.projectLocation?.workspaceMode!=='worktree')throw new Error('This run does not use a Git worktree.');
 const expected=path.resolve(config.workspaceRoot,'runs',run.id);
 if(path.resolve(run.workspace)!==expected||await realpath(expected)!==expected)throw new Error('Unexpected worktree path.');
 if((await git(expected,['symbolic-ref','--short','HEAD'])).trim()!==run.git.branch)throw new Error('The run branch changed. Restore its branch before publishing.');
 const common=await realpath(path.resolve(expected,(await git(expected,['rev-parse','--git-common-dir'])).trim()));
 if(common!==await realpath(path.resolve(config.dataDir,'git-repositories',run.project+'.git')))throw new Error('Unexpected Git repository.');
 return expected;
}
export async function previewRunGit(run:Run,config:AppConfig):Promise<GitPreview>{
 const cwd=await verifyWorkspace(run,config);const meta=run.git!;
 const head=(await git(cwd,['rev-parse','HEAD'])).trim();
 const touched=(await git(cwd,['diff','--no-ext-diff','--name-only','-z',meta.baseCommit])).split('\0').filter(Boolean);
 const untracked=(await git(cwd,['ls-files','--others','--exclude-standard','-z'])).split('\0').filter(Boolean);
 if([...touched,...untracked].some(sensitive))throw new Error('Potential credential files are changed. Remove them from the PR before continuing.');
 const temp=await mkdtemp(path.join(tmpdir(),'agentloom-index-'));
 let tree:string;
 try{const env={GIT_INDEX_FILE:path.join(temp,'index')};await git(cwd,['read-tree','HEAD'],env);await git(cwd,['add','--all'],env);tree=(await git(cwd,['write-tree'],env)).trim();}finally{await rm(temp,{recursive:true,force:true});}
 const stat=await git(cwd,['diff','--no-ext-diff','--no-textconv','--stat',meta.baseCommit,tree]);
 const diff=await git(cwd,['diff','--no-ext-diff','--no-textconv','--no-renames',meta.baseCommit,tree]);
 const token=createHash('sha256').update(`${head}:${tree}:${meta.baseCommit}`).digest('hex');
 const reason=run.mode!=='live'?'Demo runs cannot publish pull requests.':run.status!=='completed'?'Approve every workflow step before creating a PR.':!meta.repository?'The source repository needs a GitHub origin remote before starting a PR-enabled run.':!diff?'There are no changes relative to the run base.':meta.prUrl&&!run.crate?.updatingPr?'A PR already exists for this run.':undefined;
 return {...meta,head,tree,token,stat,diff,title:run.title,body:`## Task\n${run.task}\n\n## Validation and review\n${run.steps.map(s=>`### ${s.definition.name}\n${s.output}`).join('\n\n')}`.slice(0,30000),canPublish:!reason,reason};
}
export interface PublishInput {token:string;title:string;body:string}
export interface PrTransport {gh:(args:string[],cwd:string)=>Promise<string>;push:(cwd:string,url:string,ref:string)=>Promise<void>}
export async function publishDraftPr(run:Run,config:AppConfig,input:PublishInput,transport?:PrTransport):Promise<{url:string;commit:string}>{
 const gh=transport?.gh??((args:string[],cwd:string)=>command('gh',args,cwd));
 const preview=await previewRunGit(run,config);
 if(!preview.canPublish)throw new Error(preview.reason);
 if(!run.git?.approvedTree || preview.tree!==run.git.approvedTree)throw new Error('The current Git tree has not been approved. Revalidate and approve these files before publishing.');
 if(preview.token!==input.token)throw new Error('Files changed since the preview. Refresh the diff before publishing.');
 const cwd=run.workspace;const repository=run.git!.repository!;const branch=run.git!.branch;
 await gh(['auth','status','--hostname','github.com'],cwd);
 const existing=JSON.parse(await gh(['pr','list','--repo',repository,'--head',branch,'--state','all','--json','url,headRefOid,state,baseRefName'],cwd)) as {url:string;headRefOid:string;state:string;baseRefName:string}[];
 if(existing.length){
  const pr=existing[0];
  if(pr.state!=='OPEN'||pr.baseRefName!==run.git!.baseBranch||! /^[a-f0-9]{40}$/.test(pr.headRefOid))throw Error('An existing PR has a different state or base. Inspect it on GitHub before continuing.');
  const remoteCommit=JSON.parse(await gh(['api',`repos/${repository}/git/commits/${pr.headRefOid}`],cwd)) as {tree?:{sha?:string}};
  if(remoteCommit.tree?.sha===run.git!.approvedTree)return {url:validPrUrl(pr.url,repository),commit:pr.headRefOid};
  if(!run.crate?.updatingPr || pr.headRefOid!==run.git!.publishedCommit)throw Error('The existing PR changed outside this crate. Refresh and inspect its current commit.');
  validPrUrl(pr.url,repository);
 }
 let commit=preview.head;
 if((await git(cwd,['rev-parse',`${preview.head}^{tree}`])).trim()!==preview.tree){
  const user=JSON.parse(await gh(['api','user'],cwd)) as {login:string;id:number};
  if(!/^[a-zA-Z0-9-]+$/.test(user.login)||!Number.isSafeInteger(user.id))throw new Error('Invalid GitHub identity.');
  commit=(await git(cwd,['-c',`user.name=${user.login}`,'-c',`user.email=${user.id}+${user.login}@users.noreply.github.com`,'commit-tree',preview.tree,'-p',preview.head,'-m',input.title])).trim();
  await git(cwd,['update-ref',`refs/heads/${branch}`,commit,preview.head]);await git(cwd,['read-tree',preview.tree]);
 }
 // Only push this run's dedicated branch. No force push, merge, or default-branch update.
 const remote=`https://github.com/${repository}.git`, ref=`${commit}:refs/heads/${branch}`;
 if(transport)await transport.push(cwd,remote,ref);else await git(cwd,['-c','credential.helper=','-c','credential.helper=!gh auth git-credential','push',remote,ref]);
 if(existing.length)return {url:validPrUrl(existing[0].url,repository),commit};
 const folder=await mkdtemp(path.join(tmpdir(),'agentloom-pr-'));
 try{const bodyFile=path.join(folder,'body.md');await writeFile(bodyFile,input.body,'utf8');const output=await gh(['pr','create','--repo',repository,'--head',branch,'--base',run.git!.baseBranch,'--draft','--title',input.title,'--body-file',bodyFile],cwd);return {url:validPrUrl(output.trim(),repository),commit};}finally{await rm(folder,{recursive:true,force:true});}
}
function validPrUrl(url:string,repository:string){if(!url.startsWith(`https://github.com/${repository}/pull/`)||!/^\d+$/.test(url.split('/').at(-1)??''))throw new Error('GitHub returned an unexpected PR URL.');return url;}

/** Construct every merge off-index before changing the parent worktree. Conflicts leave it untouched. */
export async function joinCrateWorktrees(parent:Run,children:Run[],config:AppConfig):Promise<string>{
 const cwd=await verifyWorkspace(parent,config);
 if((await git(cwd,['status','--porcelain'])).trim())throw Error('The parent worktree must be clean before joining.');
 const head=(await git(cwd,['rev-parse','HEAD'])).trim();let combined=head;
 for(const child of children){
  if(child.status!=='completed'||child.git?.baseCommit!==parent.git!.baseCommit)throw Error('Each child must be approved and share the parent base.');
  const preview=await previewRunGit(child,config);
  if(preview.tree!==child.git?.approvedTree)throw Error('A child changed after approval. Revalidate and approve its current files.');
  const commit=async(tree:string,parents:string[]) => (await git(cwd,['-c','user.name=AgentLoom','-c','user.email=agentloom@localhost','commit-tree',tree,...parents.flatMap(p=>['-p',p]),'-m',`Join child crate ${child.id}`])).trim();
  const childCommit=await commit(preview.tree,[child.git.baseCommit]);
  let tree:string;
  try{tree=(await git(cwd,['merge-tree','--write-tree',combined,childCommit])).trim().split('\n')[0];}catch{throw Error(`Child "${child.title}" conflicts with the combined changes. Parent files are unchanged. Resolve the child scope or changes and retry.`);}
  combined=await commit(tree,[combined,childCommit]);
 }
 if((await git(cwd,['rev-parse','HEAD'])).trim()!==head || (await git(cwd,['status','--porcelain'])).trim())throw Error('The parent changed during integration. Retry after inspecting it.');
 await git(cwd,['merge','--ff-only',combined]);return combined;
}

export async function readCratePr(run:Run):Promise<{state:'OPEN'|'CLOSED'|'MERGED';head:string;events:{id:string;head:string;kind:'review'|'ci';summary:string}[]}>{
 if(!run.git?.prUrl||!run.git.repository)throw Error('This crate has no GitHub PR.');
 validPrUrl(run.git.prUrl,run.git.repository);
 const data=JSON.parse(await command('gh',['pr','view',run.git.prUrl,'--json','state,headRefOid,reviews,statusCheckRollup'],run.workspace)) as {state:string;headRefOid:string;reviews?:{id:string;state:string;body:string;commit?:{oid:string}}[];statusCheckRollup?:{__typename:string;name?:string;context?:string;conclusion?:string;state?:string;detailsUrl?:string;targetUrl?:string;completedAt?:string}[]};
 if(!['OPEN','CLOSED','MERGED'].includes(data.state)||!/^[a-f0-9]{40}$/.test(data.headRefOid))throw Error('GitHub returned invalid PR state.');
 const events:{id:string;head:string;kind:'review'|'ci';summary:string}[]=[];
 const number=run.git.prUrl.split('/').at(-1)!;
 // The Debian gh version in our image supports pagination and jq, but not --slurp.
 // Emit one JSON value per line so all pages and multiline review bodies remain intact.
 const pages=async<T>(endpoint:string):Promise<T[]> => (await command('gh',['api','--paginate',endpoint,'--jq','.[] | @json'],run.workspace)).split(/\r?\n/).filter(line=>line.trim()).map(line=>JSON.parse(line) as T);
 const reviews=await pages<{id:number;state:string;body:string;commit_id:string;user:{login:string}}>(`repos/${run.git.repository}/pulls/${number}/reviews`);
 const comments=await pages<{pull_request_review_id:number;path:string;line:number|null;body:string}>(`repos/${run.git.repository}/pulls/${number}/comments`);
 const latestByAuthor=new Map<string,typeof reviews[number]>();
 for(const review of reviews)latestByAuthor.set(review.user.login,review);
 for(const review of latestByAuthor.values())if(['CHANGES_REQUESTED','COMMENTED'].includes(review.state)){
  const inline=comments.filter(c=>c.pull_request_review_id===review.id).map(c=>`${c.path}${c.line?':'+c.line:''}: ${c.body}`).join('\n');
  if(review.state==='COMMENTED'&&!review.body.trim()&&!inline)continue;
  events.push({id:`review:${review.id}`,head:review.commit_id,kind:'review',summary:`${review.state}: ${review.body}\n${inline}`.slice(0,8000)});
 }
 for(const check of data.statusCheckRollup??[])if(['FAILURE','TIMED_OUT','CANCELLED','ACTION_REQUIRED','ERROR'].includes(check.conclusion??check.state??''))events.push({id:createHash('sha256').update(JSON.stringify(check)+data.headRefOid).digest('hex'),head:data.headRefOid,kind:'ci',summary:`${check.name??check.context??'CI check'}: ${check.conclusion??check.state}. ${check.detailsUrl??check.targetUrl??''}`.slice(0,8000)});
 return {state:data.state as 'OPEN'|'CLOSED'|'MERGED',head:data.headRefOid,events};
}
