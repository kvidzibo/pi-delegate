import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import { readFileSync } from "node:fs";

export type ResponseSchema = Record<string, unknown> | boolean;
export const RESPONSE_FORMAT_ENV = "PI_DELEGATE_RESPONSE_FORMAT";
export const RESPONSE_FORMAT_READY = "delegate-response-format-ready";
export const DEFAULT_REPAIR_ATTEMPTS = 2;

/** A new compiler per schema avoids cross-role $id collisions and retained schema caches. */
export function compileResponseSchema(schema: unknown): ValidateFunction {
	if (typeof schema !== "boolean" && (!schema || typeof schema !== "object" || Array.isArray(schema))) {
		throw new Error("Response schema must be a JSON Schema object or boolean (draft-07).");
	}
	const ajv = new Ajv({ strict: true, allErrors: true, coerceTypes: false, useDefaults: false, removeAdditional: false });
	addFormats(ajv);
	const validate = ajv.compile(schema as ResponseSchema);
	if (validate.$async) throw new Error("Async response schemas are not supported.");
	return validate;
}

export function assertRepairAttempts(value: unknown): asserts value is number {
	if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 2) {
		throw new Error("responseRepairAttempts must be an integer from 0 to 2.");
	}
}

export interface ResponseFormat {
	schema: ResponseSchema;
	repairAttempts: number;
	maxOutputBytes: number;
}

export function readResponseFormat(path: string): ResponseFormat {
	const value = JSON.parse(readFileSync(path, "utf8"));
	compileResponseSchema(value?.schema);
	assertRepairAttempts(value?.repairAttempts);
	if (!Number.isSafeInteger(value?.maxOutputBytes) || value.maxOutputBytes < 1) throw new Error("Invalid response format output limit.");
	return value;
}

/** Validate the exact finalized text, before any output truncation. Never mutate data. */
export function responseFormatError(text: string, validate: ValidateFunction, maxBytes: number): string | undefined {
	let data: unknown;
	try { data = JSON.parse(text); }
	catch { return "Return exactly one JSON value, without Markdown fences or surrounding prose."; }
	try {
		if (!validate(data)) {
			return (validate.errors ?? []).slice(0, 12).map(error =>
				`${error.instancePath || "/"}: ${error.message} ${JSON.stringify(error.params)}`,
			).join("\n").slice(0, 3000) || "Response does not match the JSON Schema.";
		}
	} catch { return "Response schema validation could not complete."; }
	if (Buffer.byteLength(text, "utf8") > maxBytes) return `Response exceeds ${maxBytes} UTF-8 bytes. Shorten it while preserving the schema.`;
	return undefined;
}
