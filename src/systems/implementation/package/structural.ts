import { Buffer } from "node:buffer";

import { PACKAGE_LIMITS } from "./limits.js";
import type { PackageDiagnostic } from "./diagnostics.js";
import type {
  ExpressionAstV1,
  SystemDocumentV1,
  SystemPackageV1,
} from "./schema/index.js";

type StructuralValue = SystemDocumentV1 | SystemPackageV1;

export function validateDocumentStructure(value: SystemDocumentV1): PackageDiagnostic[] {
  return validateStructure(value, "");
}

export function validatePackageStructure(
  value: SystemPackageV1,
  prefix = "",
): PackageDiagnostic[] {
  return validateStructure(value, prefix);
}

export function preflightPackageAstLimits(
  value: unknown,
  prefix = "",
): PackageDiagnostic[] {
  try {
    if (!isObject(value) || !Array.isArray(value.expressions)) return [];
    const diagnostics: PackageDiagnostic[] = [];
    value.expressions.forEach((expression, expressionIndex) => {
      if (!isObject(expression) || !isObject(expression.ast)) return;
      const exceeded = preflightAst(expression.ast);
      if (exceeded === null) return;
      diagnostics.push({
        code: "limit_exceeded",
        path: `${prefix}/expressions/${expressionIndex}/ast`,
        message: exceeded === "nodes"
          ? `Expression AST exceeds ${PACKAGE_LIMITS.expressionAstNodes} nodes.`
          : `Expression AST exceeds depth ${PACKAGE_LIMITS.expressionAstDepth}.`,
      });
    });
    return diagnostics;
  } catch {
    return [];
  }
}

export function preflightExportAstLimits(value: unknown): PackageDiagnostic[] {
  try {
    if (!isObject(value)) return [];
    return preflightPackageAstLimits(value.package, "/package");
  } catch {
    return [];
  }
}

function validateStructure(value: StructuralValue, prefix: string): PackageDiagnostic[] {
  const budgetDiagnostics = validateBudgets(value, prefix);
  if (budgetDiagnostics.length > 0) return budgetDiagnostics;

  const diagnostics: PackageDiagnostic[] = [];
  const definitionIds = new Set<string>();
  const entityIds = new Set<string>();
  const fieldIds = new Set<string>();
  const resourceIds = new Set<string>();
  const expressionIds = new Set<string>();
  const actionIds = new Set<string>();

  const collectId = (id: string, path: string): void => {
    if (definitionIds.has(id)) {
      diagnostics.push({
        code: "duplicate_definition_id",
        path: prefix + path,
        message: "Definition ID must be unique.",
      });
    } else {
      definitionIds.add(id);
    }
  };

  value.entities.forEach((entity, entityIndex) => {
    const entityPath = `/entities/${entityIndex}`;
    collectId(entity.id, `${entityPath}/id`);
    entityIds.add(entity.id);
    entity.fields.forEach((field, fieldIndex) => {
      const fieldPath = `${entityPath}/fields/${fieldIndex}`;
      collectId(field.id, `${fieldPath}/id`);
      fieldIds.add(field.id);
      if (field.kind === "resource") resourceIds.add(field.id);
      if (field.kind === "singleChoice" || field.kind === "multiChoice") {
        field.options.forEach((option, optionIndex) => {
          collectId(option.id, `${fieldPath}/options/${optionIndex}/id`);
        });
      }
    });
  });

  value.referenceData.forEach((dataSet, dataSetIndex) => {
    const dataSetPath = `/referenceData/${dataSetIndex}`;
    collectId(dataSet.id, `${dataSetPath}/id`);
    dataSet.records.forEach((record, recordIndex) => {
      collectId(record.id, `${dataSetPath}/records/${recordIndex}/id`);
    });
  });

  value.sheets.forEach((sheet, sheetIndex) => {
    const sheetPath = `/sheets/${sheetIndex}`;
    collectId(sheet.id, `${sheetPath}/id`);
    sheet.sections.forEach((section, sectionIndex) => {
      const sectionPath = `${sheetPath}/sections/${sectionIndex}`;
      collectId(section.id, `${sectionPath}/id`);
      section.elements.forEach((element, elementIndex) => {
        collectId(element.id, `${sectionPath}/elements/${elementIndex}/id`);
      });
    });
  });

  value.expressions.forEach((expression, expressionIndex) => {
    collectId(expression.id, `/expressions/${expressionIndex}/id`);
    expressionIds.add(expression.id);
  });

  value.actions.forEach((action, actionIndex) => {
    const actionPath = `/actions/${actionIndex}`;
    collectId(action.id, `${actionPath}/id`);
    actionIds.add(action.id);
    if (action.kind === "roll") {
      action.inputs.forEach((input, inputIndex) => {
        collectId(input.id, `${actionPath}/inputs/${inputIndex}/id`);
      });
    }
  });

  value.validations.forEach((validation, validationIndex) => {
    collectId(validation.id, `/validations/${validationIndex}/id`);
  });

  const missing = (exists: boolean, path: string): void => {
    if (!exists) {
      diagnostics.push({
        code: "missing_reference",
        path: prefix + path,
        message: "Referenced definition does not exist.",
      });
    }
  };

  value.entities.forEach((entity, entityIndex) => {
    entity.fields.forEach((field, fieldIndex) => {
      if (field.kind === "computed") {
        missing(
          expressionIds.has(field.expressionId),
          `/entities/${entityIndex}/fields/${fieldIndex}/expressionId`,
        );
      }
    });
  });

  value.sheets.forEach((sheet, sheetIndex) => {
    const sheetPath = `/sheets/${sheetIndex}`;
    missing(entityIds.has(sheet.targetEntityId), `${sheetPath}/targetEntityId`);
    sheet.sections.forEach((section, sectionIndex) => {
      section.elements.forEach((element, elementIndex) => {
        const elementPath = `${sheetPath}/sections/${sectionIndex}/elements/${elementIndex}`;
        if (element.kind === "field") {
          missing(fieldIds.has(element.fieldId), `${elementPath}/fieldId`);
        } else if (element.kind === "resource") {
          missing(resourceIds.has(element.resourceId), `${elementPath}/resourceId`);
        } else if (element.kind === "action") {
          missing(actionIds.has(element.actionId), `${elementPath}/actionId`);
        }
      });
    });
  });

  value.actions.forEach((action, actionIndex) => {
    if (action.kind === "roll") {
      missing(expressionIds.has(action.expressionId), `/actions/${actionIndex}/expressionId`);
    } else {
      missing(resourceIds.has(action.resourceId), `/actions/${actionIndex}/resourceId`);
    }
  });

  value.validations.forEach((validation, validationIndex) => {
    missing(
      expressionIds.has(validation.expressionId),
      `/validations/${validationIndex}/expressionId`,
    );
    missing(definitionIds.has(validation.targetId), `/validations/${validationIndex}/targetId`);
  });

  return diagnostics;
}

function validateBudgets(value: StructuralValue, prefix: string): PackageDiagnostic[] {
  const diagnostics: PackageDiagnostic[] = [];
  let fieldCount = 0;
  for (const [entityIndex, entity] of value.entities.entries()) {
    fieldCount += entity.fields.length;
    if (fieldCount > PACKAGE_LIMITS.fields) {
      diagnostics.push({
        code: "limit_exceeded",
        path: `${prefix}/entities/${entityIndex}/fields`,
        message: `Document contains more than ${PACKAGE_LIMITS.fields} fields.`,
      });
      break;
    }
  }

  let elementCount = 0;
  outer: for (const [sheetIndex, sheet] of value.sheets.entries()) {
    for (const [sectionIndex, section] of sheet.sections.entries()) {
      elementCount += section.elements.length;
      if (elementCount > PACKAGE_LIMITS.sheetElements) {
        diagnostics.push({
          code: "limit_exceeded",
          path: `${prefix}/sheets/${sheetIndex}/sections/${sectionIndex}/elements`,
          message: `Document contains more than ${PACKAGE_LIMITS.sheetElements} sheet elements.`,
        });
        break outer;
      }
    }
  }

  if ("effectiveLimits" in value) {
    validatePackageBudgets(value, prefix, diagnostics);
  } else {
    value.expressions.forEach((expression, expressionIndex) => {
      if (Buffer.byteLength(expression.source, "utf8") > PACKAGE_LIMITS.expressionBytes) {
        diagnostics.push({
          code: "limit_exceeded",
          path: `${prefix}/expressions/${expressionIndex}/source`,
          message: `Expression source exceeds ${PACKAGE_LIMITS.expressionBytes} bytes.`,
        });
      }
    });
  }
  return diagnostics;
}

function validatePackageBudgets(
  value: SystemPackageV1,
  prefix: string,
  diagnostics: PackageDiagnostic[],
): void {
  const ceilings = {
    expressionBytes: PACKAGE_LIMITS.expressionBytes,
    expressionAstNodes: PACKAGE_LIMITS.expressionAstNodes,
    expressionAstDepth: PACKAGE_LIMITS.expressionAstDepth,
    dicePerRoll: PACKAGE_LIMITS.dicePerRoll,
    sidesPerDie: PACKAGE_LIMITS.sidesPerDie,
  } as const;
  for (const key of Object.keys(ceilings) as (keyof typeof ceilings)[]) {
    if (value.effectiveLimits[key] > ceilings[key]) {
      diagnostics.push({
        code: "limit_exceeded",
        path: `${prefix}/effectiveLimits/${key}`,
        message: "Effective limit exceeds the platform ceiling.",
      });
    }
  }

  value.expressions.forEach((expression, expressionIndex) => {
    const { depth, nodes } = measureAst(expression.ast);
    const path = `${prefix}/expressions/${expressionIndex}/ast`;
    if (nodes > PACKAGE_LIMITS.expressionAstNodes) {
      diagnostics.push({
        code: "limit_exceeded",
        path,
        message: `Expression AST exceeds ${PACKAGE_LIMITS.expressionAstNodes} nodes.`,
      });
    }
    if (depth > PACKAGE_LIMITS.expressionAstDepth) {
      diagnostics.push({
        code: "limit_exceeded",
        path,
        message: `Expression AST exceeds depth ${PACKAGE_LIMITS.expressionAstDepth}.`,
      });
    }
  });
}

function measureAst(root: ExpressionAstV1): { depth: number; nodes: number } {
  const pending: { node: ExpressionAstV1; depth: number }[] = [{ node: root, depth: 1 }];
  let depth = 0;
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    nodes += 1;
    depth = Math.max(depth, current.depth);
    const childDepth = current.depth + 1;
    switch (current.node.kind) {
      case "unary":
        pending.push({ node: current.node.operand, depth: childDepth });
        break;
      case "binary":
        pending.push(
          { node: current.node.right, depth: childDepth },
          { node: current.node.left, depth: childDepth },
        );
        break;
      case "call":
        for (const argument of current.node.arguments) {
          pending.push({ node: argument, depth: childDepth });
        }
        break;
      case "dice":
        pending.push({ node: current.node.count, depth: childDepth });
        break;
      case "keep":
      case "successCount":
        pending.push({ node: current.node.dice, depth: childDepth });
        break;
      case "numberLiteral":
      case "stringLiteral":
      case "booleanLiteral":
      case "reference":
        break;
    }
  }
  return { depth, nodes };
}

function preflightAst(root: Record<string, unknown>): "depth" | "nodes" | null {
  const pending: { node: unknown; depth: number }[] = [{ node: root, depth: 1 }];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.depth > PACKAGE_LIMITS.expressionAstDepth) return "depth";
    nodes += 1;
    if (nodes > PACKAGE_LIMITS.expressionAstNodes) return "nodes";
    if (!isObject(current.node)) continue;

    const childDepth = current.depth + 1;
    switch (current.node.kind) {
      case "unary":
        pending.push({ node: current.node.operand, depth: childDepth });
        break;
      case "binary":
        pending.push(
          { node: current.node.right, depth: childDepth },
          { node: current.node.left, depth: childDepth },
        );
        break;
      case "call":
        if (Array.isArray(current.node.arguments)) {
          for (const argument of current.node.arguments) {
            pending.push({ node: argument, depth: childDepth });
          }
        }
        break;
      case "dice":
        pending.push({ node: current.node.count, depth: childDepth });
        break;
      case "keep":
      case "successCount":
        pending.push({ node: current.node.dice, depth: childDepth });
        break;
    }
  }
  return null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
