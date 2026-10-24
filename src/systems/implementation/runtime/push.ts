import {Value} from "@sinclair/typebox/value";
import type {CharacterEntryV1,EntityDefinitionV1,RollActionV1,SystemPackageV1} from "../package/schema/index.js";
import type {NormalizedRoll,RuntimeResult,RuntimeStateV1} from "../../runtime.js";
import type {PushContext} from "./push-context.js";
import {findOwnedAction} from "./action-ownership.js";
import {findGrantedAction} from "./resolve-entries.js";
import {validateEntryForSlot} from "./entries.js";
import {createDeterministicRng} from "./deterministic-rng.js";
import {evaluatePush,pushEligibility} from "../rules/push.js";
export function makePushContext(pkg:SystemPackageV1,entityId:string,action:RollActionV1,entry?:CharacterEntryV1):PushContext|undefined{
 if(!action.pushPolicy)return undefined;
 return {version:"1.0",versionId:pkg.versionId,packageChecksum:pkg.integrity.checksum,entityId,expressionId:action.expressionId,outputTemplate:action.outputTemplate,policy:structuredClone(action.pushPolicy),...(entry&&entry.templateId?{entry:{entryId:entry.entryId,templateId:entry.templateId,slotId:entry.slotId,...(entry.source?{source:entry.source}:{})}}:{})};
}
export function validatePushSource(pkg:SystemPackageV1,entity:EntityDefinitionV1,state:RuntimeStateV1,parent:NormalizedRoll,context:PushContext):string|null{
 if(pkg.versionId!==context.versionId||pkg.integrity.checksum!==context.packageChecksum||entity.id!==context.entityId)return "rules_changed";
 let action;
 if(context.entry){
  const owned=findGrantedAction(pkg,state,context.entry.entryId,parent.actionId);
  if(!owned||!Value.Equal({entryId:owned.entry.entryId,templateId:owned.entry.templateId,slotId:owned.entry.slotId,...(owned.entry.source?{source:owned.entry.source}:{})},context.entry))return "source_unavailable";
  const siblings=Object.values(state.entries??{}).filter(e=>e.slotId===owned.entry.slotId&&e.entryId!==owned.entry.entryId).length;
  if(!validateEntryForSlot(owned.entry,pkg.slots??[],pkg.templates??[],siblings).ok||("nominal" in owned.action&&owned.action.nominal))return "source_unavailable";
  action=owned.action;
 }else action=findOwnedAction(pkg,entity.id,parent.actionId);
 if(!action||action.kind!=="roll"||action.expressionId!==context.expressionId||action.outputTemplate!==context.outputTemplate||!Value.Equal(action.pushPolicy,context.policy))return "source_unavailable";
 return null;
}
export function resolveRuntimePush(input:{pkg:SystemPackageV1;entity:EntityDefinitionV1;state:RuntimeStateV1;parent:NormalizedRoll;context:PushContext;executionId:string;secret:string;optionsOnly?:boolean}):RuntimeResult<{roll:NormalizedRoll;context:PushContext}>{
 const {pkg,entity,state,parent,context}=input;
 const fail=(reason:string):RuntimeResult<never>=>({ok:false,error:{code:"push_unavailable",message:`Push unavailable: ${reason.replaceAll("_"," ")}.`,pushReason:reason}});
 const source=validatePushSource(pkg,entity,state,parent,context);if(source)return fail(source);
 if(!parent.push)return fail("no_policy");
 const options=pushEligibility(context.policy,parent,parent.push.attempt);if(!options.canPush)return fail(options.reason!);
 if(input.optionsOnly)return {ok:true,value:{roll:parent,context}};
 const expression=pkg.expressions.find(e=>e.id===context.expressionId);if(!expression)return fail("invalid_snapshot");
 const bindings={fields:{},inputs:{}} as {fields:Record<string,string|number|boolean|null>;inputs:Record<string,string|number|boolean|null>};
 for(const b of parent.bindings)bindings[b.scope][b.definitionId]=b.value;
 const result=evaluatePush({expression,policy:context.policy,parent,bindings,attempt:parent.push.attempt,rng:createDeterministicRng(input.secret,input.executionId),limits:pkg.effectiveLimits});
 if(!result.ok)return fail(result.reason);
 return {ok:true,value:{context,roll:{...parent,...result.roll,output:context.outputTemplate.split("{total}").join(String(result.roll.total)),push:{...parent.push,parentRollId:parent.push.rollId,rollId:input.executionId,attempt:parent.push.attempt+1,rerolledDiceIds:result.rerolledDiceIds,faceOutcomes:result.faceOutcomes}}}};
}
