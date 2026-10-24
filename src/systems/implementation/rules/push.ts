import {Value} from "@sinclair/typebox/value";
import {evaluate} from "./evaluate.js";
import {PushPolicySchema} from "../package/schema/push-policy.js";
import type {CompiledExpressionV1, PushPolicy} from "../package/schema/index.js";
import type {EvaluationBindings, EvaluationLimits, Rng, RollResult} from "./evaluate.js";
export type PushEvaluationInput={expression:CompiledExpressionV1;policy:PushPolicy;parent:RollResult;bindings:EvaluationBindings;attempt:number;rng:Rng;limits:EvaluationLimits};
export type FaceOutcome={groupId:string;face:number;combinedCount:number;rerolledCount:number};
export type PushEvaluationResult={ok:true;roll:RollResult;rerolledDiceIds:string[];faceOutcomes:FaceOutcome[]}|{ok:false;reason:string};
export function pushEligibility(policy:PushPolicy,parent:RollResult,attempt:number):{canPush:boolean;reason:string|null;eligibleDiceIds:string[]}{
 const unavailable=(reason:string)=>({canPush:false,reason,eligibleDiceIds:[]});
 if(!Value.Check(PushPolicySchema,policy)||!Number.isInteger(attempt)||attempt<0||!parent.breakdown||parent.dice.length>100)return unavailable("invalid_snapshot");
 if(attempt>=policy.maxAttempts)return unavailable("exhausted");
 if(!policy.allowOnSuccess&&parent.total>=policy.successThreshold)return unavailable("successful_roll");
 const groups=new Map(policy.groups.map(g=>[g.groupId,g]));
 const eligibleDiceIds=parent.dice.filter(d=>d.kept&&d.id&&d.groupId&&groups.has(d.groupId)&&!groups.get(d.groupId)!.lockedFaces.includes(d.value)).map(d=>d.id!);
 return eligibleDiceIds.length?{canPush:true,reason:null,eligibleDiceIds}:unavailable("no_eligible_dice");
}
export function evaluatePush(input:PushEvaluationInput):PushEvaluationResult{
 const {parent,policy,expression,bindings,attempt,limits}=input;
 const options=pushEligibility(policy,parent,attempt);
 if(!options.canPush)return {ok:false,reason:options.reason!};
 try{
  let index=0;
  const original=evaluate(expression,bindings,()=>{const d=parent.dice[index++];if(!d)throw Error("extra die");return (d.value-.5)/d.sides;},limits);
  if(!original.ok||!original.roll||original.diagnostics.length||index!==parent.dice.length||!Value.Equal(original.roll,{expression:parent.expression,total:parent.total,dice:parent.dice,breakdown:parent.breakdown}))return {ok:false,reason:"invalid_snapshot"};
  const eligible=new Set(options.eligibleDiceIds);index=0;
  const result=evaluate(expression,bindings,()=>{const d=parent.dice[index++];if(!d)throw Error("extra die");if(!eligible.has(d.id!))return (d.value-.5)/d.sides;const draw=input.rng();if(!Number.isFinite(draw)||draw<0||draw>1)throw Error("invalid draw");return draw;},limits);
  if(!result.ok||!result.roll||result.diagnostics.length||index!==parent.dice.length)return {ok:false,reason:"invalid_snapshot"};
  return {ok:true,roll:result.roll,rerolledDiceIds:options.eligibleDiceIds,faceOutcomes:policy.groups.flatMap(g=>g.reportedFaces.map(face=>({groupId:g.groupId,face,combinedCount:result.roll!.dice.filter(d=>d.groupId===g.groupId&&d.value===face).length,rerolledCount:result.roll!.dice.filter(d=>d.groupId===g.groupId&&d.value===face&&eligible.has(d.id!)).length})))};
 }catch{return {ok:false,reason:"invalid_snapshot"};}
}
