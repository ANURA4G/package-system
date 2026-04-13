import { useState } from "react";
import { deleteHistoryRecord, deleteUploadedFile, getFileDownloadUrl } from "../api/uploadApi";
import {
  computeExpiryTimestamp,
  formatExpiryHint,
  inferDownloadFileName,
  triggerPresignedFileAction,
} from "../utils/fileDownload";

const DELETE_FILE_CONFIRM_PHRASE = "Delete File";

function getRecordKey(record, index) {
  return record?.id || record?.file_id || record?.file_key || `${record?.filename || "row"}-${index}`;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / (1024 ** index)).toFixed(index === 0 ? 0 : 2)} ${units[index]}`;
}

function formatDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString();
}

function getErrorMessage(error) {
  return error?.response?.data?.detail || error?.message || "Could not retrieve secure file URL";
}

export default function FileList({ records, emptyMessage, onDeleteSuccess, pushToast }) {
  const [loadingByRecordKey, setLoadingByRecordKey] = useState({});
  const [errorByRecordKey, setErrorByRecordKey] = useState({});
  const [expiryByRecordKey, setExpiryByRecordKey] = useState({});
  const [deleteTargetRecord, setDeleteTargetRecord] = useState(null);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");
  const [deletingRecordId, setDeletingRecordId] = useState(null);
  const [removingHistoryRecordId, setRemovingHistoryRecordId] = useState(null);

  const handleFileAction = async (record, recordKey, mode) => {
    setLoadingByRecordKey((prev) => ({ ...prev, [recordKey]: true }));
    setErrorByRecordKey((prev) => ({ ...prev, [recordKey]: "" }));

    try {
      let actionCompleted = false;

      for (let attempt = 0; attempt < 2 && !actionCompleted; attempt += 1) {
        let urlPayload;
        try {
          urlPayload = await getFileDownloadUrl(record);
        } catch (error) {
          const status = Number(error?.response?.status || 0);
          const shouldRetry = attempt === 0 && (status === 401 || status === 403);
          if (shouldRetry) {
            continue;
          }
          throw error;
        }

        const expiresAt = computeExpiryTimestamp(urlPayload.url, urlPayload.expiresInSeconds);

        setExpiryByRecordKey((prev) => ({
          ...prev,
          [recordKey]: expiresAt,
        }));

        triggerPresignedFileAction(urlPayload.url, {
          mode,
          fileName: inferDownloadFileName(record),
        });

        actionCompleted = true;
      }

      if (!actionCompleted) {
        throw new Error("Failed to access file. Please retry.");
      }
    } catch (error) {
      setErrorByRecordKey((prev) => ({
        ...prev,
        [recordKey]: getErrorMessage(error),
      }));
    } finally {
      setLoadingByRecordKey((prev) => ({ ...prev, [recordKey]: false }));
    }
  };

  const canConfirmDelete = deleteConfirmText.trim() === DELETE_FILE_CONFIRM_PHRASE;

  const handleOpenDeleteModal = (record) => {
    setDeleteTargetRecord(record);
    setDeleteConfirmText("");
  };

  const handleCloseDeleteModal = () => {
    if (deletingRecordId) return;
    setDeleteTargetRecord(null);
    setDeleteConfirmText("");
  };

  const handleConfirmDelete = async () => {
    const recordId = deleteTargetRecord?.id;
    if (!recordId || deletingRecordId || !canConfirmDelete) return;

    setDeletingRecordId(recordId);
    try {
      await deleteUploadedFile(recordId);
      if (pushToast) {
        pushToast("success", "File Deleted", "File was removed from S3 and hidden from history.");
      }
      handleCloseDeleteModal();
      if (onDeleteSuccess) {
        await onDeleteSuccess();
      }
    } catch (error) {
      const message = error?.response?.data?.detail || error?.message || "Failed to delete file";
      if (pushToast) {
        pushToast("error", "Delete Failed", message);
      }
    } finally {
      setDeletingRecordId(null);
    }
  };

  const handleRemoveFromHistory = async (record) => {
    const recordId = record?.id;
    if (!recordId || removingHistoryRecordId || deletingRecordId) return;

    const confirmed = window.confirm("Remove this entry from history only? File will remain in S3.");
    if (!confirmed) return;

    setRemovingHistoryRecordId(recordId);
    try {
      await deleteHistoryRecord(recordId);
      if (pushToast) {
        pushToast("success", "History Updated", "Entry removed from history.");
      }
      if (onDeleteSuccess) {
        await onDeleteSuccess();
      }
    } catch (error) {
      const message = error?.response?.data?.detail || error?.message || "Failed to remove history entry";
      if (pushToast) {
        pushToast("error", "History Remove Failed", message);
      }
    } finally {
      setRemovingHistoryRecordId(null);
    }
  };

  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full text-left font-body">
          <thead>
            <tr className="text-[10px] uppercase tracking-widest text-on-surface-variant bg-surface-container-low/50">
              <th className="px-6 py-4">File</th>
              <th className="px-6 py-4">Size</th>
              <th className="px-6 py-4">Uploaded</th>
              <th className="px-6 py-4 text-right">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-surface-container-high/50">
            {records.length === 0 ? (
              <tr>
                <td colSpan="4" className="px-6 py-10 text-sm font-medium text-on-surface-variant text-center">
                  {emptyMessage}
                </td>
              </tr>
            ) : (
              records.map((record, index) => {
                const recordKey = getRecordKey(record, index);
                const isLoading = Boolean(loadingByRecordKey[recordKey]);
                const errorMessage = errorByRecordKey[recordKey] || "";
                const expiryHint = formatExpiryHint(expiryByRecordKey[recordKey]);
                const canDelete = Boolean(record?.id);
                const isRemovingHistory = removingHistoryRecordId === record?.id;

                return (
                  <tr key={recordKey} className="hover:bg-surface-container-low/30 transition-colors">
                    <td className="px-6 py-5 text-sm font-semibold text-primary max-w-[340px] truncate" title={record.filename || record.file_name || "-"}>
                      {record.filename || record.file_name || "-"}
                    </td>
                    <td className="px-6 py-5 text-xs font-bold text-on-surface-variant">{formatBytes(Number(record.size || 0))}</td>
                    <td className="px-6 py-5 text-xs text-on-surface-variant font-medium">{formatDate(record.created_at)}</td>
                    <td className="px-6 py-5">
                      <div className="flex justify-end items-start gap-2">
                        <button
                          type="button"
                          onClick={() => handleFileAction(record, recordKey, "download")}
                          disabled={isLoading}
                          className="rounded-md bg-primary px-3 py-1.5 text-xs font-bold text-on-primary disabled:opacity-60"
                          title={expiryHint}
                        >
                          {isLoading ? "Loading..." : "Download"}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleFileAction(record, recordKey, "open")}
                          disabled={isLoading}
                          className="rounded-md bg-surface-container-high px-3 py-1.5 text-xs font-bold text-primary disabled:opacity-60"
                          title={expiryHint}
                        >
                          Open
                        </button>
                        <button
                          type="button"
                          onClick={() => handleOpenDeleteModal(record)}
                          disabled={!canDelete || isLoading}
                          className="rounded-md bg-error-container px-3 py-1.5 text-xs font-bold text-error disabled:opacity-60"
                          title={canDelete ? "Delete file securely" : "Delete unavailable for this row"}
                        >
                          Delete
                        </button>
                        <button
                          type="button"
                          onClick={() => handleRemoveFromHistory(record)}
                          disabled={!canDelete || isLoading || isRemovingHistory}
                          className="rounded-md bg-surface-container-high px-3 py-1.5 text-xs font-bold text-primary disabled:opacity-60"
                          title="Remove record from history only"
                        >
                          {isRemovingHistory ? "Removing..." : "Remove"}
                        </button>
                      </div>
                      <p className="mt-1 text-right text-[10px] font-semibold text-on-surface-variant">{expiryHint}</p>
                      {errorMessage ? (
                        <p className="mt-1 text-right text-[11px] font-semibold text-error">{errorMessage}</p>
                      ) : null}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {deleteTargetRecord ? (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/35 px-4">
          <div className="w-full max-w-md rounded-xl bg-surface-container-lowest border border-surface-container-high shadow-xl p-6">
            <h3 className="text-lg font-bold text-primary headline">Confirm File Removal</h3>
            <p className="mt-2 text-sm font-medium text-on-surface-variant">
              This will delete the file object from S3 and remove it from your upload history.
            </p>
            <p className="mt-1 text-xs font-semibold text-on-surface-variant truncate" title={deleteTargetRecord?.filename || deleteTargetRecord?.file_name || "-"}>
              File: {deleteTargetRecord?.filename || deleteTargetRecord?.file_name || "-"}
            </p>
            <p className="mt-3 text-xs font-semibold text-on-surface-variant">
              Type "{DELETE_FILE_CONFIRM_PHRASE}" to confirm.
            </p>
            <input
              className="mt-2 w-full rounded-lg bg-surface-container-highest px-3 py-2.5 text-sm border border-surface-container-high"
              value={deleteConfirmText}
              onChange={(event) => setDeleteConfirmText(event.target.value)}
              placeholder={DELETE_FILE_CONFIRM_PHRASE}
            />
            {deleteConfirmText.length > 0 && !canConfirmDelete ? (
              <p className="mt-1 text-[11px] text-error font-semibold">Please type Delete File exactly</p>
            ) : null}

            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={handleCloseDeleteModal}
                disabled={Boolean(deletingRecordId)}
                className="rounded-lg bg-surface-container-high text-primary px-4 py-2 text-xs font-bold disabled:opacity-60"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmDelete}
                disabled={!canConfirmDelete || deletingRecordId === deleteTargetRecord?.id}
                className="rounded-lg bg-error-container text-error px-4 py-2 text-xs font-bold disabled:opacity-60"
              >
                {deletingRecordId === deleteTargetRecord?.id ? "Deleting..." : "Delete"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
