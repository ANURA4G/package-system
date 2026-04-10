import React, { useState, useEffect } from "react";
import { getUploadHistory } from "../api/uploadApi";
import "./UploadHistory.css";

export default function UploadHistory({ triggerUpdate }) {
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const fetchHistory = async () => {
      setLoading(true);
      try {
        const data = await getUploadHistory();
        setHistory(data);
        setError(null);
      } catch (err) {
        setError("Failed to load upload history");
      } finally {
        setLoading(false);
      }
    };
    fetchHistory();
  }, [triggerUpdate]);

  const formatSize = (bytes) => {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  };

  const formatDate = (isoString) => {
    return new Date(isoString).toLocaleString();
  };

  if (loading && history.length === 0) {
    return (
      <div className="bg-surface-container-lowest rounded-xl overflow-hidden shadow-[0px_12px_32px_rgba(0,21,42,0.04)] mt-8 p-8 flex justify-center items-center">
        <span className="material-symbols-outlined animate-spin text-tertiary-container text-3xl">hourglass_empty</span>
      </div>
    );
  }
  if (error) {
    return (
      <div className="bg-error-container text-error rounded-xl p-8 mt-8 font-bold text-sm text-center">
        {error}
      </div>
    );
  }

  return (
    <div className="bg-surface-container-lowest rounded-xl overflow-hidden shadow-[0px_12px_32px_rgba(0,21,42,0.04)] mt-10">
      <div className="p-8 border-b border-surface-container-high flex justify-between items-center">
        <h2 className="text-xl font-extrabold tracking-tight text-primary headline">Recent Secure Activity</h2>
        <button className="text-xs font-bold text-on-primary-container hover:underline">View Audit Log</button>
      </div>
      
      <div className="p-0 overflow-x-auto">
        <table className="w-full text-left font-body">
          <thead>
            <tr className="text-[10px] uppercase tracking-widest text-on-surface-variant bg-surface-container-low/50">
              <th className="px-8 py-4">Transaction ID</th>
              <th className="px-8 py-4">Item Details</th>
              <th className="px-8 py-4">Status</th>
              <th className="px-8 py-4 text-right">Timestamp</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-surface-container-high/50">
            {history.length === 0 ? (
              <tr>
                <td colSpan="4" className="px-8 py-10 text-center text-sm font-medium text-on-surface-variant">No files processed yet.</td>
              </tr>
            ) : (
              history.map((record) => (
                <tr key={record.id} className="hover:bg-surface-container-low/30 transition-colors">
                  <td className="px-8 py-6 font-mono text-xs text-primary font-bold">#TRX-{record.id.slice(0, 8).toUpperCase()}</td>
                  <td className="px-8 py-6">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded bg-tertiary-container/10 flex items-center justify-center">
                        <span className="material-symbols-outlined text-tertiary-container text-sm">radiology</span>
                      </div>
                      <div>
                        <p className="text-sm font-semibold text-primary truncate max-w-[200px]" title={record.filename}>{record.filename}</p>
                        <p className="text-[10px] text-on-surface-variant font-bold">{formatSize(record.size)}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-8 py-6">
                    <span className="px-2 py-1 bg-tertiary-fixed-dim/20 text-tertiary-container text-[10px] font-bold rounded uppercase">Secure</span>
                  </td>
                  <td className="px-8 py-6 text-right text-xs text-on-surface-variant font-medium">
                    {formatDate(record.created_at)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
