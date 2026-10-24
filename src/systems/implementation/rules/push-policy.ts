import {Value} from "@sinclair/typebox/value";
import {PushPolicySchema} from "../package/schema/push-policy.js";
import type {ActionV1, ExpressionAstV1, ObjectTemplateV1} from "../package/schema/index.js";
import type {RulesDiagnostic} from "./diagnostic.js";
import {children} from "./groups.js";
export function containsDice(n:ExpressionAstV1):boolean{return n.kind==="dice"||children(n).some(containsDice);}
/** Only additive dice reductions and bounded literal scaling can vary on a push. */
function affine(n:ExpressionAstV1,scale=1):boolean{
 if(!containsDice(n))return true;
 if(n.kind==="dice")return !containsDice(n.count);
 if(n.kind==="successCount")return n.dice.kind==="dice"&&!containsDice(n.dice.count);
 if(n.kind==="unary"&&n.operator==="-")return affine(n.operand,-scale);
 if(n.kind==="binary"){
  if(n.operator==="+"||n.operator==="-")return affine(n.left,scale)&&affine(n.right,scale);
  if(n.operator==="*"){
   const lit=(x:ExpressionAstV1):number|undefined=>x.kind==="numberLiteral"?x.value:x.kind==="unary"&&x.operator==="-"&&x.operand.kind==="numberLiteral"?-x.operand.value:undefined;
   const l=lit(n.left),r=lit(n.right),factor=l??r;
   return factor!==undefined&&Number.isFinite(scale*factor)&&Math.abs(scale*factor)<=1e6&&affine(l!==undefined?n.right:n.left,scale*factor);
  }
 }
 return false;
}
export function validatePushPolicies(value:{schemaVersion:string;actions:ActionV1[];templates?:ObjectTemplateV1[];expressions:{id:string;ast?:ExpressionAstV1}[]}):RulesDiagnostic[]{
 const errors:RulesDiagnostic[]=[];
 const actions=[...value.actions.map((action,i)=>({action,path:`/actions/${i}/pushPolicy`})),...(value.templates??[]).flatMap((t,i)=>t.grantedActions.map((action,j)=>({action,path:`/templates/${i}/grantedActions/${j}/pushPolicy`})) )];
 for(const {action,path} of actions){
  if(action.kind!=="roll"||action.pushPolicy===undefined)continue;
  const fail=(message:string)=>errors.push({code:"invalid_expression",path,message});
  if(value.schemaVersion!=="1.2"){fail("Push policies require package 1.2.");continue;}
  if(!Value.Check(PushPolicySchema,action.pushPolicy)){fail("Invalid bounded push policy.");continue;}
  if("nominal" in action&&action.nominal===true){fail("Nominal actions cannot be pushed.");continue;}
  if(new Set(action.pushPolicy.groups.map(g=>g.groupId)).size!==action.pushPolicy.groups.length)fail("Push group IDs must be unique.");
  const ast=value.expressions.find(e=>e.id===action.expressionId)?.ast;
  if(ast===undefined)continue; // Source documents are checked again after compilation.
  if(!affine(ast))fail("Push requires additive sum/count dice terms and bounded literal scaling; keep and nonlinear dice formulas are unsupported.");
  const groups=new Map<string,number>();
  const walk=(n:ExpressionAstV1)=>{if(n.kind==="dice"&&n.group)groups.set(n.group.id,n.sides);children(n).forEach(walk);};walk(ast);
  for(const g of action.pushPolicy.groups){const sides=groups.get(g.groupId);if(sides===undefined)fail(`Unknown named push group: ${g.groupId}.`);else if([...g.lockedFaces,...g.reportedFaces].some(face=>face>sides))fail(`Push face exceeds die sides for ${g.groupId}.`);}
 }
 return errors;
}
