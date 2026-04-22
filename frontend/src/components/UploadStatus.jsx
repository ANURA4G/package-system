import "./UploadStatus.css";

const STATUS_CONFIG = {
  uploading: {
    icon: "sync",
    color: "text-tertiary-container",
    bg: "bg-tertiary-fixed-dim/20",
    title: "Uploading Securely",
    description: "Your file is being encrypted and transmitted to the cloud.",
  },
  paused: {
    icon: "pause_circle",
    color: "text-secondary",
    bg: "bg-surface-container-high",
    title: "Upload Paused",
    description: "Session preserved. You can resume the upload at any time.",
  },
  completed: {
    icon: "verified",
    color: "text-teal-600",
    bg: "bg-teal-400/20",
    title: "Upload Verified",
    description: "Your medical file has been securely ingested into the vault.",
  },
  error: {
    icon: "error",
    color: "text-error",
    bg: "bg-error-container",
    title: "Transmission Error",
    description: null,
  },
};

export default function UploadStatus({
  status,
  error,
  errorMeta,
  onRetry,
  onAbort,
  networkType = "Medium",
  displayChunkMB = 5,
  etaDisplay = "Calculating...",
  targetBucketName = "MediVault Bucket",
}) {
  if (status === "idle") return null;

  const config = STATUS_CONFIG[status];
  if (!config) return null;

  const networkLabel = networkType === "Slow"
    ? "Slow 🐢"
    : networkType === "Medium"
      ? "Medium ⚡"
      : "Fast ⚡";

  const isError = status === "error";
  const retryAllowedKinds = new Set(["network", "generic", "chunk_retry_exhausted"]);
  const reasonLabel = isError
    ? errorMeta?.kind === "auth"
      ? "Authentication issue"
      : errorMeta?.kind === "validation"
        ? "Validation issue"
        : errorMeta?.kind === "bad_request"
          ? "Request rejected"
          : errorMeta?.kind === "network"
        ? "Network issue"
            : errorMeta?.kind === "file_type"
            ? "File type issue"
              : errorMeta?.kind === "size_limit"
        ? "Size limit exceeded"
                : errorMeta?.kind === "chunk_retry_exhausted"
              ? "Partial upload failure"
                : errorMeta?.status === 413
                  ? "Size limit exceeded"
                  : "Upload failure"
    : null;

  const showPartialFailureHelp = isError && errorMeta?.kind === "chunk_retry_exhausted";
  const guidanceMessage = isError
    ? errorMeta?.kind === "auth"
      ? "Sign in again, then retry upload from this screen."
      : errorMeta?.kind === "size_limit"
        ? "Pick a smaller file or increase the bucket/backend size limit, then retry."
        : errorMeta?.kind === "file_type"
          ? "Use an allowed file type: DICOM, JPEG, PNG, PDF, or ZIP."
          : null
    : null;
  const canRetry = typeof onRetry === "function" && retryAllowedKinds.has(errorMeta?.kind || "generic");
  const canAbort = typeof onAbort === "function";

  return (
    <div className={`p-4 rounded-xl flex items-start gap-4 border border-outline-variant/30 ${config.bg}`}>
      <span className={`material-symbols-outlined mt-0.5 ${config.color}`} style={{fontVariationSettings: "'FILL' 1"}}>{config.icon}</span>
      <div>
        <h4 className={`font-bold text-sm ${config.color}`}>{config.title}</h4>
        <p className="text-xs text-on-surface-variant font-medium mt-1">
          {status === "error" && error ? error : config.description}
        </p>
        {isError && reasonLabel ? (
          <p className="mt-1 text-[11px] font-bold uppercase tracking-wide text-error">Reason: {reasonLabel}</p>
        ) : null}

        {showPartialFailureHelp ? (
          <p className="mt-1 text-[11px] font-semibold text-on-surface-variant">
            Some chunks were uploaded before failure. Use Retry to resume safely, or Abort to cancel the session.
          </p>
        ) : null}

        {guidanceMessage ? (
          <p className="mt-1 text-[11px] font-semibold text-on-surface-variant">
            {guidanceMessage}
          </p>
        ) : null}

        {isError && (canRetry || canAbort) ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {canRetry ? (
              <button
                type="button"
                onClick={onRetry}
                className="rounded-md bg-primary px-3 py-1.5 text-xs font-bold text-on-primary"
              >
                Retry Upload
              </button>
            ) : null}
            {canAbort ? (
              <button
                type="button"
                onClick={onAbort}
                className="rounded-md bg-error-container px-3 py-1.5 text-xs font-bold text-error"
              >
                Abort Session
              </button>
            ) : null}
          </div>
        ) : null}

        <div className="mt-2 text-[11px] font-semibold text-on-surface-variant space-y-0.5">
          <p>Uploading to: {targetBucketName}</p>
          <p>Adaptive Mode: ON</p>
          <p>Network: {networkLabel}</p>
          <p>Chunk Size: {displayChunkMB} MB</p>
          <p>Estimated Time Remaining: {etaDisplay}</p>
        </div>
      </div>
    </div>
  );
}
