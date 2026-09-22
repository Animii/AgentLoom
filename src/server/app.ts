import {assessValidation} from './validation.js';
import { registerCrates } from './crates.js';
import { readCratePr } from './git-workspaces.js';
import {Automation} from './automation.js';
import { previewRunGit, publishDraftPr } from './git-workspaces.js';
import { canAssessReview } from '../shared/review-assessment.js';
import { createReviewAssessor } from './review-assessment.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import fastifyStatic from '@fastify/static';
import { z } from 'zod';
import type { AppConfig, ExecuteAgent, ProviderId, ProviderInfo, Run, Workflow } from '../shared/types.js';
import { suggestedCatalog, type ModelCatalog } from '../shared/model-catalog.js';
import { Engine } from './engine.js';
import { ModelCatalogService, type DiscoverModels } from './model-catalog.js';
import { registerRunStream } from './run-stream.js';
import { registerProjectImports } from './project-import.js';
import { Projects, registerProjects } from './projects.js';
import { registerJev } from './jev.js';
import { createExecutor, getProviders } from './providers.js';
import { Store } from './store.js';
import { listDirectoryFiles, listRunFiles, readDirectoryFile, readRunFile } from './workspaces.js';

declare module 'fastify' {
  interface FastifyInstance {
    store: Store;
    engine: Engine;
  }
}

export interface CreateAppOptions {
  readPr?: typeof readCratePr;
  execute?: ExecuteAgent;
  serveStatic?: boolean;
  jevFetch?: typeof fetch;
  publishPr?: typeof publishDraftPr;
  discoverModels?: DiscoverModels;
}

const VERSION = '0.1.0';
const BODY_LIMIT_BYTES = 256 * 1024;
const PROVIDERS_CACHE_MS = 5000;
const MAX_FILE_PATH_LENGTH = 1000;

const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;

const PROVIDER_EFFORTS: Record<ProviderId, readonly string[]> = {
  claude: ['low', 'medium', 'high', 'max'],
  codex: ['low', 'medium', 'high', 'xhigh'],
  opencode: ['low', 'high', 'max'],
};

const ALLOWED_HOSTNAMES: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '::1', 'platform']);

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
].join('; ');

const TERMINAL_RUN_STATUSES: ReadonlySet<Run['status']> = new Set(['completed', 'failed', 'cancelled']);

const idField = z.string().regex(ID_PATTERN, 'must match /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/');
const nameField = z
  .string()
  .transform((value) => value.trim())
  .pipe(
    z
      .string()
      .min(1, 'must not be empty')
      .max(100, 'must be at most 100 characters'),
  );

const modelField = z
  .string()
  .max(120, 'must be at most 120 characters')
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), 'must not contain control characters')
  .refine((value) => !value.startsWith('-'), 'must not begin with "-"');

const stepDefinitionSchema = z
  .strictObject({
    id: idField,
    name: nameField,
    role: z.string().min(1, 'must not be empty').max(100, 'must be at most 100 characters'),
    provider: z.enum(['claude', 'codex', 'opencode']),
    model: modelField,
    effort: z.string(),
    instructions: z.string().max(12000, 'must be at most 12000 characters'),
    access: z.enum(['read-only', 'workspace-write']),
    approval: z.boolean(),
    planning: z.boolean().optional(),
    council: z.strictObject({reviewers:z.array(z.strictObject({id:idField,name:nameField,focus:z.string().min(1).max(2000),provider:z.enum(['claude','codex','opencode']),model:modelField.refine(v=>v.trim().length>0,'Reviewer models must be explicit.'),effort:z.string()})).refine(v=>v.length===1||v.length===3,'Use one reviewer or a three-member council.'),secondOpinion:z.strictObject({id:idField,name:nameField,focus:z.string().min(1).max(2000),provider:z.enum(['claude','codex','opencode']),model:modelField.refine(v=>v.trim().length>0,'Reviewer models must be explicit.'),effort:z.string()}).optional()}).optional(),
    validation: z.strictObject({commands:z.array(z.strictObject({executable:z.string().min(1).max(1000).regex(/^[^\x00-\x1f]+$/),args:z.array(z.string().max(4000).refine(v=>!v.includes('\0'))).max(50),timeoutMs:z.number().int().min(100).max(3600000)})).min(1).max(8)}).optional(),
  })
  .superRefine((step, ctx) => {
    if(step.validation&&(step.planning||step.access!=='read-only'))ctx.addIssue({code:'custom',message:'Validation steps must be read-only and cannot be planning steps.'});
    if(step.council){
      if(step.validation || step.planning || step.access!=='read-only' || !step.approval || !step.model.trim())ctx.addIssue({code:'custom',message:'Council requires an explicit chair model, read-only access and approval; it cannot be planning or validation.'});
      if(new Set(step.council.reviewers.map(r=>r.id)).size!==step.council.reviewers.length || step.council.reviewers.some(r=>r.id==='chair'))ctx.addIssue({code:'custom',message:'Council reviewer IDs must be unique and cannot be chair.'});
      if(step.council.secondOpinion && (step.council.reviewers.length!==1 || ['chair',...step.council.reviewers.map(r=>r.id)].includes(step.council.secondOpinion.id)))ctx.addIssue({code:'custom',message:'A second opinion requires one reviewer and a separate member ID.'});
      for(const member of [...step.council.reviewers,...(step.council.secondOpinion?[step.council.secondOpinion]:[])])if(member.effort && !PROVIDER_EFFORTS[member.provider].includes(member.effort))ctx.addIssue({code:'custom',message:'Invalid council reviewer effort.'});
    }
    const allowed = PROVIDER_EFFORTS[step.provider];
    if (step.effort !== '' && !allowed.includes(step.effort)) {
      ctx.addIssue({
        code: 'custom',
        path: ['effort'],
        message: `must be empty or one of: ${allowed.join(', ')} (for provider "${step.provider}")`,
      });
    }
  });

const workflowSchema = z
  .strictObject({
    allowSplit:z.boolean().optional(),
    archived:z.boolean().optional(),
    id: idField,
    name: nameField,
    description: z.string().max(2000, 'must be at most 2000 characters'),
    steps: z
      .array(stepDefinitionSchema)
      .min(1, 'must have at least 1 step')
      .max(8, 'must have at most 8 steps'),
    updatedAt: z.string().optional(),
  })
  .superRefine((workflow, ctx) => {
    const seen = new Set<string>();
    workflow.steps.forEach((step, index) => {
      if (seen.has(step.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['steps', index, 'id'],
          message: `duplicate step id "${step.id}"`,
        });
      }
      seen.add(step.id);
      if(step.council){
        if(index!==workflow.steps.length-1 || !workflow.steps.slice(0,index).some(s=>s.validation))ctx.addIssue({code:'custom',message:'Council must be the final step after recorded validation.'});
        const writers=workflow.steps.slice(0,index).filter(s=>s.access==='workspace-write');
        if(writers.some(w=>[...step.council!.reviewers,...(step.council!.secondOpinion?[step.council!.secondOpinion]:[])].some(r=>r.provider===w.provider && (!w.model.trim() || r.model.toLowerCase()===w.model.toLowerCase())) || step.provider===w.provider && (!w.model.trim() || step.model.toLowerCase()===w.model.toLowerCase())))ctx.addIssue({code:'custom',message:'The implementer model cannot be an independent council reviewer or chair.'});
      }
      if(step.validation && (index===0 || index===workflow.steps.length-1 || !workflow.steps.slice(0,index).some(s=>s.approval&&s.planning) || !workflow.steps.at(-1)!.approval || workflow.steps.at(-1)!.access!=='read-only'))ctx.addIssue({code:'custom',message:'Recorded validation requires an approved planning step before it and a final read-only review with approval.'});
    });
  });

const runInputSchema = z.strictObject({
  crate: z.boolean().optional(),
  title: z
    .string()
    .min(1, 'must not be empty')
    .max(120, 'must be at most 120 characters')
    .refine((value) => value.trim().length > 0, 'must not be blank'),
  task: z
    .string()
    .min(1, 'must not be empty')
    .max(30000, 'must be at most 30000 characters')
    .refine((value) => value.trim().length > 0, 'must not be blank'),
  project: idField,
  expectedWorkspaceMode: z.enum(['direct', 'isolated', 'worktree']).optional(),
  workflowId: idField,
  mode: z.enum(['live', 'demo']),
  automation:z.strictObject({publication:z.enum(['manual','draft']),escalation:z.literal('fable').optional()}).optional(),
});

const emptyBodySchema = z.strictObject({});

const feedbackBodySchema = z.strictObject({
  feedback: z
    .string()
    .min(1, 'must not be empty')
    .max(8000, 'must be at most 8000 characters')
    .refine((value) => value.trim().length > 0, 'must not be blank'),
});

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function bodyOrEmpty(body: unknown): unknown {
  return body === undefined ? {} : body;
}

interface ValidationIssue {
  readonly path: ReadonlyArray<PropertyKey>;
  readonly message: string;
}

function formatZodError(error: { readonly issues: ReadonlyArray<ValidationIssue> }): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.map(String).join('.') : 'body';
      return `${path}: ${issue.message}`;
    })
    .join('; ');
}

function sendError(reply: FastifyReply, statusCode: number, message: string): FastifyReply {
  return reply.code(statusCode).send({ error: message });
}

function isValidPort(value: string): boolean {
  if (!/^\d{1,5}$/.test(value)) {
    return false;
  }
  const port = Number(value);
  return port >= 1 && port <= 65535;
}

function parseRequestHost(value: string | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 255 || /[\s\u0000-\u001f\u007f]/.test(trimmed)) {
    return null;
  }
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']');
    if (end <= 1) {
      return null;
    }
    const hostname = trimmed.slice(1, end).toLowerCase();
    const remainder = trimmed.slice(end + 1);
    if (remainder.length > 0 && (!remainder.startsWith(':') || !isValidPort(remainder.slice(1)))) {
      return null;
    }
    return hostname;
  }
  const colonCount = trimmed.length - trimmed.replace(/:/g, '').length;
  if (colonCount === 0) {
    return trimmed.toLowerCase();
  }
  if (colonCount > 1) {
    return null;
  }
  const separator = trimmed.indexOf(':');
  const hostname = trimmed.slice(0, separator).toLowerCase();
  const port = trimmed.slice(separator + 1);
  if (hostname.length === 0 || !isValidPort(port)) {
    return null;
  }
  return hostname;
}

function parseOriginHost(origin: string): string | null {
  try {
    const url = new URL(origin);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null;
    }
    let hostname = url.hostname.toLowerCase();
    if (hostname.startsWith('[') && hostname.endsWith(']')) {
      hostname = hostname.slice(1, -1);
    }
    return hostname;
  } catch {
    return null;
  }
}

function parseAfterQuery(query: unknown): number | null {
  if (typeof query !== 'object' || query === null || Array.isArray(query)) {
    return null;
  }
  const raw = (query as Record<string, unknown>).after;
  if (raw === undefined) {
    return 0;
  }
  if (typeof raw !== 'string' || !/^(?:0|[1-9]\d*)$/.test(raw)) {
    return null;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > Number.MAX_SAFE_INTEGER) {
    return null;
  }
  return value;
}

function looksLikeFilePath(urlPath: string): boolean {
  const lastSegment = urlPath.slice(urlPath.lastIndexOf('/') + 1);
  return lastSegment.includes('.');
}

export async function createApp(config: AppConfig, options: CreateAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: true, bodyLimit: BODY_LIMIT_BYTES });
  const store = new Store(config.dataDir);
  for(const run of store.listRuns())if(run.git?.publishing){run.git.publishing=false;store.saveRun(run);}
  const publishing=new Map<string,Promise<unknown>>();
  const projects = new Projects(store, config);
  let evaluateJev: ReturnType<typeof registerJev> | undefined;
  let assessor: ReturnType<typeof createReviewAssessor> | undefined;
  let automation:Automation|undefined;
  let closeCrates:(()=>Promise<void>)|undefined;
  const engine = new Engine(store, config, options.execute ?? createExecutor(config), projects, (id,stepId) => assessor?.assess(id,stepId), (run,evidence)=>assessValidation(run,evidence,evaluateJev));
  app.decorate('store', store);
  app.decorate('engine', engine);
  const modelCatalogs = options.discoverModels
    ? null
    : new ModelCatalogService(config, {
        warn: (provider, status) => app.log.warn({ provider, status }, 'Model discovery unavailable'),
      });
  const discoverModels: DiscoverModels =
    options.discoverModels ?? ((provider, refresh) => modelCatalogs!.get(provider, refresh));

  app.addHook('onClose', async () => {
    await closeCrates?.();
    modelCatalogs?.close();
    await automation?.close();
    await engine.shutdown();
    await Promise.allSettled(publishing.values());
    await assessor?.close();
    store.close();
  });

  app.addHook('onRequest', async (request, reply) => {
    const requestHost = parseRequestHost(request.headers.host);
    if (requestHost === null || !ALLOWED_HOSTNAMES.has(requestHost)) {
      sendError(reply, 403, 'Invalid host header');
      return;
    }
    const origin = request.headers.origin;
    if (typeof origin === 'string' && origin.length > 0) {
      const originHost = parseOriginHost(origin);
      if (originHost === null || originHost !== requestHost) {
        sendError(reply, 403, 'Cross-origin request rejected');
        return;
      }
    }
  });

  app.addHook('preValidation', async (request, reply) => {
    if (request.method !== 'POST' && request.method !== 'PUT' && request.method !== 'PATCH') {
      return;
    }
    if (request.body === undefined || request.body === null) {
      return;
    }
    const header = request.headers['content-type'];
    const mediaType = typeof header === 'string' ? header.split(';', 1)[0].trim().toLowerCase() : '';
    if (mediaType !== 'application/json') {
      sendError(reply, 415, 'Content-Type must be application/json');
    }
  });

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('content-security-policy', CONTENT_SECURITY_POLICY);
    return payload;
  });

  evaluateJev = registerJev(app, config, options.jevFetch ?? fetch);
  async function publish(id:string,input?:{token:string;title:string;body:string}){
    const run=store.getRun(id);if(!run?.git || run.status!=='completed'||run.mode!=='live')throw Error('Complete and approve the worktree run first.');
    if(run.crate?.parentId)throw Error('Child crates are delivered through the parent PR.');
    if(run.git.prUrl&&!run.crate?.updatingPr)return {url:run.git.prUrl,commit:run.git.publishedCommit};
    if(publishing.has(id))throw Error('PR creation is already in progress.');
    run.git.publishing=true;store.saveRun(run);
    const job=(async()=>{await engine.assertValidationCurrent(id);const preview=await previewRunGit(run,config);if(!run.git?.approvedTree||preview.tree!==run.git.approvedTree)throw Error('Files changed after approval. Revalidate and approve the current files.');return (options.publishPr??publishDraftPr)(run,config,input??{token:preview.token,title:preview.title,body:preview.body});})();
    publishing.set(id,job);
    try{const result=await job;const latest=store.getRun(id)!;latest.git={...latest.git!,prUrl:result.url,publishedCommit:result.commit,publishing:false};if(latest.crate){latest.crate.updatingPr=false;latest.crate.prState='OPEN';}store.saveRun(latest);store.addEvent(id,null,'log',`Draft PR published: ${result.url}`);return result;}
    finally{publishing.delete(id);const latest=store.getRun(id);if(latest?.git?.publishing){latest.git.publishing=false;store.saveRun(latest);}}
  }
  automation=new Automation(store,engine,evaluateJev,id=>publish(id));
  closeCrates=registerCrates(app,config,options.readPr);
  app.addHook('preHandler',async(request,reply)=>{
    if(request.method!=='POST')return;
    const match=/^\/api\/runs\/([^/]+)\//.exec(request.url);if(!match)return;
    const run=store.getRun(match[1]);const parent=run?.crate?.parentId?store.getRun(run.crate.parentId):undefined;
    if(run?.crate?.joining || parent?.crate?.joining || parent?.crate?.join==='joined')return sendError(reply,409,'Integration owns these child results. Continue work in the parent crate.');
  });
  app.addHook('preHandler',async(request,reply)=>{
    const match=/^\/api\/runs\/([^/]+)\/(messages|revise|rework|retry|cancel|approve|second-opinion|crate-triage|crate-split|crate-join|crate-enable)$/.exec(request.url.split('?')[0]);
    if(request.method!=='POST'||!match)return;
    const run=store.getRun(match[1]);
    if(!run?.automation?.approvedAt)return;
    try{automation!.pause(run.id,'You took control of this run. Resume automation when ready.');}catch(error){return sendError(reply,409,errorMessage(error));}
  });
  app.post<{Params:{id:string;action:string}}>('/api/runs/:id/automation/:action',async(request,reply)=>{
    if(!emptyBodySchema.safeParse(bodyOrEmpty(request.body)).success)return sendError(reply,400,'Expected an empty body.');
    if(!store.getRun(request.params.id)?.automation)return sendError(reply,404,'Automated run not found.');
    try{if(request.params.action==='pause')automation!.pause(request.params.id);else if(request.params.action==='resume')automation!.resume(request.params.id);else return sendError(reply,404,'Unknown automation action.');return store.getRun(request.params.id);}catch(error){return sendError(reply,409,errorMessage(error));}
  });
  app.post<{Params:{id:string}}>('/api/runs/:id/revalidate',async(request,reply)=>{
    if(!emptyBodySchema.safeParse(bodyOrEmpty(request.body)).success)return sendError(reply,400,'Expected an empty body.');
    try{automation!.pause(request.params.id);return engine.revalidate(request.params.id);}catch(error){return sendError(reply,409,errorMessage(error));}
  });
  app.post<{Params:{id:string}}>('/api/runs/:id/second-opinion',async(request,reply)=>{
    const parsed=z.strictObject({question:z.string().trim().min(1).max(8000)}).safeParse(request.body);
    if(!parsed.success)return sendError(reply,400,'A focused question is required.');
    try{return await engine.secondOpinion(request.params.id,parsed.data.question);}catch(error){return sendError(reply,409,errorMessage(error));}
  });
  assessor = createReviewAssessor(store, evaluateJev);
  app.post<{Params:{id:string;stepId:string}}>('/api/runs/:id/steps/:stepId/assessment', async(request,reply)=>{
    const parsed=emptyBodySchema.safeParse(bodyOrEmpty(request.body));
    if(!parsed.success)return sendError(reply,400,'Expected an empty request body');
    const run=store.getRun(request.params.id);
    if(!run)return sendError(reply,404,'Run not found');
    const step=run.steps.find(s=>s.definition.id===request.params.stepId);
    if(!step || !canAssessReview(step))return sendError(reply,409,'This step has no completed review to classify');
    await assessor!.assess(run.id,step.definition.id,true);
    return store.getRun(run.id);
  });
  registerRunStream(app, store);
  registerProjectImports(app, config.workspaceRoot);

  app.get('/api/health', async () => ({ ok: true, version: VERSION }));

  app.get('/api/workflows', async () => store.listWorkflows());

  app.patch<{ Params: { id: string } }>('/api/workflows/:id', async (request, reply) => {
    const parsed = z.strictObject({ archived: z.boolean() }).safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, 'Provide an archived boolean.');
    const workflow = store.getWorkflow(request.params.id);
    if (!workflow) return sendError(reply, 404, 'Workflow not found.');
    const updated = { ...workflow, archived: parsed.data.archived, updatedAt: new Date().toISOString() };
    store.saveWorkflow(updated);
    return updated;
  });

  app.put<{ Params: { id: string } }>('/api/workflows/:id', async (request, reply) => {
    const params = z.strictObject({ id: idField }).safeParse(request.params);
    if (!params.success) {
      return sendError(reply, 400, formatZodError(params.error));
    }
    const parsed = workflowSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, formatZodError(parsed.error));
    }
    if (params.data.id !== parsed.data.id) {
      return sendError(reply, 400, 'Workflow id in path does not match body id');
    }
    const workflow: Workflow = {
      archived:store.getWorkflow(parsed.data.id)?.archived,
      allowSplit:parsed.data.allowSplit,
      id: parsed.data.id,
      name: parsed.data.name,
      description: parsed.data.description,
      steps: parsed.data.steps,
      updatedAt: new Date().toISOString(),
    };
    store.saveWorkflow(workflow);
    return reply.code(200).send(workflow);
  });

  registerProjects(app, projects);

  let providersCache: { expiresAt: number; value: ProviderInfo[] } | null = null;
  app.get('/api/providers', async () => {
    const now = Date.now();
    if (providersCache === null || providersCache.expiresAt <= now) {
      const value = await getProviders(config);
      providersCache = { expiresAt: Date.now() + PROVIDERS_CACHE_MS, value };
    }
    return providersCache.value;
  });

  const providerIdParams = z.strictObject({ id: z.enum(['claude', 'codex', 'opencode']) });

  async function readModelCatalog(provider: ProviderId, refresh: boolean): Promise<ModelCatalog> {
    if (provider === 'claude') {
      return suggestedCatalog('claude', 'builtin');
    }
    try {
      return await discoverModels(provider, refresh);
    } catch {
      return suggestedCatalog(provider, 'failed');
    }
  }

  app.get<{ Params: { id: string } }>('/api/providers/:id/models', async (request, reply) => {
    const params = providerIdParams.safeParse(request.params);
    if (!params.success) {
      return sendError(reply, 400, formatZodError(params.error));
    }
    return readModelCatalog(params.data.id, false);
  });

  app.post<{ Params: { id: string } }>('/api/providers/:id/models/refresh', async (request, reply) => {
    const params = providerIdParams.safeParse(request.params);
    if (!params.success) {
      return sendError(reply, 400, formatZodError(params.error));
    }
    const body = emptyBodySchema.safeParse(bodyOrEmpty(request.body));
    if (!body.success) {
      return sendError(reply, 400, formatZodError(body.error));
    }
    return readModelCatalog(params.data.id, true);
  });

  app.get('/api/runs', async () => store.listRuns());

  app.post('/api/runs', async (request, reply) => {
    const parsed = runInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, formatZodError(parsed.error));
    }
    if (!store.getWorkflow(parsed.data.workflowId)) {
      return sendError(reply, 404, 'Workflow not found');
    }
    try {
      const run = await engine.create(parsed.data);
      return reply.code(201).send(run);
    } catch (error) {
      if (errorMessage(error) === 'Workflow not found') {
        return sendError(reply, 404, 'Workflow not found');
      }
      request.log.error({ err: error }, 'Failed to create run');
      return sendError(reply, 409, errorMessage(error));
    }
  });

  app.get<{ Params: { id: string } }>('/api/runs/:id', async (request, reply) => {
    const run = store.getRun(request.params.id);
    if (!run) {
      return sendError(reply, 404, 'Run not found');
    }
    return run;
  });

  app.get<{Params:{id:string}}>('/api/runs/:id/git',async(request,reply)=>{
    const run=store.getRun(request.params.id);if(!run)return sendError(reply,404,'Run not found');
    try{return await previewRunGit(run,config);}catch(error){return sendError(reply,409,errorMessage(error));}
  });
  app.post<{Params:{id:string}}>('/api/runs/:id/pull-request',async(request,reply)=>{
    const body=z.strictObject({token:z.string().regex(/^[a-f0-9]{64}$/),title:z.string().trim().min(1).max(200),body:z.string().max(30000)}).safeParse(request.body);
    if(!body.success)return sendError(reply,400,'A current diff preview, title and body are required.');
    const run=store.getRun(request.params.id);if(!run)return sendError(reply,404,'Run not found');
    if(run.git?.prUrl&&!run.crate?.updatingPr)return {url:run.git.prUrl};
    if(run.mode!=='live'||run.status!=='completed'||!run.git)return sendError(reply,409,'Complete and approve the worktree run first.');
    if(publishing.has(run.id))return sendError(reply,409,'PR creation is already in progress.');
    try{
      return await publish(run.id,body.data);
    }catch(error){return sendError(reply,409,errorMessage(error));}
  });

  app.post<{ Params: { id: string } }>('/api/runs/:id/approve', async (request, reply) => {
    const body = z.strictObject({ acknowledgedAssessment: z.string().max(200).optional() }).safeParse(bodyOrEmpty(request.body));
    if (!body.success) {
      return sendError(reply, 400, formatZodError(body.error));
    }
    const run = store.getRun(request.params.id);
    if (!run) {
      return sendError(reply, 404, 'Run not found');
    }
    if (run.status !== 'waiting_approval') {
      return sendError(reply, 409, `Cannot approve run in status "${run.status}"`);
    }
    try {
      return await engine.approveCurrent(run.id, body.data.acknowledgedAssessment);
    } catch (error) {
      return sendError(reply, 409, errorMessage(error));
    }
  });

  app.post<{ Params: { id: string } }>('/api/runs/:id/revise', async (request, reply) => {
    const parsed = feedbackBodySchema.safeParse(bodyOrEmpty(request.body));
    if (!parsed.success) {
      return sendError(reply, 400, formatZodError(parsed.error));
    }
    const run = store.getRun(request.params.id);
    if (!run) {
      return sendError(reply, 404, 'Run not found');
    }
    if (run.status !== 'waiting_approval' && run.status !== 'blocked') {
      return sendError(reply, 409, `Cannot revise run in status "${run.status}"`);
    }
    try {
      return engine.revise(run.id, parsed.data.feedback);
    } catch (error) {
      return sendError(reply, 409, errorMessage(error));
    }
  });

  app.post<{ Params: { id: string } }>('/api/runs/:id/rework', async (request, reply) => {
    const parsed = emptyBodySchema.safeParse(bodyOrEmpty(request.body));
    if (!parsed.success) return sendError(reply, 400, formatZodError(parsed.error));
    if (!store.getRun(request.params.id)) return sendError(reply, 404, 'Run not found');
    try { return engine.rework(request.params.id); }
    catch (error) { return sendError(reply, 409, errorMessage(error)); }
  });

  app.post<{ Params: { id: string } }>('/api/runs/:id/messages', async (request, reply) => {
    const parsed = z.strictObject({
      stepId: idField,
      messageId: z.string().uuid(),
      message: z.string().trim().min(1).max(8000),
    }).safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, formatZodError(parsed.error));
    if (!store.getRun(request.params.id)) return sendError(reply, 404, 'Run not found');
    try {
      return engine.chat(request.params.id, parsed.data.stepId, parsed.data.message, parsed.data.messageId);
    } catch (error) {
      return sendError(reply, 409, errorMessage(error));
    }
  });

  app.post<{ Params: { id: string } }>('/api/runs/:id/retry', async (request, reply) => {
    const body = emptyBodySchema.safeParse(bodyOrEmpty(request.body));
    if (!body.success) {
      return sendError(reply, 400, formatZodError(body.error));
    }
    const run = store.getRun(request.params.id);
    if (!run) {
      return sendError(reply, 404, 'Run not found');
    }
    if (run.status !== 'failed' && run.status !== 'interrupted') {
      return sendError(reply, 409, `Cannot retry run in status "${run.status}"`);
    }
    try {
      return engine.retry(run.id);
    } catch (error) {
      return sendError(reply, 409, errorMessage(error));
    }
  });

  app.post<{ Params: { id: string } }>('/api/runs/:id/cancel', async (request, reply) => {
    const body = emptyBodySchema.safeParse(bodyOrEmpty(request.body));
    if (!body.success) {
      return sendError(reply, 400, formatZodError(body.error));
    }
    const run = store.getRun(request.params.id);
    if (!run) {
      return sendError(reply, 404, 'Run not found');
    }
    if (TERMINAL_RUN_STATUSES.has(run.status)) {
      return sendError(reply, 409, `Cannot cancel run in status "${run.status}"`);
    }
    try {
      return engine.cancel(run.id);
    } catch (error) {
      return sendError(reply, 409, errorMessage(error));
    }
  });

  app.get<{ Params: { id: string } }>('/api/runs/:id/events', async (request, reply) => {
    const run = store.getRun(request.params.id);
    if (!run) {
      return sendError(reply, 404, 'Run not found');
    }
    const after = parseAfterQuery(request.query);
    if (after === null) {
      return sendError(reply, 400, '"after" must be an integer between 0 and 9007199254740991');
    }
    return store.getEvents(run.id, after);
  });

  app.get<{ Params: { id: string } }>('/api/runs/:id/files', async (request, reply) => {
    const run = store.getRun(request.params.id);
    if (!run) {
      return sendError(reply, 404, 'Run not found');
    }
    if (run.workspace.length === 0) {
      return [];
    }
    try {
      return run.projectLocation?.workspaceMode === 'direct' ? await listDirectoryFiles(await projects.directFolder(run)) : await listRunFiles(config.workspaceRoot, run.id);
    } catch (error) {
      return sendError(reply, 400, errorMessage(error));
    }
  });

  app.get<{ Params: { id: string }; Querystring: { path?: unknown } }>(
    '/api/runs/:id/file',
    async (request, reply) => {
      const run = store.getRun(request.params.id);
      if (!run) {
        return sendError(reply, 404, 'Run not found');
      }
      const rawPath = request.query.path;
      if (
        typeof rawPath !== 'string' ||
        rawPath.length > MAX_FILE_PATH_LENGTH ||
        rawPath.trim().length === 0
      ) {
        return sendError(reply, 400, '"path" must be a non-empty relative path of at most 1000 characters');
      }
      try {
        const content = run.projectLocation?.workspaceMode === 'direct' ? await readDirectoryFile(await projects.directFolder(run), rawPath) : await readRunFile(config.workspaceRoot, run.id, rawPath);
        return { path: rawPath, content };
      } catch (error) {
        return sendError(reply, 400, errorMessage(error));
      }
    },
  );

  const frontendDir = fileURLToPath(new URL('../client', import.meta.url));
  const staticEnabled = options.serveStatic !== false && existsSync(join(frontendDir, 'index.html'));

  app.setNotFoundHandler((request, reply) => {
    const urlPath = request.url.split('?', 1)[0];
    if (urlPath === '/api' || urlPath.startsWith('/api/')) {
      reply.code(404).send({ error: 'Not found' });
      return;
    }
    const isRead = request.method === 'GET' || request.method === 'HEAD';
    if (isRead && staticEnabled && !looksLikeFilePath(urlPath)) {
      reply.sendFile('index.html');
      return;
    }
    if (isRead && urlPath === '/' && !staticEnabled) {
      reply
        .code(200)
        .type('text/plain; charset=utf-8')
        .send('Frontend not built. Run npm run build or npm run dev:web.');
      return;
    }
    reply.code(404).send({ error: 'Not found' });
  });

  if (staticEnabled) {
    await app.register(fastifyStatic, { root: frontendDir, prefix: '/', wildcard: true });
  }

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof z.ZodError) {
      reply.code(400).send({ error: formatZodError(error) });
      return;
    }
    const statusCode =
      typeof error === 'object' &&
      error !== null &&
      'statusCode' in error &&
      typeof error.statusCode === 'number'
        ? error.statusCode
        : 500;
    if (statusCode >= 400 && statusCode < 500) {
      const message = errorMessage(error);
      reply.code(statusCode).send({ error: message.length > 0 ? message : 'Bad request' });
      return;
    }
    request.log.error({ err: error }, 'Unhandled request error');
    reply.code(500).send({ error: 'Internal server error' });
  });

  return app;
}
