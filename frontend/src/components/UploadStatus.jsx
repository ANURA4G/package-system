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

export default function UploadStatus({ status, error, networkType = "Medium", displayChunkMB = 5 }) {
  if (status === "idle") return null;

  const config = STATUS_CONFIG[status];
  if (!config) return null;

  const networkLabel = networkType === "Slow"
    ? "Slow 🐢"
    : networkType === "Medium"
      ? "Medium ⚡"
      : "Fast ⚡";

  return (
    <div className={`p-4 rounded-xl flex items-start gap-4 border border-outline-variant/30 ${config.bg}`}>
      <span className={`material-symbols-outlined mt-0.5 ${config.color}`} style={{fontVariationSettings: "'FILL' 1"}}>{config.icon}</span>
      <div>
        <h4 className={`font-bold text-sm ${config.color}`}>{config.title}</h4>
        <p className="text-xs text-on-surface-variant font-medium mt-1">
          {status === "error" && error ? error : config.description}
        </p>
        <div className="mt-2 text-[11px] font-semibold text-on-surface-variant space-y-0.5">
          <p>Adaptive Mode: ON</p>
          <p>Network: {networkLabel}</p>
          <p>Chunk Size: {displayChunkMB} MB</p>
        </div>
      </div>
    </div>
  );
}
