import type {SystemPackageV1} from "../package/schema/index.js";
export function findOwnedAction(packageValue:SystemPackageV1,entityId:string,actionId:string){
 const owned=packageValue.sheets.filter(s=>s.targetEntityId===entityId).some(s=>s.sections.some(section=>section.elements.some(e=>e.kind==="action"&&e.actionId===actionId)));
 return owned?packageValue.actions.find(a=>a.id===actionId):undefined;
}
