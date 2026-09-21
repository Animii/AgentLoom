import {useState} from 'react';
import type {Run} from '../shared/types';
export default function AutomationPanel({run}:{run:Run}){
 const [error,setError]=useState('');const [busy,setBusy]=useState(false);const policy=run.automation;
 if(!policy)return null;
 async function action(name:string){setBusy(true);setError('');try{const response=await fetch(`/api/runs/${run.id}/${name==='revalidate'?'revalidate':`automation/${name}`}`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});const result=await response.json();if(!response.ok)throw Error(result.error);}catch(error){setError(error instanceof Error?error.message:'Action failed.');}finally{setBusy(false);}}
 return <section className="git-run-panel" aria-label="PR machine"><strong>PR machine · {policy.status.replaceAll('_',' ')}</strong><p>{policy.message}</p>
 <p className="field-helper">{policy.repairsUsed} of {policy.maxRepairs} repairs used · {policy.publication==='draft'?'Automatically create a draft PR after successful review':'Manual draft publication'} · Merge remains manual.</p>
 {policy.escalation&&<p className="field-helper">Fable rescue: {policy.escalation.used?'used':'one attempt authorized with plan approval'} · {policy.escalation.model} · Independent Astra review follows. Fable cannot review its own implementation.</p>}
 {policy.status==='awaiting_plan'&&<p>Approving this plan authorizes Jev to return in-scope findings for repair and complete the run after passing validation and council review.</p>}
 {policy.status==='paused'&&policy.approvedAt?<button className="btn" disabled={busy} onClick={()=>void action('resume')}>{run.status==='completed'?'Retry publication':'Resume automation'}</button>:['active','deciding'].includes(policy.status)&&<button className="btn ghost" disabled={busy} onClick={()=>void action('pause')}>Pause automation</button>}
 {error&&<p role="alert" className="error-banner">{error}</p>}
 {policy.status==='paused'&&!run.git?.prUrl&&['completed','blocked','waiting_approval'].includes(run.status)&&<button className="btn ghost" disabled={busy} onClick={()=>void action('revalidate')}>Repeat validation and review</button>}
 {!!policy.decisions.length&&<details><summary>Routing decisions ({policy.decisions.length})</summary>{policy.decisions.map((d,i)=><p key={i}><strong>{d.action}</strong> · {Math.round(d.confidence*100)}% confidence<br/>{d.reason}{d.offeredActions&&<><br/><small>Available actions: {d.offeredActions.join(', ')}</small></>}</p>)}</details>}
 </section>;
}
