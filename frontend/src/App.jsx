import { useState, useEffect, useCallback } from "react";
import { useChunkedUpload } from "./hooks/useChunkedUpload";
import FileUploader from "./components/FileUploader";
import ProgressTracker from "./components/ProgressTracker";
import UploadStatus from "./components/UploadStatus";
import FilePreviewModal from "./components/FilePreviewModal";
import UploadHistory from "./components/UploadHistory";
import ToastStack from "./components/ToastStack";
import Login from "./components/Login";
import { getCurrentUser } from "./api/authApi";
import "./App.css";

const TOAST_TTL_MS = 7000;

function App() {
  const [token, setToken] = useState(localStorage.getItem("token"));
  const [file, setFile] = useState(null);
  const [showPreview, setShowPreview] = useState(false);
  const [toasts, setToasts] = useState([]);
  const { status, progress, chunkStatuses, error, errorMeta, prepareUpload, upload, pause, resume, cancel } =
    useChunkedUpload();

  const pushToast = useCallback((type, title, message) => {
    const id = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
    setToasts((prev) => [...prev, { id, type, title, message }]);

    window.setTimeout(() => {
      setToasts((prev) => prev.filter((toast) => toast.id !== id));
    }, TOAST_TTL_MS);
  }, []);

  const dismissToast = useCallback((id) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  }, []);

  const handleLogout = useCallback(() => {
    localStorage.removeItem("token");
    setToken(null);
    setFile(null);
    setShowPreview(false);
  }, []);

  const handleFileSelect = useCallback(async (selectedFile) => {
    await cancel();
    setFile(selectedFile);
    setShowPreview(false);

    if (!selectedFile) return;

    try {
      await prepareUpload(selectedFile);
    } catch (err) {
      pushToast(
        "error",
        "Resume Check Failed",
        "Could not verify previous upload session. Please try selecting the file again."
      );
    }
  }, [cancel, prepareUpload, pushToast]);

  const handleUpload = useCallback(() => {
    if (file) upload(file);
  }, [file, upload]);

  const handleCancel = useCallback(() => {
    cancel();
    setFile(null);
    setShowPreview(false);
  }, [cancel]);

  useEffect(() => {
    if (!errorMeta) return;

    if (errorMeta.kind === "chunk_retry_exhausted") {
      pushToast(
        "error",
        "Chunk Upload Failed",
        "A chunk failed after the maximum retries. Check your network and click Resume to continue."
      );
      return;
    }

    if (errorMeta.kind === "auth") {
      pushToast(
        "warning",
        "Session Error",
        "Your token is invalid or expired. Sign in again before retrying the upload."
      );

      // Clear stale token so protected calls do not keep failing with 401.
      handleLogout();
      return;
    }

    pushToast("error", "Upload Error", errorMeta.message || "Upload failed unexpectedly.");
  }, [errorMeta, pushToast, handleLogout]);

  useEffect(() => {
    if (!token) return;

    let isActive = true;

    const validateToken = async () => {
      try {
        await getCurrentUser();
      } catch (err) {
        if (!isActive) return;
        const status = err?.response?.status;
        if (status === 401 || status === 403) {
          pushToast(
            "warning",
            "Session Expired",
            "Please sign in again to continue uploading."
          );
          handleLogout();
        }
      }
    };

    validateToken();

    return () => {
      isActive = false;
    };
  }, [token, pushToast, handleLogout]);

  if (!token) {
    return (
      <div className="app-container" style={{ display: 'flex', minHeight: '100vh', flexDirection: 'column' }}>
        <header className="app-header">
          <div className="app-logo">🏥</div>
          <h1>
            <span className="gradient-text">MedUpload</span>
          </h1>
          <p>Secure, resumable file uploads for medical imaging and records</p>
        </header>
        <Login onLogin={setToken} />
        <ToastStack toasts={toasts} onDismiss={dismissToast} />
      </div>
    );
  }

  return (
    <div className="app-container">
      {/* Header */}
      <header className="app-header">
        <div className="app-logo">🏥</div>
        <h1>
          <span className="gradient-text">MedUpload</span>
        </h1>
        <p>Secure, resumable file uploads for medical imaging and records</p>
        <button onClick={handleLogout} style={{ marginTop: '1rem', background: 'transparent', border: '1px solid currentColor', color: 'inherit', padding: '0.4rem 1rem', borderRadius: '4px', cursor: 'pointer' }}>
          Logout
        </button>
      </header>

      {/* Main Upload Card */}
      <main className="upload-card">
        <FileUploader
          file={file}
          onFileSelect={handleFileSelect}
          status={status}
          onUpload={handleUpload}
          onPause={pause}
          onResume={resume}
          onCancel={handleCancel}
          onPreview={() => setShowPreview(true)}
        />

        {/* Status Banner */}
        <UploadStatus status={status} error={error} />

        {/* Progress Tracker — show when uploading, paused, or completed */}
        {(status === "uploading" || status === "paused" || status === "completed") && (
          <ProgressTracker
            progress={progress}
            chunkStatuses={chunkStatuses}
            status={status}
          />
        )}
      </main>

      {/* Upload History List */}
      <UploadHistory triggerUpdate={status} />

      {/* Footer */}
      <footer className="app-footer">
        <div className="footer-badge">
          <span>🔒</span> End-to-end encrypted
        </div>
        <div className="footer-badge">
          <span>☁️</span> AWS S3 storage
        </div>
        <div className="footer-badge">
          <span>🔄</span> Resumable uploads
        </div>
      </footer>

      {/* Preview Modal */}
      {showPreview && file && (
        <FilePreviewModal
          file={file}
          onClose={() => setShowPreview(false)}
        />
      )}

      <ToastStack toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}

export default App;
