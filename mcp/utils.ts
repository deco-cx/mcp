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
    const { $ref: _, ...originalMetadata } = schema;

    // Merge the original metadata with the dereferenced schema
    return {
      ...originalMetadata,
      ...dereferenceSchema(
        referencedSchema as JSONSchema7,
        definitions,
        visited,
      ),
      title: originalMetadata.title || referencedSchema.title,
      description: originalMetadata.description || referencedSchema.description,
    };
  }

  const result: JSONSchema7 = { ...schema };

  // Handle arrays with items (including tuple types)
  if (result.type === "array" && result.items) {
    if (Array.isArray(result.items)) {
      // Handle tuple types
      result.items = result.items.map((item) =>
        dereferenceSchema(item as JSONSchema7, definitions, visited)
      ).filter(Boolean) as JSONSchema7[];
    } else {
      // Handle single item schema
      result.items = dereferenceSchema(
        result.items as JSONSchema7,
        definitions,
        visited,
      ) as JSONSchema7;
    }
  }

  // Handle and merge allOf into the main schema
  if (result.allOf && Array.isArray(result.allOf) && result.allOf.length > 0) {
    // First dereference all schemas in allOf
    const dereferencedAllOf = result.allOf.map((subSchema: any) =>
      dereferenceSchema(
        subSchema as JSONSchema7,
        definitions,
        visited,
      ) as JSONSchema7
    );

    // Merge all properties from allOf schemas into the main schema
    for (const subSchema of dereferencedAllOf) {
      // Merge properties if they exist
      if (subSchema.properties) {
        result.properties = {
          ...(result.properties || {}),
          ...(subSchema.properties || {}),
        };
      }

      // Merge required fields if they exist
      if (subSchema.required && Array.isArray(subSchema.required)) {
        result.required = [
          ...(result.required || []),
          ...subSchema.required,
        ];
      }
    }

    // Remove the allOf array since we've merged its contents
    delete result.allOf;
  } else if (result.allOf && !Array.isArray(result.allOf)) {
    // Handle case where allOf is not an array
    delete result.allOf;
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

  return result;
}

function idFromDefinition(definition: string): string {
  // Handle complex definition patterns like:
  // "#/definitions/ZmlsZTovLy9hcHAvZGVjby9jbGllbnRzL3BsYXVzaWJsZS52Mi50cw==@FilterOperator"
  // Just remove the "#/definitions/" prefix and return the rest
  return definition.replace("#/definitions/", "");
}
