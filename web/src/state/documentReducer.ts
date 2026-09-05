export type SystemMetadataV1 = {
  name: string;
  description: string;
  language: string;
  defaultDice: string;
};

export type SystemMetadataPatch = Partial<SystemMetadataV1>;

type FieldWithId = { id: string };
export type EntityFieldV1 = FieldWithId & Record<string, unknown>;
export type EntityDefinitionV1 = {
  id: string;
  label: string;
  fields: EntityFieldV1[];
};
export type ReferenceDataV1 = { id: string; label: string; records: unknown[] };
export type SheetV1 = { id: string; label: string; targetEntityId: string; sections: unknown[] };
export type SourceExpressionV1 = { id: string; context: string; resultType: string; source: string; fallback: unknown };
export type ActionV1 = { id: string; label: string; kind: string } & Record<string, unknown>;
export type ValidationV1 = { id: string; expressionId: string; severity: string; message: string; targetId: string };

export type SystemDocumentV1 = {
  schemaVersion: "1.0";
  metadata: SystemMetadataV1;
  entities: EntityDefinitionV1[];
  referenceData: ReferenceDataV1[];
  sheets: SheetV1[];
  expressions: SourceExpressionV1[];
  actions: ActionV1[];
  validations: ValidationV1[];
};

export type DocumentAction =
  | { type: "setMetadata"; patch: SystemMetadataPatch }
  | { type: "addEntity"; entity: EntityDefinitionV1 }
  | { type: "removeEntity"; entityId: string }
  | { type: "updateField"; entityId: string; fieldId: string; field: EntityFieldV1 }
  | { type: "setEntities"; entities: EntityDefinitionV1[] };

export function blankDocument(): SystemDocumentV1 {
  return {
    schemaVersion: "1.0",
    metadata: {
      name: "",
      description: "",
      language: "en",
      defaultDice: "d20",
    },
    entities: [],
    referenceData: [],
    sheets: [],
    expressions: [],
    actions: [],
    validations: [],
  };
}

export function documentReducer(state: SystemDocumentV1, action: DocumentAction): SystemDocumentV1 {
  switch (action.type) {
    case "setMetadata":
      return {
        ...state,
        metadata: { ...state.metadata, ...action.patch },
      };
    case "addEntity":
      return { ...state, entities: [...state.entities, action.entity] };
    case "removeEntity":
      return {
        ...state,
        entities: state.entities.filter((entity) => entity.id !== action.entityId),
      };
    case "updateField": {
      let mutated = false;
      const entities = state.entities.map((entity) => {
        if (entity.id !== action.entityId) return entity;
        const fields = entity.fields.map((field) => {
          if (field.id !== action.fieldId) return field;
          mutated = true;
          return action.field;
        });
        return mutated ? { ...entity, fields } : entity;
      });
      if (!mutated) return state;
      return { ...state, entities };
    }
    case "setEntities":
      return { ...state, entities: action.entities };
  }
}
