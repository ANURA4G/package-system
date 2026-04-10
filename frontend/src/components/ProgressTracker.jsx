import "./ProgressTracker.css";

export default function ProgressTracker({ progress, chunkStatuses, status }) {
  const completed = chunkStatuses.filter((c) => c.status === "completed").length;
  const errors = chunkStatuses.filter((c) => c.status === "error").length;

  return (
    <div className="bg-surface-container-lowest p-6 rounded-xl shadow-[0px_4px_24px_rgba(0,0,0,0.02)] flex flex-col gap-4">
      <div className="flex justify-between items-start">
        <div className="flex gap-4">
          <div className="w-10 h-10 rounded-lg bg-surface-container-high flex items-center justify-center text-primary">
            <span className="material-symbols-outlined text-xl">cloud_sync</span>
          </div>
          <div>
            <div className="text-sm font-bold truncate max-w-[240px]">Live Transfer Progress</div>
            <div className="text-[10px] uppercase tracking-widest text-on-surface-variant font-bold mt-1">Chunk Upload Status</div>
          </div>
        </div>
        <div className="text-right">
          <div className="text-sm font-bold text-on-tertiary-container text-xl">{progress}%</div>
          <div className="text-[10px] text-on-surface-variant font-bold capitalize text-primary">{status}</div>
        </div>
      </div>
      
      <div className="w-full h-2 bg-surface-container-low rounded-full overflow-hidden mt-2">
        <div 
          className={`h-full rounded-full transition-all duration-300 ${status === 'error' ? 'bg-error' : status === 'completed' ? 'bg-success' : 'bg-teal-500'}`} 
          style={{ width: `${progress}%` }}
        ></div>
      </div>
      
      <div className="flex justify-between items-center text-xs font-semibold text-on-surface-variant mt-1 border-t border-surface-container-low pt-4">
        <span>{completed} / {chunkStatuses.length} Chunks Transferred</span>
        {errors > 0 ? (
          <span className="text-error">{errors} Chunks Failed</span>
        ) : (
          <span className="text-teal-600">No Corruptions Detected</span>
        )}
      </div>

      {/* Chunk Map Mini */}
      {chunkStatuses.length > 0 && chunkStatuses.length <= 1000 && (
        <div className="mt-4 flex flex-wrap gap-1">
          {chunkStatuses.map((chunk) => {
            let color = "bg-surface-container-highest";
            if (chunk.status === "completed") color = "bg-teal-500";
            if (chunk.status === "uploading") color = "bg-tertiary-container animate-pulse";
            if (chunk.status === "error") color = "bg-error";
            return (
              <div
                key={chunk.partNumber}
                className={`w-2 h-2 rounded-sm ${color}`}
                title={`Part ${chunk.partNumber}: ${chunk.status}`}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
