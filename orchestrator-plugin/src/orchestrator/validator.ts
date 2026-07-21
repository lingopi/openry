/**
 * Phase 3a: 高级验证引擎 — 10 种新验证类型。
 *
 * 独立于 validation.ts（Phase 2 硬验证），服务 validation_routing 字段。
 * Phase 2 的 validateStep() 保持不变，本模块提供 validateCondition()。
 */
import * as fs from "node:fs";
import { Ajv } from "ajv";

const ajv = new Ajv({ allErrors: true });

// ── Types ──────────────────────────────────────────────────────

export type ValidationResult = {
  passed: boolean;
  message: string;
  details: Record<string, unknown>;
};

export type ValidationRule = {
  type: string;
  key_a?: string;
  key_b?: string;
  key?: string;
  value?: unknown;
  values?: unknown[];
  mode?: string;
  threshold?: number;
  or_equal?: boolean;
  expected_type?: string;
  path_key?: string;
  min_bytes?: number;
  url?: string;
  expected_status?: number;
  method?: string;
  timeout_seconds?: number;
  schema?: Record<string, unknown>;
};

type ValidatorFn = (
  payload: Record<string, unknown>,
  rule: ValidationRule,
) => ValidationResult | Promise<ValidationResult>;

// ── Validators ─────────────────────────────────────────────────

function _valuesEqual(
  payload: Record<string, unknown>,
  rule: ValidationRule,
): ValidationResult {
  const a = payload[rule.key_a ?? ""];
  const b = payload[rule.key_b ?? ""];
  if (a === b) return { passed: true, message: "", details: {} };
  return {
    passed: false,
    message: `values not equal: ${rule.key_a}=${JSON.stringify(a)} != ${rule.key_b}=${JSON.stringify(b)}`,
    details: { key_a: rule.key_a, key_b: rule.key_b, val_a: a, val_b: b },
  };
}

function _valuesNotEqual(
  payload: Record<string, unknown>,
  rule: ValidationRule,
): ValidationResult {
  const a = payload[rule.key_a ?? ""];
  const b = payload[rule.key_b ?? ""];
  if (a !== b) return { passed: true, message: "", details: {} };
  return {
    passed: false,
    message: `values unexpectedly equal: ${rule.key_a}=${JSON.stringify(a)}`,
    details: { key_a: rule.key_a, key_b: rule.key_b, val_a: a, val_b: b },
  };
}

function _valueEquals(
  payload: Record<string, unknown>,
  rule: ValidationRule,
): ValidationResult {
  const actual = payload[rule.key ?? ""];
  if (actual === rule.value) return { passed: true, message: "", details: {} };
  return {
    passed: false,
    message: `value mismatch: ${rule.key}=${JSON.stringify(actual)}, expected ${JSON.stringify(rule.value)}`,
    details: { key: rule.key, actual, expected: rule.value },
  };
}

function _valueInSet(
  payload: Record<string, unknown>,
  rule: ValidationRule,
): ValidationResult {
  const actual = payload[rule.key ?? ""];
  const values = (rule.values ?? []) as unknown[];
  const mode = rule.mode ?? "allow";

  const inSet = values.includes(actual);
  if (mode === "allow") {
    if (inSet) return { passed: true, message: "", details: {} };
    return {
      passed: false,
      message: `value not in allowed set: ${rule.key}=${JSON.stringify(actual)}`,
      details: { key: rule.key, actual, values, mode },
    };
  }
  // mode === "deny"
  if (!inSet) return { passed: true, message: "", details: {} };
  return {
    passed: false,
    message: `value in denied set: ${rule.key}=${JSON.stringify(actual)}`,
    details: { key: rule.key, actual, values, mode },
  };
}

function _valueGreaterThan(
  payload: Record<string, unknown>,
  rule: ValidationRule,
): ValidationResult {
  const actual = payload[rule.key ?? ""];
  const threshold = rule.threshold ?? 0;
  const orEqual = rule.or_equal ?? false;

  if (actual === undefined || actual === null) {
    return { passed: false, message: `key not found: ${rule.key}`, details: { key: rule.key } };
  }
  const n = Number(actual);
  if (isNaN(n)) {
    return { passed: false, message: `value is not numeric: ${rule.key}=${actual}`, details: { key: rule.key, actual } };
  }
  const ok = orEqual ? n >= threshold : n > threshold;
  if (ok) return { passed: true, message: "", details: {} };
  const op = orEqual ? ">=" : ">";
  return {
    passed: false,
    message: `value not ${op} threshold: ${rule.key}=${n}, threshold=${threshold}`,
    details: { key: rule.key, actual: n, threshold, or_equal: orEqual },
  };
}

function _valueLessThan(
  payload: Record<string, unknown>,
  rule: ValidationRule,
): ValidationResult {
  const actual = payload[rule.key ?? ""];
  const threshold = rule.threshold ?? 0;
  const orEqual = rule.or_equal ?? false;

  if (actual === undefined || actual === null) {
    return { passed: false, message: `key not found: ${rule.key}`, details: { key: rule.key } };
  }
  const n = Number(actual);
  if (isNaN(n)) {
    return { passed: false, message: `value is not numeric: ${rule.key}=${actual}`, details: { key: rule.key, actual } };
  }
  const ok = orEqual ? n <= threshold : n < threshold;
  if (ok) return { passed: true, message: "", details: {} };
  const op = orEqual ? "<=" : "<";
  return {
    passed: false,
    message: `value not ${op} threshold: ${rule.key}=${n}, threshold=${threshold}`,
    details: { key: rule.key, actual: n, threshold, or_equal: orEqual },
  };
}

function _payloadType(
  payload: Record<string, unknown>,
  rule: ValidationRule,
): ValidationResult {
  const actual = payload[rule.key ?? ""];
  const expected = rule.expected_type ?? "str";

  // Map type names to typeof / checks
  const typeMap: Record<string, string> = {
    int: "number",
    float: "number",
    str: "string",
    bool: "boolean",
    list: "object", // Array.isArray
    dict: "object", // !Array.isArray && not null
    null: "object", // === null
  };

  let ok = false;
  switch (expected) {
    case "int":
      ok = typeof actual === "number" && Number.isInteger(actual);
      break;
    case "float":
      ok = typeof actual === "number";
      break;
    case "str":
      ok = typeof actual === "string";
      break;
    case "bool":
      ok = typeof actual === "boolean";
      break;
    case "list":
      ok = Array.isArray(actual);
      break;
    case "dict":
      ok = typeof actual === "object" && actual !== null && !Array.isArray(actual);
      break;
    case "null":
      ok = actual === null;
      break;
    default:
      return { passed: false, message: `unknown expected_type: ${expected}`, details: { key: rule.key, expected_type: expected } };
  }

  if (ok) return { passed: true, message: "", details: {} };
  return {
    passed: false,
    message: `type mismatch: ${rule.key}=${JSON.stringify(actual)} (${typeof actual}), expected ${expected}`,
    details: { key: rule.key, actual, actual_type: typeof actual, expected_type: expected },
  };
}

function _fileSizeGreaterThan(
  payload: Record<string, unknown>,
  rule: ValidationRule,
): ValidationResult {
  const filePath = String(payload[rule.path_key ?? ""] ?? "");
  const minBytes = rule.min_bytes ?? 0;

  if (!filePath) {
    return { passed: false, message: `file path key not found: ${rule.path_key}`, details: { path_key: rule.path_key } };
  }
  if (!fs.existsSync(filePath)) {
    return { passed: false, message: `file not found: ${filePath}`, details: { path_key: rule.path_key, file_path: filePath } };
  }
  try {
    const size = fs.statSync(filePath).size;
    if (size > minBytes) return { passed: true, message: "", details: {} };
    return {
      passed: false,
      message: `file size ${size} <= ${minBytes}: ${filePath}`,
      details: { path_key: rule.path_key, file_path: filePath, size, min_bytes: minBytes },
    };
  } catch (err) {
    return {
      passed: false,
      message: `cannot stat file: ${filePath}: ${String(err)}`,
      details: { path_key: rule.path_key, file_path: filePath },
    };
  }
}

async function _httpStatus(
  payload: Record<string, unknown>,
  rule: ValidationRule,
): Promise<ValidationResult> {
  const url = rule.url ?? "";
  const expected = rule.expected_status ?? 200;
  const method = rule.method ?? "GET";
  const timeout = rule.timeout_seconds ?? 10;

  try {
    const resp = await fetch(url, { method, signal: AbortSignal.timeout(timeout * 1000) });
    if (resp.status === expected) return { passed: true, message: "", details: {} };
    return {
      passed: false,
      message: `HTTP status mismatch: ${url} → ${resp.status}, expected ${expected}`,
      details: { url, method, actual_status: resp.status, expected_status: expected },
    };
  } catch (err) {
    return {
      passed: false,
      message: `HTTP request failed: ${url}: ${String(err)}`,
      details: { url, method },
    };
  }
}

function _jsonSchema(
  payload: Record<string, unknown>,
  rule: ValidationRule,
): ValidationResult {
  const key = rule.key ?? "";
  const schema = rule.schema;
  if (!schema) {
    return { passed: false, message: `no schema provided for ${key}`, details: { key } };
  }
  const instance = payload[key];
  if (instance === undefined || instance === null) {
    return { passed: false, message: `JSON Schema validation failed for ${key}: value is null/undefined`, details: { key } };
  }
  try {
    const validate = ajv.compile(schema);
    const ok = validate(instance);
    if (ok) return { passed: true, message: "", details: {} };
    return {
      passed: false,
      message: `JSON Schema validation failed for ${key}: ${ajv.errorsText(validate.errors)}`,
      details: { key, errors: validate.errors },
    };
  } catch (err) {
    return {
      passed: false,
      message: `Invalid JSON Schema for ${key}: ${String(err)}`,
      details: { key },
    };
  }
}

// ── Registry ───────────────────────────────────────────────────

export const VALIDATOR_REGISTRY: Record<string, ValidatorFn> = {
  payload_values_equal: _valuesEqual,
  payload_values_not_equal: _valuesNotEqual,
  payload_value_equals: _valueEquals,
  payload_value_in_set: _valueInSet,
  payload_value_greater_than: _valueGreaterThan,
  payload_value_less_than: _valueLessThan,
  payload_type: _payloadType,
  file_size_greater_than: _fileSizeGreaterThan,
  http_status: _httpStatus,
  json_schema: _jsonSchema,
};

// ── Main entry ─────────────────────────────────────────────────

export async function validateCondition(
  payload: Record<string, unknown>,
  rule: ValidationRule,
): Promise<ValidationResult> {
  const handler = VALIDATOR_REGISTRY[rule.type];
  if (!handler) {
    return {
      passed: false,
      message: `unknown validation type: ${rule.type}`,
      details: { rule_type: rule.type },
    };
  }
  try {
    return await handler(payload, rule);
  } catch (err) {
    return {
      passed: false,
      message: `validation error (${rule.type}): ${String(err)}`,
      details: { rule_type: rule.type, exception: String(err) },
    };
  }
}
