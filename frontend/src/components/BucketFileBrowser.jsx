import { useEffect, useMemo, useState, useCallback } from "react";
import { deleteFileByKey, getBucketFiles, getFileDownloadUrl } from "../api/uploadApi";
import { triggerPresignedFileAction } from "../utils/fileDownload";
import { getFileType } from "../utils/fileTypeUtils";

const REFRESH_INTERVAL_MS = 20000;
const CATEGORY_OPTIONS = [
  { value: "all", label: "All" },
  { value: "pdf", label: "PDF" },
  { value: "image", label: "Images" },
  { value: "archive", label: "Archives" },
  { value: "dicom", label: "DICOM" },
  { value: "other", label: "Other" },
];
const DELETE_FILE_CONFIRM_PHRASE = "Delete File";

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
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
  const status = Number(error?.response?.status || 0);
  if (status === 403) {
    return "Delete blocked by bucket permissions. Ensure the bucket credentials include s3:DeleteObject.";
  }
  return error?.response?.data?.detail || error?.message || "Failed to perform file action";
}

export default function BucketFileBrowser({ buckets, pushToast, onDataChanged }) {
  const [selectedBucketName, setSelectedBucketName] = useState("");
  const [files, setFiles] = useState([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCategory, setSelectedCategory] = useState("all");
  const [currentFolderPrefix, setCurrentFolderPrefix] = useState("");
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [actionLoadingByKey, setActionLoadingByKey] = useState({});
  const [deleteTargetFile, setDeleteTargetFile] = useState(null);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");
  const [deletingFileKey, setDeletingFileKey] = useState("");
  const [deleteWholeFolderPath, setDeleteWholeFolderPath] = useState(false);

  useEffect(() => {
    if (selectedBucketName) return;
    const firstBucket = (buckets || []).find((bucket) => !bucket.system_default);
    if (firstBucket?.bucket_name) {
      setSelectedBucketName(firstBucket.bucket_name);
    }
  }, [buckets, selectedBucketName]);

  const selectedBucket = useMemo(
    () => (buckets || []).find((bucket) => bucket.bucket_name === selectedBucketName) || null,
    [buckets, selectedBucketName],
  );

  const breadcrumbSegments = useMemo(() => {
    const trimmed = (currentFolderPrefix || "").replace(/\/$/, "");
    if (!trimmed) return [];
    return trimmed.split("/").filter(Boolean);
  }, [currentFolderPrefix]);

  const fetchFiles = useCallback(async ({ silent = false } = {}) => {
    if (!selectedBucketName) {
      setFiles([]);
      setError("");
      return;
    }

    if (silent) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }

    try {
      const response = await getBucketFiles({
        bucketId: selectedBucket?.id || null,
        bucketName: selectedBucketName,
      });
      const items = Array.isArray(response?.files) ? response.files : [];
      setFiles(items);
      setError("");
    } catch (err) {
      const message = getErrorMessage(err);
      setError(message);
      if (!silent) {
        pushToast("error", "File Browser Error", message);
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [selectedBucket, selectedBucketName, pushToast]);

  useEffect(() => {
    fetchFiles({ silent: false });

    if (!selectedBucketName) return undefined;
    const intervalId = window.setInterval(() => {
      fetchFiles({ silent: true });
    }, REFRESH_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [selectedBucketName, fetchFiles]);

  useEffect(() => {
    setCurrentFolderPrefix("");
    setSelectedCategory("all");
    setSearchQuery("");
  }, [selectedBucketName]);

  const { folderEntries, filesInCurrentFolder } = useMemo(() => {
    const folders = new Set();
    const filesForFolder = [];
    const prefix = currentFolderPrefix || "";

    files.forEach((file) => {
      const fullKey = file?.file_key || "";
      if (!fullKey.startsWith(prefix)) return;

      const relativeKey = fullKey.slice(prefix.length);
      if (!relativeKey) return;

      const slashIndex = relativeKey.indexOf("/");
      if (slashIndex >= 0) {
        folders.add(relativeKey.slice(0, slashIndex));
        return;
      }

      filesForFolder.push(file);
    });

    return {
      folderEntries: Array.from(folders).sort((a, b) => a.localeCompare(b)),
      filesInCurrentFolder: filesForFolder,
    };
  }, [files, currentFolderPrefix]);

  const visibleFiles = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const filteredByCategory = filesInCurrentFolder.filter((file) => {
      if (selectedCategory === "all") return true;
      return getFileType(file?.file_name || "") === selectedCategory;
    });

    if (!query) return filteredByCategory;

    return filteredByCategory.filter((file) => {
      const fileName = (file?.file_name || "").toLowerCase();
      const fileKey = (file?.file_key || "").toLowerCase();
      return fileName.includes(query) || fileKey.includes(query);
    });
  }, [filesInCurrentFolder, searchQuery, selectedCategory]);

  const visibleFolders = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return folderEntries;
    return folderEntries.filter((folder) => folder.toLowerCase().includes(query));
  }, [folderEntries, searchQuery]);

  const handleAction = useCallback(async (file, mode) => {
    const key = file.file_key;
    setActionLoadingByKey((prev) => ({ ...prev, [key]: true }));

    try {
      const payload = await getFileDownloadUrl({
        file_key: file.file_key,
        fileKey: file.file_key,
        bucket_name: selectedBucketName,
        bucketName: selectedBucketName,
        bucket_id: selectedBucket?.id || undefined,
        bucketId: selectedBucket?.id || undefined,
      });

      triggerPresignedFileAction(payload.url, {
        mode,
        fileName: file.file_name || "download",
      });
    } catch (err) {
      pushToast("error", "File Action Failed", getErrorMessage(err));
    } finally {
      setActionLoadingByKey((prev) => ({ ...prev, [key]: false }));
    }
  }, [pushToast, selectedBucketName, selectedBucket]);

  const canConfirmDelete = deleteConfirmText.trim() === DELETE_FILE_CONFIRM_PHRASE;

  const handleOpenDeleteModal = (file) => {
    setDeleteTargetFile(file);
    setDeleteConfirmText("");
    setDeleteWholeFolderPath(false);
  };

  const handleCloseDeleteModal = () => {
    if (deletingFileKey) return;
    setDeleteTargetFile(null);
    setDeleteConfirmText("");
    setDeleteWholeFolderPath(false);
  };

  const handleConfirmDelete = useCallback(async () => {
    const targetFile = deleteTargetFile;
    if (!targetFile?.file_key || !selectedBucketName || !canConfirmDelete || deletingFileKey) return;

    setDeletingFileKey(targetFile.file_key);
    try {
      await deleteFileByKey({
        file_key: targetFile.file_key,
        bucket_name: selectedBucketName,
        bucket_id: selectedBucket?.id || undefined,
        delete_scope: deleteWholeFolderPath ? "prefix" : "object",
      });
      pushToast(
        "success",
        deleteWholeFolderPath ? "Folder Deleted" : "File Deleted",
        deleteWholeFolderPath
          ? "Folder path objects removed from S3 and synced from UI."
          : "File removed from S3 and synced from UI.",
      );
      handleCloseDeleteModal();
      await fetchFiles({ silent: false });
      if (onDataChanged) {
        await onDataChanged();
      }
    } catch (err) {
      pushToast("error", "Delete Failed", getErrorMessage(err));
    } finally {
      setDeletingFileKey("");
    }
  }, [canConfirmDelete, deleteTargetFile, deleteWholeFolderPath, deletingFileKey, fetchFiles, onDataChanged, pushToast, selectedBucket, selectedBucketName]);

  return (
    <main className="flex-1 w-full max-w-[1440px] mx-auto px-6 lg:px-10 py-10 space-y-6">
      <div>
        <h1 className="text-3xl font-extrabold tracking-tighter headline text-primary">Files</h1>
        <p className="text-sm text-on-surface-variant font-medium mt-1">Browse files from a selected bucket with secure preview and download.</p>
      </div>

      <section className="bg-surface-container-lowest rounded-xl border border-surface-container-high shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-surface-container-high flex flex-col md:flex-row gap-3 md:items-center md:justify-between">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 w-full md:w-auto md:min-w-[560px]">
            <select
              className="w-full rounded-lg bg-surface-container-highest border border-surface-container-high px-3 py-2 text-sm"
              value={selectedBucketName}
              onChange={(event) => setSelectedBucketName(event.target.value)}
            >
              <option value="">Select a bucket</option>
              {(buckets || []).filter((bucket) => !bucket.system_default).map((bucket) => (
                <option key={bucket.id} value={bucket.bucket_name}>
                  {bucket.bucket_name} ({bucket.region || "-"})
                </option>
              ))}
            </select>

            <input
              type="text"
              className="w-full rounded-lg bg-surface-container-highest border border-surface-container-high px-3 py-2 text-sm"
              placeholder="Search by file name or key"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
            />
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-on-surface-variant">
              {refreshing ? "Syncing..." : `Auto-sync ${Math.round(REFRESH_INTERVAL_MS / 1000)}s`}
            </span>
            <button
              type="button"
              onClick={() => fetchFiles({ silent: false })}
              className="rounded-lg bg-surface-container-high px-3 py-2 text-xs font-bold text-primary"
            >
              Refresh Now
            </button>
          </div>
        </div>

        <div className="px-6 py-3 border-b border-surface-container-high flex flex-wrap items-center gap-2">
          {CATEGORY_OPTIONS.map((category) => {
            const isActive = selectedCategory === category.value;
            return (
              <button
                key={category.value}
                type="button"
                onClick={() => setSelectedCategory(category.value)}
                className={`rounded-full px-3 py-1 text-[11px] font-bold ${
                  isActive
                    ? "bg-primary text-on-primary"
                    : "bg-surface-container-high text-on-surface-variant"
                }`}
              >
                {category.label}
              </button>
            );
          })}
        </div>

        <div className="px-6 py-3 border-b border-surface-container-high flex flex-wrap items-center gap-2 text-xs font-semibold text-on-surface-variant">
          <button
            type="button"
            onClick={() => setCurrentFolderPrefix("")}
            className="rounded-md bg-surface-container-high px-2.5 py-1 text-primary"
          >
            Root
          </button>
          {breadcrumbSegments.map((segment, index) => {
            const nextPrefix = `${breadcrumbSegments.slice(0, index + 1).join("/")}/`;
            return (
              <button
                key={`${segment}-${index}`}
                type="button"
                onClick={() => setCurrentFolderPrefix(nextPrefix)}
                className="rounded-md bg-surface-container-high px-2.5 py-1 text-primary"
              >
                {segment}
              </button>
            );
          })}
        </div>

        {error ? (
          <div className="px-6 py-4 text-xs font-semibold text-error bg-error-container/30">{error}</div>
        ) : null}

        {selectedBucketName && !loading && visibleFolders.length > 0 ? (
          <div className="px-6 py-4 border-b border-surface-container-high">
            <p className="text-[11px] uppercase tracking-widest font-bold text-on-surface-variant mb-2">Folders</p>
            <div className="flex flex-wrap gap-2">
              {visibleFolders.map((folder) => (
                <button
                  key={folder}
                  type="button"
                  onClick={() => setCurrentFolderPrefix(`${currentFolderPrefix}${folder}/`)}
                  className="rounded-lg bg-surface-container-high px-3 py-1.5 text-xs font-bold text-primary"
                >
                  {folder}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="text-[10px] uppercase tracking-widest text-on-surface-variant bg-surface-container-low/50">
                <th className="px-6 py-4">File</th>
                <th className="px-6 py-4">Size</th>
                <th className="px-6 py-4">Last Modified</th>
                <th className="px-6 py-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-container-high/50">
              {!selectedBucketName ? (
                <tr>
                  <td colSpan="4" className="px-6 py-10 text-sm text-center font-medium text-on-surface-variant">
                    Select a bucket to browse files.
                  </td>
                </tr>
              ) : loading ? (
                <tr>
                  <td colSpan="4" className="px-6 py-10 text-sm text-center font-medium text-on-surface-variant">
                    Loading files...
                  </td>
                </tr>
              ) : visibleFiles.length === 0 ? (
                <tr>
                  <td colSpan="4" className="px-6 py-10 text-sm text-center font-medium text-on-surface-variant">
                    No files found in this folder/category.
                  </td>
                </tr>
              ) : (
                visibleFiles.map((file) => {
                  const isBusy = Boolean(actionLoadingByKey[file.file_key]);
                  return (
                    <tr key={file.file_key} className="hover:bg-surface-container-low/30 transition-colors">
                      <td className="px-6 py-5">
                        <p className="text-sm font-semibold text-primary truncate max-w-[420px]" title={file.file_name}>{file.file_name}</p>
                        <p className="mt-1 text-[11px] text-on-surface-variant font-medium truncate max-w-[520px]" title={file.file_key}>{file.file_key}</p>
                      </td>
                      <td className="px-6 py-5 text-xs font-semibold text-on-surface-variant">{formatBytes(Number(file.size || 0))}</td>
                      <td className="px-6 py-5 text-xs font-semibold text-on-surface-variant">{formatDate(file.last_modified)}</td>
                      <td className="px-6 py-5 text-right">
                        <div className="inline-flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => handleAction(file, "open")}
                            disabled={isBusy}
                            className="rounded-md bg-surface-container-high px-3 py-1.5 text-xs font-bold text-primary disabled:opacity-60"
                          >
                            Preview
                          </button>
                          <button
                            type="button"
                            onClick={() => handleAction(file, "download")}
                            disabled={isBusy}
                            className="rounded-md bg-primary px-3 py-1.5 text-xs font-bold text-on-primary disabled:opacity-60"
                          >
                            {isBusy ? "Working..." : "Download"}
                          </button>
                          <button
                            type="button"
                            onClick={() => handleOpenDeleteModal(file)}
                            disabled={isBusy}
                            className="rounded-md bg-error-container px-3 py-1.5 text-xs font-bold text-error disabled:opacity-60"
                          >
                            Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>

      {deleteTargetFile ? (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/35 px-4">
          <div className="w-full max-w-md rounded-xl bg-surface-container-lowest border border-surface-container-high shadow-xl p-6">
            <h3 className="text-lg font-bold text-primary headline">Confirm File Removal</h3>
            <p className="mt-2 text-sm font-medium text-on-surface-variant">
              This will delete the file object from S3 for the selected bucket.
            </p>
            <p className="mt-1 text-xs font-semibold text-on-surface-variant truncate" title={deleteTargetFile.file_name}>
              File: {deleteTargetFile.file_name}
            </p>
            <p className="mt-3 text-xs font-semibold text-on-surface-variant">
              Type "{DELETE_FILE_CONFIRM_PHRASE}" to confirm.
            </p>
            <label className="mt-3 flex items-center gap-2 text-xs font-semibold text-on-surface-variant">
              <input
                type="checkbox"
                checked={deleteWholeFolderPath}
                onChange={(event) => setDeleteWholeFolderPath(event.target.checked)}
              />
              Delete entire folder path containing this file
            </label>
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
                disabled={Boolean(deletingFileKey)}
                className="rounded-lg bg-surface-container-high text-primary px-4 py-2 text-xs font-bold disabled:opacity-60"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmDelete}
                disabled={!canConfirmDelete || deletingFileKey === deleteTargetFile.file_key}
                className="rounded-lg bg-error-container text-error px-4 py-2 text-xs font-bold disabled:opacity-60"
              >
                {deletingFileKey === deleteTargetFile.file_key ? "Deleting..." : deleteWholeFolderPath ? "Delete Folder" : "Delete"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
