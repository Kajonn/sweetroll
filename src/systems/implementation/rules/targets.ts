/** Entities a target of a roll action may belong to (design 6.4, SRD gaps S7). */
export function targetEntityIds(target: { entityId: string; otherEntityIds?: readonly string[] | undefined } | undefined): string[] {
  return target === undefined ? [] : [target.entityId, ...(target.otherEntityIds ?? [])];
}
