/** Strict incident-artifact validators and composition helpers. */
import { redactSensitive } from "./redact.ts";
import type { ArtifactObject, ArtifactOutcome, ArtifactType } from "./types.ts";

export const ARTIFACT_TYPES = ["triage", "comms", "pir"] as const;
export type { ArtifactType };

export class ArtifactValidationError extends Error {
  constructor(message: string, public readonly path: string = "$") {
    super(`${path}: ${message}`);
    this.name = "ArtifactValidationError";
  }
}

const SEVERITIES = new Set(["SEV1", "SEV2", "SEV3", "SEV4", "UNKNOWN"]);
const COMMS_STATUS = new Set(["investigating", "identified", "monitoring", "resolved", "UNKNOWN"]);
const PIR_STATUS = new Set(["draft", "final"]);
const ACTION_STATUS = new Set(["open", "done"]);
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ArtifactValidationError("must be an object", path);
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length) throw new ArtifactValidationError(`unknown key(s): ${unknown.join(", ")}`, path);
}
function stringValue(value: unknown, path: string): string {
  if (typeof value !== "string") throw new ArtifactValidationError("must be a string", path);
  return value;
}
function stringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new ArtifactValidationError("must be a string array", path);
  return value as string[];
}
function bool(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new ArtifactValidationError("must be boolean", path);
  return value;
}
function number(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new ArtifactValidationError("must be a finite number", path);
  return value;
}
function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new ArtifactValidationError("must be an array", path);
  return value;
}
function enumValue(value: unknown, allowed: Set<string>, path: string): string {
  const text = stringValue(value, path);
  if (!allowed.has(text)) throw new ArtifactValidationError(`must be one of ${[...allowed].join(", ")}`, path);
  return text;
}
function timestamp(value: unknown, path: string): string {
  const text = stringValue(value, path);
  if (text !== "UNKNOWN" && !RFC3339.test(text)) throw new ArtifactValidationError("must be RFC3339 or UNKNOWN", path);
  return text;
}

const SHARED = ["schemaVersion", "artifactType", "generatedAt", "missingInformation", "redactions"] as const;
function validateShared(value: Record<string, unknown>, expected: ArtifactType): void {
  stringValue(value.schemaVersion, "$.schemaVersion");
  if (value.schemaVersion !== "1") throw new ArtifactValidationError('must equal "1"', "$.schemaVersion");
  if (value.artifactType !== expected) throw new ArtifactValidationError(`must equal "${expected}"`, "$.artifactType");
  timestamp(value.generatedAt, "$.generatedAt");
  stringArray(value.missingInformation, "$.missingInformation");
  const redactions = number(value.redactions, "$.redactions");
  if (!Number.isInteger(redactions) || redactions < 0) throw new ArtifactValidationError("must be an integer >= 0", "$.redactions");
}

function evidenceRef(value: unknown, path: string, supplied?: ReadonlySet<string>): string {
  const id = stringValue(value, path);
  if (supplied && !supplied.has(id)) throw new ArtifactValidationError(`does not refer to supplied evidence: ${id}`, path);
  return id;
}
function evidenceRefs(value: unknown, path: string, supplied?: ReadonlySet<string>): string[] {
  const refs = stringArray(value, path);
  refs.forEach((id, i) => evidenceRef(id, `${path}[${i}]`, supplied));
  return refs;
}

export function validateTriage(value: unknown, suppliedEvidenceIds?: readonly string[]): ArtifactObject {
  const v = object(value, "$");
  keys(v, [...SHARED, "incidentSummary", "severity", "observations", "hypotheses", "immediateActions", "runbookAlignment"], "$");
  validateShared(v, "triage");
  stringValue(v.incidentSummary, "$.incidentSummary");
  enumValue(v.severity, SEVERITIES, "$.severity");
  const supplied = suppliedEvidenceIds ? new Set(suppliedEvidenceIds) : undefined;
  for (const [i, raw] of array(v.observations, "$.observations").entries()) {
    const item = object(raw, `$.observations[${i}]`);
    keys(item, ["id", "evidenceId", "fact"], `$.observations[${i}]`);
    stringValue(item.id, `$.observations[${i}].id`);
    evidenceRef(item.evidenceId, `$.observations[${i}].evidenceId`, supplied);
    stringValue(item.fact, `$.observations[${i}].fact`);
  }
  for (const [i, raw] of array(v.hypotheses, "$.hypotheses").entries()) {
    const item = object(raw, `$.hypotheses[${i}]`);
    keys(item, ["summary", "evidenceIds", "confidence"], `$.hypotheses[${i}]`);
    stringValue(item.summary, `$.hypotheses[${i}].summary`);
    const refs = evidenceRefs(item.evidenceIds, `$.hypotheses[${i}].evidenceIds`, supplied);
    const confidence = number(item.confidence, `$.hypotheses[${i}].confidence`);
    if (confidence < 0 || confidence > 1) throw new ArtifactValidationError("must be in range 0..1", `$.hypotheses[${i}].confidence`);
    if (refs.length === 0 && confidence !== 0) throw new ArtifactValidationError("unsupported hypotheses must have confidence 0", `$.hypotheses[${i}].confidence`);
  }
  for (const [i, raw] of array(v.immediateActions, "$.immediateActions").entries()) {
    const item = object(raw, `$.immediateActions[${i}]`);
    keys(item, ["action", "mutation", "approvalRequired", "runbook"], `$.immediateActions[${i}]`);
    stringValue(item.action, `$.immediateActions[${i}].action`);
    const mutation = bool(item.mutation, `$.immediateActions[${i}].mutation`);
    const approval = bool(item.approvalRequired, `$.immediateActions[${i}].approvalRequired`);
    if (mutation && !approval) throw new ArtifactValidationError("mutation requires approvalRequired=true", `$.immediateActions[${i}]`);
    stringValue(item.runbook, `$.immediateActions[${i}].runbook`);
  }
  stringValue(v.runbookAlignment, "$.runbookAlignment");
  return structuredClone(v) as ArtifactObject;
}

export function validateComms(value: unknown): ArtifactObject {
  const v = object(value, "$");
  keys(v, [...SHARED, "status", "severity", "slackUpdate", "stakeholderBrief", "knownImpact", "nextUpdateAt"], "$");
  validateShared(v, "comms");
  enumValue(v.status, COMMS_STATUS, "$.status");
  enumValue(v.severity, SEVERITIES, "$.severity");
  stringValue(v.slackUpdate, "$.slackUpdate");
  stringValue(v.stakeholderBrief, "$.stakeholderBrief");
  stringValue(v.knownImpact, "$.knownImpact");
  timestamp(v.nextUpdateAt, "$.nextUpdateAt");
  return structuredClone(v) as ArtifactObject;
}

export function validatePir(value: unknown, suppliedEvidenceIds?: readonly string[]): ArtifactObject {
  const v = object(value, "$");
  keys(v, [...SHARED, "title", "status", "timeline", "customerImpact", "rootCause", "contributingFactors", "preventionActions"], "$");
  validateShared(v, "pir");
  stringValue(v.title, "$.title");
  const status = enumValue(v.status, PIR_STATUS, "$.status");
  const supplied = suppliedEvidenceIds ? new Set(suppliedEvidenceIds) : undefined;
  let unknownTimeline = false;
  for (const [i, raw] of array(v.timeline, "$.timeline").entries()) {
    const item = object(raw, `$.timeline[${i}]`);
    keys(item, ["timestamp", "event", "evidenceIds"], `$.timeline[${i}]`);
    timestamp(item.timestamp, `$.timeline[${i}].timestamp`);
    stringValue(item.event, `$.timeline[${i}].event`);
    evidenceRefs(item.evidenceIds, `$.timeline[${i}].evidenceIds`, supplied);
    unknownTimeline ||= item.timestamp === "UNKNOWN" || item.event === "UNKNOWN";
  }
  const impact = object(v.customerImpact, "$.customerImpact");
  keys(impact, ["summary", "quantified"], "$.customerImpact");
  stringValue(impact.summary, "$.customerImpact.summary");
  stringValue(impact.quantified, "$.customerImpact.quantified");
  const rootCause = stringValue(v.rootCause, "$.rootCause");
  if (status === "final" && (rootCause === "UNKNOWN" || impact.quantified === "UNKNOWN" || unknownTimeline)) {
    throw new ArtifactValidationError("status must remain draft while required facts are UNKNOWN", "$.status");
  }
  stringArray(v.contributingFactors, "$.contributingFactors");
  for (const [i, raw] of array(v.preventionActions, "$.preventionActions").entries()) {
    const item = object(raw, `$.preventionActions[${i}]`);
    keys(item, ["action", "owner", "dueDate", "status"], `$.preventionActions[${i}]`);
    stringValue(item.action, `$.preventionActions[${i}].action`);
    stringValue(item.owner, `$.preventionActions[${i}].owner`);
    timestamp(item.dueDate, `$.preventionActions[${i}].dueDate`);
    enumValue(item.status, ACTION_STATUS, `$.preventionActions[${i}].status`);
  }
  return structuredClone(v) as ArtifactObject;
}

export function validateArtifact(value: unknown, expectedType?: ArtifactType, suppliedEvidenceIds?: readonly string[]): ArtifactObject {
  const type = expectedType ?? (object(value, "$").artifactType as ArtifactType);
  if (type === "triage") return validateTriage(value, suppliedEvidenceIds);
  if (type === "comms") return validateComms(value);
  if (type === "pir") return validatePir(value, suppliedEvidenceIds);
  throw new ArtifactValidationError(`unsupported artifact type: ${String(type)}`, "$.artifactType");
}

/** Redact before JSON parsing; normalize category-qualified markers to the public marker. */
export function redactArtifactText(text: string): { text: string; redactions: number } {
  const redacted = redactSensitive(text);
  let normalized = redacted.text.replace(/\[REDACTED(?::[^\]]+)?\]/g, "[REDACTED]");
  // redactSensitive preserves the original assignment token; when that token
  // was a JSON string, restore JSON validity without exposing the value.
  normalized = normalized.replace(/(:\s*)\[REDACTED\](?=\s*[,}])/g, '$1"[REDACTED]"');
  // A credential assignment embedded in a JSON string can consume its
  // closing quote because the shared scanner intentionally treats quotes as
  // part of an unquoted assignment token. Restore that quote in-place.
  normalized = normalized.replace(/(=)\[REDACTED\](?=\s*[,}])/g, '$1[REDACTED]"');
  return { text: normalized, redactions: redacted.count };
}

export interface ParseArtifactOptions { expectedType?: ArtifactType; evidenceIds?: readonly string[]; stopReason?: string | null; }
export function parseArtifactOutput(text: string, options: ParseArtifactOptions = {}): ArtifactOutcome {
  const redacted = redactArtifactText(text);
  if (options.stopReason === "length") return { status: "failed", error: "child output stopped with length; artifact JSON was truncated" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(redacted.text);
  } catch (error) {
    return { status: "failed", error: `artifact JSON parse failed: ${(error as Error).message}` };
  }
  try {
    const artifact = validateArtifact(parsed, options.expectedType, options.evidenceIds);
    if (artifact.redactions !== redacted.redactions) {
      throw new ArtifactValidationError(`must equal ${redacted.redactions}, the number of redactions applied`, "$.redactions");
    }
    return { status: "done", artifact };
  } catch (error) {
    return { status: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}

export async function composeArtifacts(
  requested: readonly ArtifactType[],
  run: (type: ArtifactType) => Promise<ArtifactOutcome | string>,
  options: Omit<ParseArtifactOptions, "expectedType"> = {},
): Promise<Partial<Record<ArtifactType, ArtifactOutcome>>> {
  const unique = [...new Set(requested)];
  const values = await Promise.all(unique.map(async (type) => {
    try {
      const result = await run(type);
      const outcome = typeof result === "string" ? parseArtifactOutput(result, { ...options, expectedType: type }) : result;
      return [type, outcome] as const;
    } catch (error) {
      return [type, { status: "failed", error: redactArtifactText(String(error)).text } satisfies ArtifactOutcome] as const;
    }
  }));
  return Object.fromEntries(values) as Partial<Record<ArtifactType, ArtifactOutcome>>;
}
