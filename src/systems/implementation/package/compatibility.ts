import type { SystemPackageV1 } from "./schema/index.js";

export type CompatibilityCode =
  | "breaking_type_change"
  | "breaking_removed_definition"
  | "breaking_required_added"
  | "breaking_action_removed"
  | "breaking_validation_removed"
  | "breaking_expression_context_change"
  | "breaking_expression_result_type_change"
  | "template_removed"
  | "template_action_removed"
  | "slot_removed"
  | "slot_kind_narrowed";

export type CompatibilityFinding = {
  code: CompatibilityCode;
  path: string;
  message: string;
};

export type CompatibilityReport = {
  compatible: boolean;
  findings: CompatibilityFinding[];
};

type FieldLike = { id: string; kind: string; required?: boolean };

function indexById<T extends { id: string }>(items: readonly T[]): Map<string, T> {
  const map = new Map<string, T>();
  for (const item of items) map.set(item.id, item);
  return map;
}

function compareFields(
  entityId: string,
  prevFields: readonly FieldLike[],
  nextFields: readonly FieldLike[],
  findings: CompatibilityFinding[],
): void {
  const prevById = indexById(prevFields);
  const nextById = indexById(nextFields);
  for (const [id, prev] of prevById) {
    const base = `/entities/${entityId}/fields/${id}`;
    const next = nextById.get(id);
    if (next === undefined) {
      findings.push({
        code: "breaking_removed_definition",
        path: base,
        message: `Field "${id}" was removed from entity "${entityId}".`,
      });
      continue;
    }
    if (prev.kind !== next.kind) {
      findings.push({
        code: "breaking_type_change",
        path: base,
        message: `Field "${id}" changed kind from "${prev.kind}" to "${next.kind}".`,
      });
    }
    if (prev.required === false && next.required === true) {
      findings.push({
        code: "breaking_required_added",
        path: base,
        message: `Field "${id}" is now required; existing characters must supply a value.`,
      });
    }
  }
}

export function comparePackages(prev: SystemPackageV1, next: SystemPackageV1): CompatibilityReport {
  const findings: CompatibilityFinding[] = [];

  for (const prevEntity of prev.entities) {
    const nextEntity = next.entities.find((e) => e.id === prevEntity.id);
    if (nextEntity === undefined) {
      findings.push({
        code: "breaking_removed_definition",
        path: `/entities/${prevEntity.id}`,
        message: `Entity "${prevEntity.id}" was removed.`,
      });
      continue;
    }
    compareFields(prevEntity.id, prevEntity.fields, nextEntity.fields, findings);
  }

  const prevActions = indexById(prev.actions);
  for (const [id] of prevActions) {
    if (!next.actions.some((a) => a.id === id)) {
      findings.push({
        code: "breaking_action_removed",
        path: `/actions/${id}`,
        message: `Action "${id}" was removed.`,
      });
    }
  }

  const prevValidations = indexById(prev.validations);
  for (const [id] of prevValidations) {
    if (!next.validations.some((v) => v.id === id)) {
      findings.push({
        code: "breaking_validation_removed",
        path: `/validations/${id}`,
        message: `Validation "${id}" was removed.`,
      });
    }
  }

  // Dynamic sheet objects: templates/slots are Type.Optional, so packages
  // without them compare exactly as before. Adding templates, slots, or
  // granted actions is non-breaking; removals and slot-kind narrowing break
  // live entries and take the acknowledge-breaking path.
  const prevTemplates = indexById(prev.templates ?? []);
  const nextTemplates = indexById(next.templates ?? []);
  for (const [id, prevTemplate] of prevTemplates) {
    const nextTemplate = nextTemplates.get(id);
    if (nextTemplate === undefined) {
      findings.push({
        code: "template_removed",
        path: `/templates/${id}`,
        message: `Template "${id}" was removed.`,
      });
      continue;
    }
    const prevGranted = indexById(prevTemplate.grantedActions ?? []);
    for (const [actionId] of prevGranted) {
      if (!(nextTemplate.grantedActions ?? []).some((a) => a.id === actionId)) {
        findings.push({
          code: "template_action_removed",
          path: `/templates/${id}/grantedActions/${actionId}`,
          message: `Granted action "${actionId}" was removed from template "${id}".`,
        });
      }
    }
  }

  const prevSlots = indexById(prev.slots ?? []);
  const nextSlots = indexById(next.slots ?? []);
  for (const [id, prevSlot] of prevSlots) {
    const nextSlot = nextSlots.get(id);
    if (nextSlot === undefined) {
      findings.push({
        code: "slot_removed",
        path: `/slots/${id}`,
        message: `Slot "${id}" was removed.`,
      });
      continue;
    }
    const narrowed = prevSlot.accepts.filter((kind) => !nextSlot.accepts.includes(kind));
    if (narrowed.length > 0) {
      findings.push({
        code: "slot_kind_narrowed",
        path: `/slots/${id}/accepts`,
        message: `Slot "${id}" no longer accepts ${narrowed.map((kind) => `"${kind}"`).join(", ")}.`,
      });
    }
  }

  const prevExpressions = indexById(prev.expressions);
  for (const [id, prevExpression] of prevExpressions) {
    const nextExpression = next.expressions.find((e) => e.id === id);
    if (nextExpression === undefined) continue;
    if (prevExpression.context !== nextExpression.context) {
      findings.push({
        code: "breaking_expression_context_change",
        path: `/expressions/${id}`,
        message: `Expression "${id}" changed context from "${prevExpression.context}" to "${nextExpression.context}".`,
      });
    }
    if (prevExpression.resultType !== nextExpression.resultType) {
      findings.push({
        code: "breaking_expression_result_type_change",
        path: `/expressions/${id}`,
        message: `Expression "${id}" changed result type from "${prevExpression.resultType}" to "${nextExpression.resultType}".`,
      });
    }
  }

  findings.sort((a, b) => a.path.localeCompare(b.path) || a.code.localeCompare(b.code));

  return {
    compatible: findings.length === 0,
    findings,
  };
}
