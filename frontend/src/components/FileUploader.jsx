import { useState, useRef, useCallback, useEffect } from "react";
import "./FileUploader.css";

function formatFileSize(bytes) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

export default function FileUploader({
  onFileSelect,
  onFolderSelect,
  file,
  status,
  onUpload,
  onPause,
  onResume,
  onCancel,
  onPreview,
  isPreparingFolder = false,
}) {
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef(null);
  const folderInputRef = useRef(null);

  useEffect(() => {
    if (!folderInputRef.current) return;
    folderInputRef.current.setAttribute("webkitdirectory", "");
    folderInputRef.current.setAttribute("directory", "");
  }, []);

  const handleDragOver = useCallback((e) => {
    e.preventDefault();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setDragOver(false);
  }, []);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    setDragOver(false);
    const droppedFiles = Array.from(e.dataTransfer.files || []);
    if (!droppedFiles.length) return;

    const droppedItems = Array.from(e.dataTransfer.items || []);
    const hasDirectoryItem = droppedItems.some((item) => {
      const entry = item.webkitGetAsEntry?.();
      return Boolean(entry && entry.isDirectory);
    });

    if ((droppedFiles.length > 1 || hasDirectoryItem) && onFolderSelect) {
      onFolderSelect(droppedFiles);
      return;
    }

    onFileSelect(droppedFiles[0]);
  }, [onFileSelect, onFolderSelect]);

  const handleFileChange = (e) => {
    const selected = e.target.files[0];
    if (selected) onFileSelect(selected);
  };

  const handleFolderChange = (e) => {
    const selectedFiles = Array.from(e.target.files || []);
    if (selectedFiles.length && onFolderSelect) {
      onFolderSelect(selectedFiles);
    }
    e.target.value = "";
  };

  const isUploading = status === "uploading";
  const isPaused = status === "paused";
  const isCompleted = status === "completed";

  return (
    <div className="w-full space-y-6">
      {/* Drop Zone */}
      {!file && (
        <div
          id="drop-zone"
          className={`relative group ${dragOver ? 'ring-2 ring-primary ring-offset-2' : ''}`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={() => inputRef.current?.click()}
        >
          <div className="w-full aspect-[21/9] bg-surface-container-lowest rounded-xl flex flex-col items-center justify-center border-2 border-dashed border-outline-variant hover:border-on-tertiary-container/40 transition-all duration-500 cursor-pointer overflow-hidden shadow-[0px_12px_32px_rgba(23,28,31,0.04)]">
            <div className="absolute inset-0 bg-gradient-to-tr from-tertiary-container/5 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity"></div>
            <div className="relative z-10 flex flex-col items-center gap-4 text-center px-6">
              <div className="w-16 h-16 bg-surface-container-low rounded-2xl flex items-center justify-center text-on-tertiary-container mb-2">
                <span className="material-symbols-outlined text-4xl" style={{fontVariationSettings: "'FILL' 1"}}>cloud_upload</span>
              </div>
              <div>
                <h3 className="text-xl font-bold headline text-primary">Drag & Drop Medical Records</h3>
                <p className="text-on-surface-variant text-sm mt-1">Supports DICOM, PACS series, and standard clinical formats up to 50GB</p>
                {onFolderSelect && (
                  <p className="text-xs text-primary mt-2">
                    Or <button 
                         type="button" 
                         className="underline font-bold hover:text-tertiary-container" 
                         onClick={(e) => {
                           e.stopPropagation();
                           folderInputRef.current?.click();
                         }}>upload a folder</button>
                  </p>
                )}
              </div>
              <button className="mt-4 px-8 py-3 bg-primary text-on-primary rounded-lg font-bold text-sm hover:scale-[0.98] transition-transform shadow-lg pointer-events-none">
                Select Files to Secure
              </button>
            </div>
          </div>
          <input
            id="file-input"
            ref={inputRef}
            type="file"
            className="hidden"
            accept=".dcm,.dicom,.jpg,.jpeg,.png,.pdf,.zip"
            onChange={handleFileChange}
          />
          <input
            id="folder-input"
            ref={folderInputRef}
            type="file"
            className="hidden"
            multiple
            onChange={handleFolderChange}
          />
        </div>
      )}

      {/* Selected File Card */}
      {file && (
        <div className="bg-surface-container-lowest p-6 rounded-xl shadow-[0px_4px_24px_rgba(0,0,0,0.02)] flex flex-col gap-6">
          <div className="flex justify-between items-start">
            <div className="flex gap-4">
              <div className="w-12 h-12 rounded-lg bg-surface-container-high flex items-center justify-center text-primary">
                <span className="material-symbols-outlined text-2xl">description</span>
              </div>
              <div>
                <div className="text-base font-bold text-primary max-w-sm truncate" title={file.name}>{file.name}</div>
                <div className="text-xs uppercase tracking-widest text-on-surface-variant font-bold mt-1">Size: {formatFileSize(file.size)}</div>
              </div>
            </div>
            {status === "idle" && (
              <button
                className="text-error hover:bg-error/10 p-2 rounded-full transition-colors flex items-center justify-center"
                onClick={(e) => {
                  e.stopPropagation();
                  onFileSelect(null);
                }}
                title="Remove file"
              >
                <span className="material-symbols-outlined text-sm">close</span>
              </button>
            )}
          </div>

          {/* Action Buttons */}
          <div className="flex flex-wrap gap-4 pt-2 border-t border-surface-container-low">
            <button 
              id="preview-btn" 
              className="px-6 py-2 bg-surface-container-low text-primary rounded-lg font-bold text-sm hover:bg-surface-container-high transition-colors flex items-center gap-2" 
              onClick={onPreview}
            >
              <span className="material-symbols-outlined text-sm">visibility</span> Preview
            </button>

            {(status === "idle" || status === "error") ? (
              <button 
                id="upload-btn" 
                className="px-6 py-2 bg-primary text-on-primary rounded-lg font-bold text-sm hover:opacity-90 transition-opacity flex items-center gap-2 disabled:opacity-50" 
                onClick={onUpload} 
                disabled={isPreparingFolder}
              >
                <span className="material-symbols-outlined text-sm">cloud_upload</span>
                {isPreparingFolder ? "Preparing Folder..." : "Start Upload"}
              </button>
            ) : null}

            {isUploading && (
              <button id="pause-btn" className="px-6 py-2 bg-secondary-container text-on-secondary-container rounded-lg font-bold text-sm hover:opacity-90 transition-opacity flex items-center gap-2" onClick={onPause}>
                <span className="material-symbols-outlined text-sm">pause</span> Pause
              </button>
            )}

            {isPaused && (
              <button id="resume-btn" className="px-6 py-2 bg-tertiary-container text-on-tertiary-container rounded-lg font-bold text-sm hover:opacity-90 transition-opacity flex items-center gap-2" onClick={onResume}>
                <span className="material-symbols-outlined text-sm">play_arrow</span> Resume
              </button>
            )}

            {(isUploading || isPaused) && (
              <button id="cancel-btn" className="px-6 py-2 bg-error/10 text-error rounded-lg font-bold text-sm hover:bg-error/20 transition-opacity flex items-center gap-2 ml-auto" onClick={onCancel}>
                <span className="material-symbols-outlined text-sm">cancel</span> Cancel
              </button>
            )}

            {isCompleted && (
              <button className="px-6 py-2 bg-success text-white rounded-lg font-bold text-sm flex items-center gap-2" disabled style={{background: 'var(--success)'}}>
                <span className="material-symbols-outlined text-sm" style={{fontVariationSettings: "'FILL' 1"}}>check_circle</span> Upload Complete
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
