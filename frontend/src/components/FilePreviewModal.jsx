import { useState, useEffect, useCallback } from "react";
import { getFileType, getFileTypeLabel } from "../utils/fileTypeUtils";
import ImageViewer from "./viewers/ImageViewer";
import PdfViewer from "./viewers/PdfViewer";
import DicomViewer from "./viewers/DicomViewer";
import ExcelViewer from "./viewers/ExcelViewer";
import GenericViewer from "./viewers/GenericViewer";
import "./FilePreviewModal.css";

/**
 * Modal that renders a local browser preview using an object URL
 * based on file extension.
 */
export default function FilePreviewModal({ file, onClose }) {
  const [previewUrl, setPreviewUrl] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fileType = getFileType(file.name);
  const fileTypeLabel = getFileTypeLabel(fileType);
  const isDicom = fileType === "dicom";

  // Generate a local object URL for the uploaded file
  useEffect(() => {
    let url;
    try {
      url = URL.createObjectURL(file);
      setPreviewUrl(url);
      setLoading(false);
    } catch (err) {
      setError("Failed to preview local file");
      setLoading(false);
    }

    return () => {
      if (url) {
        URL.revokeObjectURL(url);
      }
    };
  }, [file]);

  // Close on Escape key
  useEffect(() => {
    const handleKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  // Render the correct viewer
  const renderViewer = useCallback(() => {
    if (!previewUrl) return null;

    switch (fileType) {
      case "image":
        return <ImageViewer url={previewUrl} fileName={file.name} />;
      case "pdf":
        return <PdfViewer url={previewUrl} />;
      case "dicom":
        return <DicomViewer file={file} url={previewUrl} />;
      case "excel":
        return <ExcelViewer url={previewUrl} fileName={file.name} />;
      default:
        return <GenericViewer url={previewUrl} fileName={file.name} />;
    }
  }, [previewUrl, fileType, file]);

  return (
    <div className="preview-overlay" onClick={onClose}>
      <div className="preview-modal" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="preview-header">
          <div className="preview-title">
            <span className="preview-type-badge">{fileTypeLabel}</span>
            <h2>{file.name}</h2>
          </div>
          <button className="preview-close-btn" onClick={onClose} title="Close preview">
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="preview-body">
          <div className="preview-scope-note">
            Local preview only. This view inspects the file in your browser before upload.
            {isDicom ? " Cloud DICOM slice/thumbnail preview from S3 is not enabled yet." : ""}
          </div>

          {loading && (
            <div className="preview-loading">
              <div className="spinner" />
              <p>Loading preview…</p>
            </div>
          )}

          {error && (
            <div className="preview-error">
              <p>⚠️ {error}</p>
            </div>
          )}

          {!loading && !error && renderViewer()}
        </div>

        {/* Footer — download link */}
        {previewUrl && (
          <div className="preview-footer">
            <a
              href={previewUrl}
              download={file.name}
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-secondary btn-sm"
            >
              ⬇ Download
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
