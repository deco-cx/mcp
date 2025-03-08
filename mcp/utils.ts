import type { JSONSchema7 } from "@deco/deco";

export function dereferenceSchema(
  schema: JSONSchema7 | undefined,
  definitions: { [key: string]: JSONSchema7 },
  visited = new Set<string>(),
): JSONSchema7 | undefined {
  if (!schema) return undefined;

  // Handle direct $ref
  if ("$ref" in schema && typeof schema.$ref === "string") {
    const refId = idFromDefinition(schema.$ref);
    if (visited.has(refId)) {
      // Prevent infinite recursion
      return { type: "object", properties: {} };
    }
    visited.add(refId);
    const referencedSchema = definitions[refId];
    return dereferenceSchema(
      referencedSchema as JSONSchema7,
      definitions,
      visited,
    );
  }

  const result: JSONSchema7 = { ...schema };

  // Handle allOf
  if (result.allOf) {
    result.allOf = result.allOf.map((subSchema) =>
      dereferenceSchema(
        subSchema as JSONSchema7,
        definitions,
        visited,
      )
    ) as JSONSchema7[];
  }

  // Handle anyOf
  if (result.anyOf) {
    result.anyOf = result.anyOf.map((subSchema) =>
      dereferenceSchema(
        subSchema as JSONSchema7,
        definitions,
        visited,
      )
    ) as JSONSchema7[];
  }

  // Handle oneOf
  if (result.oneOf) {
    result.oneOf = result.oneOf.map((subSchema) =>
      dereferenceSchema(
        subSchema as JSONSchema7,
        definitions,
        visited,
      )
    ) as JSONSchema7[];
  }

  // Handle properties
  if (result.properties) {
    const dereferencedProperties: { [key: string]: JSONSchema7 } = {};
    for (const [key, prop] of Object.entries(result.properties)) {
      dereferencedProperties[key] = dereferenceSchema(
        prop as JSONSchema7,
        definitions,
        visited,
      ) as JSONSchema7;
    }
    result.properties = dereferencedProperties;
  }

  // Handle additionalProperties
  if (
    result.additionalProperties &&
    typeof result.additionalProperties === "object"
  ) {
    result.additionalProperties = dereferenceSchema(
      result.additionalProperties as JSONSchema7,
      definitions,
      visited,
    );
  }

  return result;
}

function idFromDefinition(definition: string): string {
  const [_, __, id] = definition.split("/");
  return id;
}
