import {useState} from "react";
import {parse,children,validatePushPolicies,type ExpressionAstV1,type PushPolicy} from "@sweetroll/rules";
import {Checkbox,NumberInput,FormField} from "../../ui/index.js";
function Faces({label,value,sides,disabled,onChange}:{label:string;value:number[];sides:number;disabled:boolean;onChange:(v:number[])=>void}){
 const [raw,setRaw]=useState(value.join(", "));const [error,setError]=useState<string|null>(null);
 return <FormField label={label}><input type="text" value={raw} disabled={disabled} aria-label={label} aria-invalid={error!==null} onChange={e=>{setRaw(e.target.value);const values=e.target.value.split(",").map(s=>s.trim()).filter(Boolean).map(Number);if(values.some(v=>!Number.isInteger(v)||v<1||v>sides)||new Set(values).size!==values.length){setError(`Use unique faces from 1 to ${sides}, separated by commas.`);return;}setError(null);onChange(values);}}/>{error?<span role="alert">{error}</span>:null}</FormField>;
}
export function PushPolicyEditor({source,policy,onChange,disabled=false}:{source:string;policy:PushPolicy|undefined;onChange:(p:PushPolicy|undefined)=>void;disabled?:boolean|undefined}){
 const parsed=parse(source);const groups:{id:string;label:string;sides:number}[]=[];
 const walk=(n:ExpressionAstV1)=>{if(n.kind==="dice"&&n.group)groups.push({...n.group,sides:n.sides});children(n).forEach(walk);};if(parsed.ok)walk(parsed.ast);
 const suggested:PushPolicy={version:"1.0",maxAttempts:1,successThreshold:1,allowOnSuccess:false,groups:groups.map(g=>({groupId:g.id,lockedFaces:[],reportedFaces:[]}))};
 const candidate=policy??suggested;
 const errors=parsed.ok?validatePushPolicies({schemaVersion:"1.2",actions:[{kind:"roll",id:"editor",label:"",expressionId:"expr",outputTemplate:"",inputs:[],pushPolicy:candidate}],expressions:[{id:"expr",ast:parsed.ast}]}):[{message:"Invalid expression."}];
 const supported=groups.length>0&&errors.length===0;
 const update=(patch:Partial<PushPolicy>)=>onChange({...candidate,...patch});
 return <details><summary>Push rules</summary>
  <Checkbox label="Enable pushing" checked={policy!==undefined} disabled={disabled||(!supported&&!policy)} onChange={e=>onChange(e.target.checked?suggested:undefined)}/>
  {!supported?<p role="status">Pushing needs a named dice group in an additive sum/count formula. {errors[0]?.message}</p>:null}
  {policy?<div>
   <p>Push the original saved pool. Unlisted groups and locked faces stay unchanged. Reported faces are for manual bookkeeping.</p>
   <NumberInput label="Maximum pushes" value={policy.maxAttempts} min={1} max={10} disabled={disabled} onChange={v=>update({maxAttempts:v??1})}/>
   <NumberInput label="Success threshold for pushing" value={policy.successThreshold} min={-1e9} max={1e9} disabled={disabled} onChange={v=>update({successThreshold:v??1})}/>
   <Checkbox label="Allow pushing a successful roll" checked={policy.allowOnSuccess} disabled={disabled} onChange={e=>update({allowOnSuccess:e.target.checked})}/>
   {groups.map(g=>{const configured=policy.groups.find(p=>p.groupId===g.id);const change=(patch:Partial<PushPolicy["groups"][number]>)=>update({groups:policy.groups.map(p=>p.groupId===g.id?{...p,...patch}:p)});return <fieldset key={g.id}><legend>{g.label} (d{g.sides})</legend>
    <Checkbox label={`Push ${g.label}`} checked={configured!==undefined} disabled={disabled} onChange={e=>update({groups:e.target.checked?[...policy.groups,{groupId:g.id,lockedFaces:[],reportedFaces:[]}]:policy.groups.filter(p=>p.groupId!==g.id)})}/>
    {configured?<><Faces label={`Locked faces for ${g.label}`} value={configured.lockedFaces} sides={g.sides} disabled={disabled} onChange={v=>change({lockedFaces:v})}/><Faces label={`Reported faces for ${g.label}`} value={configured.reportedFaces} sides={g.sides} disabled={disabled} onChange={v=>change({reportedFaces:v})}/></>:null}
   </fieldset>;})}
  </div>:null}
 </details>;
}
