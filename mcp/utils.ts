// deno-lint-ignore-file no-explicit-any
import type { JSONSchema7 } from "@deco/deco";

export function dereferenceSchema(
  schema: JSONSchema7 | undefined,
  definitions: { [key: string]: JSONSchema7 },
  visited = new Set<string>(),
): JSONSchema7 | undefined {
  if (!schema) return undefined;

  // Handle array types by converting to anyOf
  if (schema.type && Array.isArray(schema.type)) {
    const result: JSONSchema7 = {
      ...schema,
      anyOf: schema.type.map((t: any) => ({ type: t })),
    };
    delete result.type;
    return result;
  }

  // Handle direct $ref
  if ("$ref" in schema && typeof schema.$ref === "string") {
    const refId = idFromDefinition(schema.$ref);
    if (visited.has(refId)) {
      // Prevent infinite recursion
      return { type: "object", properties: {} };
    }
    visited.add(refId);
    const referencedSchema = definitions[refId];
    
    // Save the original schema metadata (excluding $ref)
    const { $ref, ...originalMetadata } = schema;
    
    // Merge the original metadata with the dereferenced schema
    return {
      ...originalMetadata,
      ...dereferenceSchema(
        referencedSchema as JSONSchema7,
        definitions,
        visited,
      ),
    };
  }

  const result: JSONSchema7 = { ...schema };

  // Handle allOf
  if (result.allOf) {
    result.allOf = result.allOf.map((subSchema: any) =>
      dereferenceSchema(
        subSchema as JSONSchema7,
        definitions,
        visited,
      )
    ) as JSONSchema7[];
  }

  // Handle anyOf
  if (result.anyOf) {
    result.anyOf = result.anyOf.map((subSchema: any) =>
      dereferenceSchema(
        subSchema as JSONSchema7,
        definitions,
        visited,
      )
    ) as JSONSchema7[];
  }

  // Handle oneOf
  if (result.oneOf) {
    result.oneOf = result.oneOf.map((subSchema: any) =>
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

  if ("allOf" in result && !Array.isArray(result.allOf)) {
    delete result.allOf;
  }

  return result;
}

function idFromDefinition(definition: string): string {
  const [_, __, id] = definition.split("/");
  return id;
}
