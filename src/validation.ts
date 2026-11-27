import {
  getTaskRequestValidationIssues,
  type IndeRunError,
  type TaskRequest
} from "@independo/inderun-contracts";

/**
 * Refuses a `TaskRequest` that the contract rejects, before it crosses into native code.
 *
 * The native decoders are lossy: a typed decode silently drops a field the platform types do not
 * model (an unknown speech control, a playback control on an artifact call), so the check has to
 * run on the raw JSON the caller handed over. The rules are the core's —
 * `getTaskRequestValidationIssues` — and this file only reports them in the shape the core SDKs
 * use: an `Internal` error with the offending fields in `details.validationIssues`.
 *
 * @throws {IndeRunError} When the request has any validation issue.
 */
export function assertValidTaskRequest(request: unknown): asserts request is TaskRequest {
  const validationIssues = getTaskRequestValidationIssues(request);
  if (validationIssues.length === 0) {
    return;
  }
  const error: IndeRunError = {
    schemaVersion: "1.1",
    errorClass: "Internal",
    message: `Validation failed for TaskRequest: ${validationIssues
      .map((issue) => `${issue.path} - ${issue.message}`)
      .join("; ")}`,
    details: { validationIssues }
  };
  throw error;
}
