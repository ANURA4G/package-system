import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useChunkedUpload } from "./hooks/useChunkedUpload";
import FileUploader from "./components/FileUploader";
import ProgressTracker from "./components/ProgressTracker";
import UploadStatus from "./components/UploadStatus";
import FileList from "./components/FileList";
import BucketFileBrowser from "./components/BucketFileBrowser";
import FilePreviewModal from "./components/FilePreviewModal";
import ToastStack from "./components/ToastStack";
import Login from "./components/Login";
import { getCurrentUser } from "./api/authApi";
import { addBucket, clearUploadHistory, deleteBucket, getBucketUsage, getBuckets, getUploadHistory, updateBucket } from "./api/uploadApi";
import JSZip from "jszip";
import "./App.css";

const TOAST_TTL_MS = 7000;
const COMPLETION_REFRESH_MS = 5000;
const BYTES_PER_GB = 1024 * 1024 * 1024;
const HISTORY_PAGE_SIZE = 10;
const DELETE_BUCKET_CONFIRM_PHRASE = "Delete Bucket";
const CLEAR_HISTORY_CONFIRM_PHRASE = "Clear History";
const BUCKET_NAME_REGEX = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const REGION_FORMAT_REGEX = /^[a-z]{2}-[a-z]+-\d+$/;
const THEME_STORAGE_KEY = "theme";
const THEME_DARK = "dark";
const THEME_LIGHT = "light";

function getInitialTheme() {
  try {
    const storedTheme = localStorage.getItem(THEME_STORAGE_KEY);
    return storedTheme === THEME_DARK || storedTheme === THEME_LIGHT
      ? storedTheme
      : THEME_LIGHT;
  } catch {
    return THEME_LIGHT;
  }
}

function validateBucketPayload(payload) {
  const errors = {};

  const bucketName = payload.bucket_name || "";
  if (!bucketName) {
    errors.bucket_name = "Bucket name is required.";
  } else if (bucketName.length < 3 || bucketName.length > 63) {
    errors.bucket_name = "Bucket name must be 3-63 characters.";
  } else if (!BUCKET_NAME_REGEX.test(bucketName) || bucketName.includes("..") || bucketName.includes(".-") || bucketName.includes("-.")) {
    errors.bucket_name = "Use lowercase letters, numbers, dots, or hyphens. No underscores.";
  }

  const region = payload.region || "";
  if (!region) {
    errors.region = "Region is required.";
  } else if (!REGION_FORMAT_REGEX.test(region)) {
    errors.region = "Region must look like ap-south-1.";
  }

  const accessKey = payload.aws_access_key_id || "";
  if (!accessKey) {
    errors.aws_access_key_id = "AWS access key is required.";
  } else if (!/^[A-Z0-9]{16,128}$/.test(accessKey)) {
    errors.aws_access_key_id = "Use uppercase letters and numbers only (16-128 chars).";
  }

  const secretKey = payload.aws_secret_access_key || "";
  if (!secretKey) {
    errors.aws_secret_access_key = "AWS secret key is required.";
  } else if (secretKey.length < 16 || secretKey.length > 256) {
    errors.aws_secret_access_key = "Secret key must be between 16 and 256 characters.";
  }

  const sizeLimitGbRaw = `${payload.size_limit_gb ?? ""}`.trim();
  if (!sizeLimitGbRaw) {
    errors.size_limit_gb = "Size limit is required.";
  } else {
    const sizeLimitGb = Number(sizeLimitGbRaw);
    if (!Number.isFinite(sizeLimitGb) || sizeLimitGb <= 0) {
      errors.size_limit_gb = "Size limit must be greater than 0.";
    }
  }

  const useKms = Boolean(payload.use_kms);
  const kmsKeyId = `${payload.kms_key_id || ""}`.trim();
  if (useKms && !kmsKeyId) {
    errors.kms_key_id = "KMS Key ID / ARN is required when KMS encryption is enabled.";
  }

  const notes = `${payload.notes || ""}`;
  if (notes.length > 2000) {
    errors.notes = "Notes must be 2000 characters or fewer.";
  }

  return errors;
}

function validateBucketMetadataPayload(payload) {
  const errors = {};

  const displayName = `${payload.display_name || ""}`.trim();
  if (!displayName) {
    errors.display_name = "Display name is required.";
  }

  const region = `${payload.region || ""}`.trim();
  if (!region) {
    errors.region = "Region is required.";
  } else if (!REGION_FORMAT_REGEX.test(region)) {
    errors.region = "Region must look like ap-south-1.";
  }

  const sizeLimitGbRaw = `${payload.size_limit_gb ?? ""}`.trim();
  if (!sizeLimitGbRaw) {
    errors.size_limit_gb = "Size limit is required.";
  } else {
    const sizeLimitGb = Number(sizeLimitGbRaw);
    if (!Number.isFinite(sizeLimitGb) || sizeLimitGb <= 0) {
      errors.size_limit_gb = "Size limit must be greater than 0.";
    }
  }

  const notes = `${payload.notes || ""}`;
  if (notes.length > 2000) {
    errors.notes = "Notes must be 2000 characters or fewer.";
  }

  const useKms = Boolean(payload.use_kms);
  const kmsKeyId = `${payload.kms_key_id || ""}`.trim();
  if (useKms && !kmsKeyId) {
    errors.kms_key_id = "KMS Key ID / ARN is required when KMS encryption is enabled.";
  }

  return errors;
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

function getDetailMessage(error, fallback) {
  return error?.response?.data?.detail || error?.message || fallback;
}

function App() {
  const [token, setToken] = useState(sessionStorage.getItem("token"));
  const [theme, setTheme] = useState(getInitialTheme);
  const [authReady, setAuthReady] = useState(false);
  const [currentUser, setCurrentUser] = useState(null);
  const [activeTab, setActiveTab] = useState("dashboard");
  const [file, setFile] = useState(null);
  const [showPreview, setShowPreview] = useState(false);
  const [isPreparingFolder, setIsPreparingFolder] = useState(false);
  const [toasts, setToasts] = useState([]);
  const [history, setHistory] = useState([]);
  const [buckets, setBuckets] = useState([]);
  const [bucketUsageByName, setBucketUsageByName] = useState({});
  const [dataLoading, setDataLoading] = useState(false);
  const [dataError, setDataError] = useState(null);
  const [bucketSaving, setBucketSaving] = useState(false);
  const [bucketDeletingId, setBucketDeletingId] = useState(null);
  const [bucketDeleteTarget, setBucketDeleteTarget] = useState(null);
  const [bucketDeleteConfirmText, setBucketDeleteConfirmText] = useState("");
  const [bucketUpdating, setBucketUpdating] = useState(false);
  const [selectedUploadBucket, setSelectedUploadBucket] = useState("");
  const [uploadGrowthFilter, setUploadGrowthFilter] = useState("all");
  const [graphFromDate, setGraphFromDate] = useState("");
  const [graphToDate, setGraphToDate] = useState("");
  const [historySearchQuery, setHistorySearchQuery] = useState("");
  const [historySortFilter, setHistorySortFilter] = useState("latest");
  const [historyPage, setHistoryPage] = useState(1);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [showUserDetails, setShowUserDetails] = useState(false);
  const [bucketForm, setBucketForm] = useState({
    bucket_name: "",
    region: "",
    aws_access_key_id: "",
    aws_secret_access_key: "",
    size_limit_gb: "10",
    use_kms: false,
    kms_key_id: "",
    notes: "",
  });
  const [bucketFormErrors, setBucketFormErrors] = useState({});
  const [bucketFormTouched, setBucketFormTouched] = useState({});
  const [bucketAdvancedOpen, setBucketAdvancedOpen] = useState(false);
  const [bucketEditForm, setBucketEditForm] = useState({
    bucket_id: "",
    bucket_name: "",
    display_name: "",
    region: "",
    size_limit_gb: "10",
    use_kms: false,
    kms_key_id: "",
    notes: "",
  });
  const [bucketEditErrors, setBucketEditErrors] = useState({});
  const [bucketEditTouched, setBucketEditTouched] = useState({});
  const [bucketEditAdvancedOpen, setBucketEditAdvancedOpen] = useState(false);
  const [showClearHistoryModal, setShowClearHistoryModal] = useState(false);
  const [clearHistoryConfirmText, setClearHistoryConfirmText] = useState("");
  const [clearingHistory, setClearingHistory] = useState(false);
  const completionRefreshTimerRef = useRef(null);
  const completionNoticeShownRef = useRef(false);
  const userMenuRef = useRef(null);
  const isDarkMode = theme === THEME_DARK;

  const {
    status,
    progress,
    chunkStatuses,
    error,
    errorMeta,
    uploadInfo,
    networkType,
    displayChunkMB,
    avgUploadSpeedMB,
    etaDisplay,
    prepareUpload,
    upload,
    pause,
    resume,
    cancel,
  } =
    useChunkedUpload();

  const pushToast = useCallback((type, title, message, ttlMs = TOAST_TTL_MS) => {
    const id = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
    setToasts((prev) => [...prev, { id, type, title, message }]);

    window.setTimeout(() => {
      setToasts((prev) => prev.filter((toast) => toast.id !== id));
    }, ttlMs);
  }, []);

  const dismissToast = useCallback((id) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => (prev === THEME_DARK ? THEME_LIGHT : THEME_DARK));
  }, []);

  const handleLogout = useCallback(() => {
    sessionStorage.removeItem("token");
    setToken(null);
    setCurrentUser(null);
    setActiveTab("dashboard");
    setAuthReady(true);
    setFile(null);
    setShowPreview(false);
    setHistory([]);
    setBuckets([]);
    setBucketUsageByName({});
    setGraphFromDate("");
    setGraphToDate("");
    setHistorySearchQuery("");
    setHistorySortFilter("latest");
    setUserMenuOpen(false);
    setShowUserDetails(false);
  }, []);

  const handleToggleUserMenu = useCallback(() => {
    setUserMenuOpen((prev) => !prev);
  }, []);

  const handleShowUserDetails = useCallback(() => {
    setShowUserDetails((prev) => !prev);
  }, []);

  const fetchWorkspaceData = useCallback(async () => {
    if (!token) return;

    setDataLoading(true);
    setDataError(null);

    const [historyResult, bucketsResult] = await Promise.allSettled([
      getUploadHistory(),
      getBuckets(),
    ]);

    let failedCalls = 0;

    if (historyResult.status === "fulfilled") {
      setHistory(Array.isArray(historyResult.value) ? historyResult.value : []);
    } else {
      failedCalls += 1;
      setHistory([]);
    }

    if (bucketsResult.status === "fulfilled") {
      setBuckets(Array.isArray(bucketsResult.value) ? bucketsResult.value : []);
    } else {
      failedCalls += 1;
      setBuckets([]);
    }

    if (failedCalls > 0) {
      setDataError("Some dashboard data could not be loaded.");
      pushToast("warning", "Data Sync Warning", "Some dashboard values could not be loaded from the server.");
    }

    setDataLoading(false);
  }, [token, pushToast]);

  const handleFileSelect = useCallback(async (selectedFile) => {
    await cancel();
    setFile(selectedFile);
    setShowPreview(false);

    if (!selectedFile) return;

    const normalizedBucket = selectedUploadBucket.trim();
    if (!normalizedBucket) {
      pushToast("warning", "Bucket Required", "Select an upload bucket before preparing a file.");
      return;
    }

    try {
      await prepareUpload(selectedFile, normalizedBucket);
    } catch (err) {
      if (err?.code === "FILE_TYPE_NOT_ALLOWED") {
        setFile(null);
        pushToast(
          "error",
          "Unsupported File Type",
          err?.message || "Only DICOM, JPEG, PNG, PDF, and ZIP files are allowed."
        );
        return;
      }

      pushToast(
        "error",
        "Resume Check Failed",
        "Could not verify previous upload session. Please try selecting the file again."
      );
    }
  }, [cancel, prepareUpload, pushToast, selectedUploadBucket]);

  const handleFolderSelect = useCallback(async (selectedFiles) => {
    if (!selectedFiles || selectedFiles.length === 0) return;

    await cancel();
    setShowPreview(false);

    const normalizedBucket = selectedUploadBucket.trim();
    if (!normalizedBucket) {
      pushToast("warning", "Bucket Required", "Select an upload bucket before preparing a folder.");
      return;
    }

    setIsPreparingFolder(true);

    try {
      const zip = new JSZip();
      let rootFolderName = "folder";

      selectedFiles.forEach((entry) => {
        const path = entry.webkitRelativePath || entry.name;
        if (!path) return;

        const pathSegments = path.split("/");
        if (pathSegments.length > 1 && pathSegments[0]) {
          rootFolderName = pathSegments[0];
        }

        zip.file(path, entry);
      });

      pushToast("info", "Preparing Folder", "Compressing selected folder before secure upload...");

      const zipBlob = await zip.generateAsync({
        type: "blob",
        compression: "DEFLATE",
        compressionOptions: { level: 6 },
      });

      const zipFile = new File([zipBlob], `${rootFolderName}.zip`, {
        type: "application/zip",
        lastModified: Date.now(),
      });

      setFile(zipFile);
      await prepareUpload(zipFile, normalizedBucket);

      pushToast(
        "success",
        "Folder Ready",
        `Folder compressed to ${zipFile.name} and ready to upload.`
      );
    } catch (err) {
      setFile(null);
      pushToast(
        "error",
        "Folder Upload Failed",
        err?.message || "Could not prepare folder for upload."
      );
    } finally {
      setIsPreparingFolder(false);
    }
  }, [cancel, prepareUpload, pushToast, selectedUploadBucket]);

  const handleUpload = useCallback(() => {
    if (file) {
      const normalizedBucket = selectedUploadBucket.trim();
      if (!normalizedBucket) {
        pushToast("warning", "Bucket Required", "Select an upload bucket before starting upload.");
        return;
      }
      console.debug("[upload-ui] Start Upload clicked with bucket", normalizedBucket);
      upload(file, normalizedBucket);
    }
  }, [file, pushToast, selectedUploadBucket, upload]);

  const handleResumeUpload = useCallback(() => {
    const normalizedBucket = selectedUploadBucket.trim();
    if (!normalizedBucket) {
      pushToast("warning", "Bucket Required", "Select the original upload bucket before resuming.");
      return;
    }
    resume(normalizedBucket);
  }, [pushToast, resume, selectedUploadBucket]);

  const handleCancel = useCallback(() => {
    cancel();
    setFile(null);
    setShowPreview(false);
  }, [cancel]);

  const activeUploadBucketLabel = uploadInfo?.bucketName || selectedUploadBucket || "None";

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

    if (errorMeta.kind === "file_type") {
      pushToast(
        "error",
        "Unsupported File Type",
        errorMeta.message || "Only DICOM, JPEG, PNG, PDF, and ZIP files are allowed."
      );
      return;
    }

    pushToast("error", "Upload Error", errorMeta.message || "Upload failed unexpectedly.");
  }, [errorMeta, pushToast, handleLogout]);

  useEffect(() => {
    document.body.classList.toggle("dark", isDarkMode);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // Ignore storage write failures in restricted browser contexts.
    }
  }, [isDarkMode, theme]);

  useEffect(() => {
    let isActive = true;

    const validateToken = async () => {
      if (!token) {
        if (isActive) setAuthReady(true);
        return;
      }

      try {
        const user = await getCurrentUser();
        if (isActive) {
          setCurrentUser(user || null);
          setActiveTab("dashboard");
        }
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
      } finally {
        if (isActive) setAuthReady(true);
      }
    };

    setAuthReady(false);
    validateToken();

    return () => {
      isActive = false;
    };
  }, [token, pushToast, handleLogout]);

  useEffect(() => {
    if (!token || !authReady) return;
    fetchWorkspaceData();
  }, [token, authReady, fetchWorkspaceData]);

  useEffect(() => {
    if (!token || !authReady) return;
    if (status === "completed") {
      fetchWorkspaceData();
    }
  }, [status, token, authReady, fetchWorkspaceData]);

  useEffect(() => {
    let isActive = true;

    const fetchBucketUsageData = async () => {
      if (!token || buckets.length === 0) {
        if (isActive) setBucketUsageByName({});
        return;
      }

      const usageResults = await Promise.allSettled(
        buckets.map(async (bucket) => {
          const usage = await getBucketUsage(bucket.bucket_name);
          return { bucketName: bucket.bucket_name, usage };
        })
      );

      if (!isActive) return;

      const usageMap = {};
      usageResults.forEach((result) => {
        if (result.status !== "fulfilled") return;
        const bucketName = result.value?.bucketName;
        if (!bucketName) return;
        usageMap[bucketName] = result.value.usage;
      });

      setBucketUsageByName(usageMap);
    };

    fetchBucketUsageData();

    return () => {
      isActive = false;
    };
  }, [token, buckets]);

  useEffect(() => {
    if (status !== "completed") {
      completionNoticeShownRef.current = false;
      if (completionRefreshTimerRef.current) {
        window.clearTimeout(completionRefreshTimerRef.current);
        completionRefreshTimerRef.current = null;
      }
      return;
    }

    if (completionNoticeShownRef.current) {
      return;
    }

    completionNoticeShownRef.current = true;
    pushToast(
      "info",
      "Completing Upload",
      "Task is being completed. Upload page will refresh in 5 seconds.",
      COMPLETION_REFRESH_MS,
    );

    completionRefreshTimerRef.current = window.setTimeout(() => {
      setActiveTab("upload");
      handleCancel();
      fetchWorkspaceData();
      completionRefreshTimerRef.current = null;
      completionNoticeShownRef.current = false;
    }, COMPLETION_REFRESH_MS);

    return () => {
      if (completionRefreshTimerRef.current) {
        window.clearTimeout(completionRefreshTimerRef.current);
        completionRefreshTimerRef.current = null;
      }
    };
  }, [status, handleCancel, fetchWorkspaceData, pushToast]);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (!userMenuRef.current) return;
      if (userMenuRef.current.contains(event.target)) return;
      setUserMenuOpen(false);
      setShowUserDetails(false);
    };

    const handleEsc = (event) => {
      if (event.key !== "Escape") return;
      setUserMenuOpen(false);
      setShowUserDetails(false);
    };

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEsc);

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEsc);
    };
  }, []);

  const metrics = useMemo(() => {
    const totalUploadedBytes = history.reduce((acc, record) => acc + Number(record?.size || 0), 0);
    const uniqueUploadBuckets = new Set(history.map((record) => record?.bucket).filter(Boolean)).size;
    const latestUpload = history[0] || null;
    const uploadingNow = status === "uploading" || status === "paused";

    return {
      totalUploadedBytes,
      totalUploads: history.length,
      uniqueUploadBuckets,
      configuredBuckets: buckets.length,
      latestUpload,
      uploadingNow,
    };
  }, [history, buckets.length, status]);

  const dashboardInsights = useMemo(() => {
    const dailyUploadCounts = new Map();
    const uploadPoints = [];

    const bucketStatsMap = new Map();

    history.forEach((record, index) => {
      const createdAt = new Date(record?.created_at || "");
      if (!Number.isNaN(createdAt.getTime())) {
        const dateKey = createdAt.toISOString().slice(0, 10);
        const size = Math.max(0, Number(record?.size || 0));
        dailyUploadCounts.set(dateKey, (dailyUploadCounts.get(dateKey) || 0) + 1);
        uploadPoints.push({
          key: `${record?.id || record?.file_id || "upload"}-${index}`,
          dateKey,
          size,
          createdAtMs: createdAt.getTime(),
          fileName: record?.filename || record?.file_name || "upload",
        });
      }

      const bucketName = record?.bucket || "medivault-bucket";
      const existingBucket = bucketStatsMap.get(bucketName) || { bucket: bucketName, count: 0, bytes: 0 };
      existingBucket.count += 1;
      existingBucket.bytes += Number(record?.size || 0);
      bucketStatsMap.set(bucketName, existingBucket);
    });

    uploadPoints.sort((a, b) => a.createdAtMs - b.createdAtMs || a.size - b.size);

    const now = new Date();
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);

    let minDate = null;
    if (uploadGrowthFilter === "7") {
      minDate = new Date(todayStart);
      minDate.setDate(todayStart.getDate() - 6);
    } else if (uploadGrowthFilter === "30") {
      minDate = new Date(todayStart);
      minDate.setDate(todayStart.getDate() - 29);
    } else if (uploadGrowthFilter === "month") {
      minDate = new Date(todayStart.getFullYear(), todayStart.getMonth(), 1);
    }

    let maxDate = null;
    if (graphFromDate) {
      minDate = new Date(`${graphFromDate}T00:00:00`);
    }
    if (graphToDate) {
      maxDate = new Date(`${graphToDate}T23:59:59.999`);
    }

    if (minDate && maxDate && minDate.getTime() > maxDate.getTime()) {
      const temp = minDate;
      minDate = maxDate;
      maxDate = temp;
    }

    const filteredPoints = uploadPoints.filter((point) => {
      if (minDate && point.createdAtMs < minDate.getTime()) return false;
      if (maxDate && point.createdAtMs > maxDate.getTime()) return false;
      return true;
    });

    const filteredDateKeys = Array.from(new Set(filteredPoints.map((point) => point.dateKey))).sort((a, b) => a.localeCompare(b));

    const maxUploadSize = Math.max(
      ...filteredPoints.map((point) => point.size),
      0,
    );

    const todayKey = now.toISOString().slice(0, 10);
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    const yesterdayKey = yesterday.toISOString().slice(0, 10);

    const lifetimeUploadCount = uploadPoints.length;
    const todayUploadCount = dailyUploadCounts.get(todayKey) || 0;
    const yesterdayUploadCount = dailyUploadCounts.get(yesterdayKey) || 0;
    const xAxisLabelStep = Math.max(1, Math.ceil(Math.max(filteredDateKeys.length, 1) / 8));

    const liveBucketDistribution = buckets
      .map((bucket) => {
        const usage = bucketUsageByName[bucket.bucket_name];
        if (!usage) return null;

        return {
          bucket: bucket.bucket_name,
          used: Math.max(0, Number(usage.used || 0)),
          limit: Math.max(0, Number(usage.limit || 0)),
          percent: Math.max(0, Number(usage.percent || 0)),
          status: usage.status || "ok",
          message: usage.message || "Bucket storage usage is within limit",
          bytes: Math.max(0, Number(usage.used || 0)),
        };
      })
      .filter(Boolean);

    const bucketDistribution = (liveBucketDistribution.length > 0
      ? liveBucketDistribution
      : Array.from(bucketStatsMap.values())
    )
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, 6);
    const maxBucketBytes = bucketDistribution.reduce((max, item) => Math.max(max, item.bytes), 0);

    return {
      points: filteredPoints,
      dateKeys: filteredDateKeys,
      maxUploadSize,
      yesterdayUploadCount,
      todayUploadCount,
      lifetimeUploadCount,
      xAxisLabelStep,
      bucketDistribution,
      maxBucketBytes,
    };
  }, [history, uploadGrowthFilter, graphFromDate, graphToDate, buckets, bucketUsageByName]);

  const filteredHistoryRecords = useMemo(() => {
    const normalizedSearch = historySearchQuery.trim().toLowerCase();

    const searched = history.filter((record) => {
      if (!normalizedSearch) return true;

      const fileName = (record?.filename || record?.file_name || "").toLowerCase();
      const bucketName = (record?.bucket || "").toLowerCase();
      const createdDate = (record?.created_at || "").toLowerCase();

      return fileName.includes(normalizedSearch)
        || bucketName.includes(normalizedSearch)
        || createdDate.includes(normalizedSearch);
    });

    const sorted = [...searched].sort((a, b) => {
      const aCreated = new Date(a?.created_at || 0).getTime();
      const bCreated = new Date(b?.created_at || 0).getTime();
      return bCreated - aCreated;
    });

    return sorted;
  }, [history, historySearchQuery]);

  const totalHistoryPages = Math.max(1, Math.ceil(filteredHistoryRecords.length / HISTORY_PAGE_SIZE));

  const paginatedHistoryRecords = useMemo(() => {
    const startIndex = (historyPage - 1) * HISTORY_PAGE_SIZE;
    return filteredHistoryRecords.slice(startIndex, startIndex + HISTORY_PAGE_SIZE);
  }, [filteredHistoryRecords, historyPage]);

  useEffect(() => {
    setHistoryPage(1);
  }, [historySearchQuery]);

  useEffect(() => {
    if (historyPage > totalHistoryPages) {
      setHistoryPage(totalHistoryPages);
    }
  }, [historyPage, totalHistoryPages]);

  const historyPageStart = filteredHistoryRecords.length === 0
    ? 0
    : (historyPage - 1) * HISTORY_PAGE_SIZE + 1;
  const historyPageEnd = Math.min(historyPage * HISTORY_PAGE_SIZE, filteredHistoryRecords.length);

  const chartPalette = useMemo(() => ({
    axis: isDarkMode ? "rgba(229, 231, 235, 0.45)" : "rgba(116,119,126,0.45)",
    trend: isDarkMode ? "#5eead4" : "#0f766e",
  }), [isDarkMode]);

  const handleBucketFieldChange = useCallback((field, value) => {
    setBucketForm((prev) => {
      const nextForm = { ...prev, [field]: value };
      if (bucketFormTouched[field]) {
        const validationErrors = validateBucketPayload(nextForm);
        setBucketFormErrors((prevErrors) => ({
          ...prevErrors,
          [field]: validationErrors[field],
        }));
      }
      return nextForm;
    });
  }, [bucketFormTouched]);

  const handleBucketFieldBlur = useCallback((field) => {
    setBucketFormTouched((prev) => ({ ...prev, [field]: true }));
    const validationErrors = validateBucketPayload(bucketForm);
    setBucketFormErrors((prevErrors) => ({
      ...prevErrors,
      [field]: validationErrors[field],
    }));
  }, [bucketForm]);

  const handleAddBucket = useCallback(async (event) => {
    event.preventDefault();
    if (bucketSaving) return;

    const payload = {
      bucket_name: bucketForm.bucket_name.trim(),
      region: bucketForm.region.trim(),
      aws_access_key_id: bucketForm.aws_access_key_id.trim(),
      aws_secret_access_key: bucketForm.aws_secret_access_key.trim(),
      size_limit_gb: bucketForm.size_limit_gb,
      use_kms: Boolean(bucketForm.use_kms),
      kms_key_id: `${bucketForm.kms_key_id || ""}`.trim(),
      notes: bucketForm.notes,
    };

    if (!payload.bucket_name || !payload.region || !payload.aws_access_key_id || !payload.aws_secret_access_key || !payload.size_limit_gb) {
      const validationErrors = validateBucketPayload(payload);
      setBucketFormErrors(validationErrors);
      setBucketFormTouched({
        bucket_name: true,
        region: true,
        aws_access_key_id: true,
        aws_secret_access_key: true,
        size_limit_gb: true,
        kms_key_id: true,
        notes: true,
      });
      pushToast("warning", "Validation Required", "Please fix bucket form errors before saving.");
      return;
    }

    const validationErrors = validateBucketPayload(payload);
    if (Object.keys(validationErrors).length > 0) {
      setBucketFormErrors(validationErrors);
      setBucketFormTouched({
        bucket_name: true,
        region: true,
        aws_access_key_id: true,
        aws_secret_access_key: true,
        size_limit_gb: true,
        kms_key_id: true,
        notes: true,
      });
      pushToast("warning", "Validation Required", "Please fix bucket form errors before saving.");
      return;
    }

    const sizeLimitBytes = Math.round(Number(payload.size_limit_gb) * 1024 * 1024 * 1024);

    setBucketSaving(true);
    try {
      const result = await addBucket({
        bucket_name: payload.bucket_name,
        region: payload.region,
        aws_access_key_id: payload.aws_access_key_id,
        aws_secret_access_key: payload.aws_secret_access_key,
        size_limit: sizeLimitBytes,
        use_kms: payload.use_kms,
        kms_key_id: payload.kms_key_id || undefined,
        notes: payload.notes?.trim() || "",
      });
      pushToast("success", "Bucket Saved", result?.message || "Bucket credentials were saved.");
      setBucketForm((prev) => ({
        ...prev,
        bucket_name: "",
        aws_access_key_id: "",
        aws_secret_access_key: "",
        size_limit_gb: "10",
        use_kms: false,
        kms_key_id: "",
        notes: "",
      }));
      setBucketFormErrors({});
      setBucketFormTouched({});
      setBucketAdvancedOpen(false);
      await fetchWorkspaceData();
    } catch (err) {
      pushToast("error", "Bucket Save Failed", getDetailMessage(err, "Could not save bucket credentials."));
    } finally {
      setBucketSaving(false);
    }
  }, [bucketForm, bucketSaving, fetchWorkspaceData, pushToast]);

  const handleDeleteBucket = useCallback(async (bucket) => {
    if (!bucket?.id || bucketDeletingId || bucket.system_default) return;
    setBucketDeleteTarget(bucket);
    setBucketDeleteConfirmText("");
  }, [bucketDeletingId]);

  const handleCloseDeleteBucketModal = useCallback(() => {
    if (bucketDeletingId) return;
    setBucketDeleteTarget(null);
    setBucketDeleteConfirmText("");
  }, [bucketDeletingId]);

  const canConfirmBucketDelete = bucketDeleteConfirmText.trim() === DELETE_BUCKET_CONFIRM_PHRASE;

  const handleConfirmDeleteBucket = useCallback(async () => {
    if (!bucketDeleteTarget?.id || bucketDeletingId || !canConfirmBucketDelete) return;

    setBucketDeletingId(bucketDeleteTarget.id);
    try {
      await deleteBucket(bucketDeleteTarget.id);
      pushToast("success", "Bucket Deleted", "Bucket removed successfully");

      if (selectedUploadBucket === bucketDeleteTarget.bucket_name) {
        setSelectedUploadBucket("");
      }

      await fetchWorkspaceData();
      handleCloseDeleteBucketModal();
    } catch (err) {
      pushToast("error", "Delete Failed", getDetailMessage(err, "Could not delete bucket."));
    } finally {
      setBucketDeletingId(null);
    }
  }, [
    bucketDeleteTarget,
    bucketDeletingId,
    canConfirmBucketDelete,
    fetchWorkspaceData,
    handleCloseDeleteBucketModal,
    pushToast,
    selectedUploadBucket,
  ]);

  const handleOpenEditBucket = useCallback((bucket) => {
    if (!bucket?.id || bucket.system_default) return;

    const sizeLimitGb = Number(bucket.size_limit || 0) > 0
      ? (Number(bucket.size_limit) / BYTES_PER_GB).toFixed(2)
      : "10";

    setBucketEditForm({
      bucket_id: bucket.id,
      bucket_name: bucket.bucket_name || "",
      display_name: bucket.display_name || bucket.bucket_name || "",
      region: bucket.region || "",
      size_limit_gb: sizeLimitGb,
      use_kms: Boolean(bucket.use_kms),
      kms_key_id: bucket.kms_key_id || "",
      notes: bucket.notes || "",
    });
    setBucketEditErrors({});
    setBucketEditTouched({});
    setBucketEditAdvancedOpen(false);
  }, []);

  const handleCloseEditBucket = useCallback(() => {
    if (bucketUpdating) return;
    setBucketEditForm({
      bucket_id: "",
      bucket_name: "",
      display_name: "",
      region: "",
      size_limit_gb: "10",
      use_kms: false,
      kms_key_id: "",
      notes: "",
    });
    setBucketEditErrors({});
    setBucketEditTouched({});
    setBucketEditAdvancedOpen(false);
  }, [bucketUpdating]);

  const handleBucketEditFieldChange = useCallback((field, value) => {
    setBucketEditForm((prev) => {
      const next = { ...prev, [field]: value };
      if (bucketEditTouched[field]) {
        const errors = validateBucketMetadataPayload(next);
        setBucketEditErrors((prevErrors) => ({ ...prevErrors, [field]: errors[field] }));
      }
      return next;
    });
  }, [bucketEditTouched]);

  const handleBucketEditFieldBlur = useCallback((field) => {
    setBucketEditTouched((prev) => ({ ...prev, [field]: true }));
    const errors = validateBucketMetadataPayload(bucketEditForm);
    setBucketEditErrors((prevErrors) => ({ ...prevErrors, [field]: errors[field] }));
  }, [bucketEditForm]);

  const handleSaveBucketEdit = useCallback(async (event) => {
    event.preventDefault();
    if (bucketUpdating || !bucketEditForm.bucket_id) return;

    const payload = {
      display_name: bucketEditForm.display_name.trim(),
      region: bucketEditForm.region.trim(),
      size_limit_gb: bucketEditForm.size_limit_gb,
      use_kms: Boolean(bucketEditForm.use_kms),
      kms_key_id: `${bucketEditForm.kms_key_id || ""}`.trim(),
      notes: bucketEditForm.notes,
    };

    const validationErrors = validateBucketMetadataPayload(payload);
    if (Object.keys(validationErrors).length > 0) {
      setBucketEditErrors(validationErrors);
      setBucketEditTouched({
        display_name: true,
        region: true,
        size_limit_gb: true,
        kms_key_id: true,
        notes: true,
      });
      pushToast("warning", "Validation Required", "Please fix edit form errors before saving.");
      return;
    }

    const sizeLimitBytes = Math.round(Number(payload.size_limit_gb) * BYTES_PER_GB);

    setBucketUpdating(true);
    try {
      await updateBucket(bucketEditForm.bucket_id, {
        display_name: payload.display_name,
        region: payload.region,
        size_limit: sizeLimitBytes,
        use_kms: payload.use_kms,
        kms_key_id: payload.kms_key_id || null,
        notes: payload.notes?.trim() || "",
      });
      pushToast("success", "Bucket Updated", "Bucket updated successfully");
      handleCloseEditBucket();
      await fetchWorkspaceData();
    } catch (err) {
      pushToast("error", "Update Failed", getDetailMessage(err, "Could not update bucket."));
    } finally {
      setBucketUpdating(false);
    }
  }, [bucketEditForm, bucketUpdating, fetchWorkspaceData, handleCloseEditBucket, pushToast]);

  const handleOpenClearHistoryModal = useCallback(() => {
    setShowClearHistoryModal(true);
    setClearHistoryConfirmText("");
  }, []);

  const handleCloseClearHistoryModal = useCallback(() => {
    if (clearingHistory) return;
    setShowClearHistoryModal(false);
    setClearHistoryConfirmText("");
  }, [clearingHistory]);

  const canConfirmClearHistory = clearHistoryConfirmText.trim() === CLEAR_HISTORY_CONFIRM_PHRASE;

  const handleConfirmClearHistory = useCallback(async () => {
    if (!canConfirmClearHistory || clearingHistory) return;

    setClearingHistory(true);
    try {
      const result = await clearUploadHistory();
      const clearedRecords = Number(result?.cleared_records || 0);
      pushToast("success", "History Cleared", `${clearedRecords} record(s) removed from history.`);
      await fetchWorkspaceData();
      handleCloseClearHistoryModal();
    } catch (err) {
      pushToast("error", "Clear History Failed", getDetailMessage(err, "Could not clear history."));
    } finally {
      setClearingHistory(false);
    }
  }, [canConfirmClearHistory, clearingHistory, fetchWorkspaceData, handleCloseClearHistoryModal, pushToast]);

  const renderDataError = dataError ? (
    <div className="rounded-lg border border-error/20 bg-error-container px-4 py-3 text-xs font-semibold text-error">
      {dataError}
    </div>
  ) : null;

  const renderHistoryTable = (records, emptyMessage) => (
    <div className="bg-surface-container-lowest rounded-xl overflow-hidden shadow-[0px_12px_32px_rgba(0,21,42,0.04)]">
      <div className="p-6 border-b border-surface-container-high">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-extrabold tracking-tight text-primary headline">Upload History</h2>
          <div className="flex items-center gap-3">
            <p className="text-xs font-semibold text-on-surface-variant">{filteredHistoryRecords.length} records</p>
            <button
              type="button"
              onClick={handleOpenClearHistoryModal}
              className="rounded-lg bg-error-container text-error px-3 py-1.5 text-xs font-bold disabled:opacity-60"
              disabled={filteredHistoryRecords.length === 0}
            >
              Clear History
            </button>
          </div>
        </div>
        <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-3">
          <input
            type="text"
            className="w-full rounded-lg bg-surface-container-highest border border-surface-container-high px-3 py-2 text-sm"
            placeholder="Search by file, bucket, or date"
            value={historySearchQuery}
            onChange={(event) => setHistorySearchQuery(event.target.value)}
          />
          <select
            className="w-full rounded-lg bg-surface-container-highest border border-surface-container-high px-3 py-2 text-sm"
            value={historySortFilter}
            onChange={(event) => setHistorySortFilter(event.target.value)}
            disabled
          >
            <option value="latest">Latest first</option>
          </select>
        </div>
      </div>
      <FileList
        records={records}
        emptyMessage={emptyMessage}
        onDeleteSuccess={fetchWorkspaceData}
        pushToast={pushToast}
      />
      <div className="px-6 py-3 border-t border-surface-container-high flex items-center justify-end gap-3 text-xs font-semibold text-on-surface-variant">
        <span>{historyPageStart}-{historyPageEnd} of {filteredHistoryRecords.length}</span>
        <button
          type="button"
          onClick={() => setHistoryPage((prev) => Math.max(1, prev - 1))}
          disabled={historyPage <= 1}
          className="rounded-md bg-surface-container-high px-2.5 py-1.5 text-primary disabled:opacity-50"
          aria-label="Previous history page"
          title="Previous"
        >
          <span className="material-symbols-outlined text-base leading-none">chevron_left</span>
        </button>
        <button
          type="button"
          onClick={() => setHistoryPage((prev) => Math.min(totalHistoryPages, prev + 1))}
          disabled={historyPage >= totalHistoryPages}
          className="rounded-md bg-surface-container-high px-2.5 py-1.5 text-primary disabled:opacity-50"
          aria-label="Next history page"
          title="Next"
        >
          <span className="material-symbols-outlined text-base leading-none">chevron_right</span>
        </button>
      </div>
    </div>
  );

  const renderDashboard = () => (
    <main className="flex-1 w-full max-w-[1440px] mx-auto px-6 lg:px-10 py-10 space-y-8">
      {renderDataError}

      <section className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        <div className="bg-surface-container-lowest rounded-xl p-6 shadow-sm border border-surface-container-high">
          <p className="text-xs uppercase tracking-widest font-bold text-on-surface-variant">Total Stored Data</p>
          <p className="mt-2 text-3xl font-extrabold text-primary headline">{formatBytes(metrics.totalUploadedBytes)}</p>
        </div>
        <div className="bg-surface-container-lowest rounded-xl p-6 shadow-sm border border-surface-container-high">
          <p className="text-xs uppercase tracking-widest font-bold text-on-surface-variant">Files Uploaded</p>
          <p className="mt-2 text-3xl font-extrabold text-primary headline">{metrics.totalUploads}</p>
        </div>
        <div className="bg-surface-container-lowest rounded-xl p-6 shadow-sm border border-surface-container-high">
          <p className="text-xs uppercase tracking-widest font-bold text-on-surface-variant">Configured Buckets</p>
          <p className="mt-2 text-3xl font-extrabold text-primary headline">{metrics.configuredBuckets}</p>
        </div>
        <div className="bg-surface-container-lowest rounded-xl p-6 shadow-sm border border-surface-container-high">
          <p className="text-xs uppercase tracking-widest font-bold text-on-surface-variant">Upload Engine</p>
          <p className="mt-2 text-sm font-bold text-primary">
            {metrics.uploadingNow ? `${status.toUpperCase()} (${progress}%)` : "IDLE"}
          </p>
        </div>
      </section>

      <section className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <div className="xl:col-span-2 bg-surface-container-lowest rounded-xl p-6 border border-surface-container-high shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-sm font-bold text-primary headline">Upload Size (Lifetime)</h3>
            <div className="flex flex-wrap items-center gap-2">
              <select
                id="filter"
                className="rounded-md bg-surface-container-highest border border-surface-container-high px-2.5 py-1.5 text-xs font-semibold text-on-surface"
                value={uploadGrowthFilter}
                onChange={(event) => setUploadGrowthFilter(event.target.value)}
              >
                <option value="7">Last 7 days</option>
                <option value="30">Last 30 days</option>
                <option value="month">This month</option>
                <option value="all">All time</option>
              </select>
              <input
                type="date"
                className="rounded-md bg-surface-container-highest border border-surface-container-high px-2.5 py-1.5 text-xs font-semibold text-on-surface"
                value={graphFromDate}
                onChange={(event) => setGraphFromDate(event.target.value)}
                aria-label="Graph start date"
              />
              <input
                type="date"
                className="rounded-md bg-surface-container-highest border border-surface-container-high px-2.5 py-1.5 text-xs font-semibold text-on-surface"
                value={graphToDate}
                onChange={(event) => setGraphToDate(event.target.value)}
                aria-label="Graph end date"
              />
            </div>
          </div>
          {dashboardInsights.points.length === 0 ? (
            <p className="mt-6 text-sm font-medium text-on-surface-variant">
              No uploads recorded yet.
            </p>
          ) : (
            <div className="mt-6 space-y-3">
              <div className="w-full rounded-lg bg-surface-container-low p-3">
                {(() => {
                  const chartWidth = 700;
                  const chartHeight = 180;
                  const leftPadding = 24;
                  const rightPadding = 18;
                  const topPadding = 14;
                  const bottomPadding = 20;
                  const usableWidth = chartWidth - leftPadding - rightPadding;
                  const usableHeight = chartHeight - topPadding - bottomPadding;
                  const divisor = Math.max(dashboardInsights.maxUploadSize, 1);
                  const dateIndexMap = new Map(dashboardInsights.dateKeys.map((dateKey, index) => [dateKey, index]));

                  const points = dashboardInsights.points.map((point) => {
                    const dateIndex = dateIndexMap.get(point.dateKey) || 0;
                    const x = leftPadding + (dateIndex * usableWidth) / Math.max(dashboardInsights.dateKeys.length - 1, 1);
                    const y = topPadding + ((divisor - point.size) / divisor) * usableHeight;
                    return { ...point, x, y };
                  });

                  const trendPath = points
                    .map((point, index) => `${index === 0 ? "M" : "L"}${point.x} ${point.y}`)
                    .join(" ");

                  return (
                    <svg className="w-full h-[200px]" viewBox={`0 0 ${chartWidth} ${chartHeight}`} role="img" aria-label="Upload size by date chart">
                      <line x1={leftPadding} y1={chartHeight - bottomPadding} x2={chartWidth - rightPadding} y2={chartHeight - bottomPadding} stroke={chartPalette.axis} strokeWidth="1" />

                      {points.length > 1 ? (
                        <path
                          d={trendPath}
                          fill="none"
                          stroke={chartPalette.trend}
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          opacity="0.75"
                        />
                      ) : null}

                      {points.map((point) => (
                        <g key={point.key}>
                          <circle cx={point.x} cy={point.y} r="3.2" fill={chartPalette.trend} />
                          <title>{`${formatBytes(point.size)} on ${point.dateKey}`}</title>
                        </g>
                      ))}
                    </svg>
                  );
                })()}
              </div>

              <div className="flex items-center gap-4 text-[11px] font-bold text-on-surface-variant">
                <div className="flex items-center gap-2">
                  <span className="inline-block w-3 h-3 rounded-full" style={{ backgroundColor: chartPalette.trend }}></span>
                  <span>Each dot = one upload</span>
                </div>
              </div>

              <div className="flex items-center justify-between px-1">
                {dashboardInsights.dateKeys
                  .filter((_, index) => index % dashboardInsights.xAxisLabelStep === 0 || index === dashboardInsights.dateKeys.length - 1)
                  .map((point) => (
                  <div key={point} className="text-center">
                    <p className="text-[10px] font-semibold text-on-surface-variant">{point}</p>
                  </div>
                ))}
              </div>

              <div className="text-xs font-semibold text-on-surface-variant space-y-1">
                <p>Total uploads (lifetime): {dashboardInsights.lifetimeUploadCount}</p>
                <p>Today total uploads: {dashboardInsights.todayUploadCount}</p>
                <p>Yesterday total uploads: {dashboardInsights.yesterdayUploadCount}</p>
              </div>
            </div>
          )}
        </div>

        <div className="space-y-4">
          <div className="bg-surface-container-lowest rounded-xl p-6 border border-surface-container-high shadow-sm">
            <h3 className="text-sm font-bold text-primary headline">Bucket Distribution</h3>
            {dashboardInsights.bucketDistribution.length === 0 ? (
              <p className="mt-4 text-xs font-medium text-on-surface-variant">No bucket usage yet.</p>
            ) : (
              <div className="mt-4 space-y-3">
                {dashboardInsights.bucketDistribution.map((item) => {
                  const hasPercent = Number.isFinite(item.percent);
                  const widthPercent = hasPercent
                    ? Math.max(4, Math.min(100, item.percent))
                    : dashboardInsights.maxBucketBytes > 0
                      ? Math.max(8, Math.round((item.bytes / dashboardInsights.maxBucketBytes) * 100))
                      : 8;

                  const usageText = Number.isFinite(item.limit) && item.limit > 0
                    ? `${formatBytes(item.used || item.bytes)} / ${formatBytes(item.limit)}`
                    : `${formatBytes(item.bytes)} / -`;

                  const percentText = hasPercent ? `${item.percent.toFixed(1)}%` : "-";

                  const barClass = item.status === "exceeded"
                    ? "bg-error"
                    : item.status === "warning"
                      ? "bg-warning"
                      : "bg-teal-600";

                  const messageClass = item.status === "exceeded"
                    ? "text-error"
                    : item.status === "warning"
                      ? "text-warning"
                      : "text-on-surface-variant";

                  return (
                    <div key={item.bucket}>
                      <div className="flex items-center justify-between text-[10px] font-bold text-on-surface-variant mb-1">
                        <span className="truncate max-w-[160px]" title={item.bucket}>{item.bucket}</span>
                        <span>{usageText}</span>
                      </div>
                      <div className="flex items-center justify-between text-[10px] font-bold text-on-surface-variant mb-1">
                        <span>{percentText}</span>
                      </div>
                      <div className="h-2 rounded bg-surface-container-low overflow-hidden">
                        <div className={`h-full rounded ${barClass}`} style={{ width: `${widthPercent}%` }}></div>
                      </div>
                      {item.message ? (
                        <p className={`mt-1 text-[10px] font-semibold ${messageClass}`}>{item.message}</p>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="bg-surface-container-lowest rounded-xl p-6 border border-surface-container-high shadow-sm">
            <h3 className="text-sm font-bold text-primary headline">Vault Status</h3>
            <div className="mt-4 space-y-2 text-xs text-on-surface-variant font-semibold">
              <div className="flex justify-between">
                <span>Buckets with uploads</span>
                <span>{metrics.uniqueUploadBuckets}</span>
              </div>
              <div className="flex justify-between">
                <span>Configured buckets</span>
                <span>{metrics.configuredBuckets}</span>
              </div>
              <div className="flex justify-between">
                <span>Most recent upload</span>
                <span>{metrics.latestUpload ? formatDate(metrics.latestUpload.created_at) : "-"}</span>
              </div>
            </div>
          </div>

          <div className="bg-surface-container-lowest rounded-xl p-6 border border-surface-container-high shadow-sm">
            <h3 className="text-sm font-bold text-primary headline">Quick Actions</h3>
            <div className="mt-4 flex flex-col gap-3">
              <button
                type="button"
                className="w-full rounded-lg bg-primary text-on-primary text-xs font-bold py-2.5"
                onClick={() => setActiveTab("upload")}
              >
                Go To Upload
              </button>
              <button
                type="button"
                className="w-full rounded-lg bg-surface-container-high text-primary text-xs font-bold py-2.5"
                onClick={() => setActiveTab("history")}
              >
                Open History
              </button>
              <button
                type="button"
                className="w-full rounded-lg bg-surface-container-high text-primary text-xs font-bold py-2.5"
                onClick={() => setActiveTab("buckets")}
              >
                Manage Buckets
              </button>
            </div>
          </div>
        </div>
      </section>
    </main>
  );

  const renderUploadCenter = () => (
    <main className="flex-1 w-full max-w-[1440px] mx-auto px-6 lg:px-10 py-10">
      {renderDataError}

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 mt-4">
        <section className="xl:col-span-8 space-y-6">
          <div>
            <h1 className="text-3xl font-extrabold tracking-tighter headline text-primary">Upload Center</h1>
            <p className="text-sm text-on-surface-variant font-medium mt-1">Upload files or folders with resumable chunk transfer.</p>
          </div>

          <div className="bg-surface-container-lowest rounded-xl p-4 border border-surface-container-high shadow-sm space-y-3">
            <label className="block text-xs font-bold uppercase tracking-widest text-on-surface-variant">Upload Target Bucket</label>
            <select
              className="w-full rounded-lg bg-surface-container-highest border-none px-3 py-2.5 text-sm"
              value={selectedUploadBucket}
              onChange={(event) => setSelectedUploadBucket(event.target.value)}
            >
              <option value="">None</option>
              {buckets.filter((bucket) => !bucket.system_default).map((bucket) => (
                <option key={bucket.id} value={bucket.bucket_name}>
                  {bucket.bucket_name} ({bucket.region || "-"})
                </option>
              ))}
            </select>
            <p className="text-xs text-on-surface-variant font-medium">
              New uploads will use the selected bucket. Resume uploads continue in their original bucket.
            </p>
          </div>

          <FileUploader
            file={file}
            onFileSelect={handleFileSelect}
            onFolderSelect={handleFolderSelect}
            status={status}
            onUpload={handleUpload}
            onPause={pause}
            onResume={handleResumeUpload}
            onCancel={handleCancel}
            onPreview={() => setShowPreview(true)}
            isPreparingFolder={isPreparingFolder}
          />

          <UploadStatus
            status={status}
            error={error}
            networkType={networkType}
            displayChunkMB={displayChunkMB}
            etaDisplay={etaDisplay}
            targetBucketName={activeUploadBucketLabel}
          />

          {(status === "uploading" || status === "paused" || status === "completed") && (
            <ProgressTracker
              progress={progress}
              chunkStatuses={chunkStatuses}
              status={status}
            />
          )}
        </section>

        <aside className="xl:col-span-4 space-y-4">
          <div className="bg-surface-container-lowest rounded-xl p-6 border border-surface-container-high shadow-sm">
            <h3 className="text-sm font-bold text-primary headline">Live Vault Metrics</h3>
            <div className="mt-4 space-y-3 text-xs font-semibold text-on-surface-variant">
              <div className="flex justify-between">
                <span>Total stored</span>
                <span>{formatBytes(metrics.totalUploadedBytes)}</span>
              </div>
              <div className="flex justify-between">
                <span>Total uploads</span>
                <span>{metrics.totalUploads}</span>
              </div>
              <div className="flex justify-between">
                <span>Configured buckets</span>
                <span>{metrics.configuredBuckets}</span>
              </div>
            </div>
          </div>

          <div className="bg-surface-container-lowest rounded-xl p-6 border border-surface-container-high shadow-sm">
            <h3 className="text-sm font-bold text-primary headline">Latest Activity</h3>
            {metrics.latestUpload ? (
              <div className="mt-4 text-xs font-medium text-on-surface-variant space-y-2">
                <p className="text-sm font-semibold text-primary truncate" title={metrics.latestUpload.filename}>{metrics.latestUpload.filename}</p>
                <p>Bucket: {metrics.latestUpload.bucket || "medivault-bucket"}</p>
                <p>Size: {formatBytes(Number(metrics.latestUpload.size || 0))}</p>
                <p>Time: {formatDate(metrics.latestUpload.created_at)}</p>
              </div>
            ) : (
              <p className="mt-4 text-xs text-on-surface-variant font-semibold">No upload history available yet.</p>
            )}
          </div>

          <div className="bg-surface-container-lowest rounded-xl p-6 border border-surface-container-high shadow-sm">
            <h3 className="text-sm font-bold text-primary headline">Network Status</h3>
            {status === "uploading" ? (
              <div className="mt-4 space-y-2 text-xs font-semibold text-on-surface-variant">
                <div className="flex justify-between">
                  <span>Speed</span>
                  <span>{Number.isFinite(avgUploadSpeedMB) ? `${avgUploadSpeedMB.toFixed(2)} MB/s` : "Calculating..."}</span>
                </div>
                <div className="flex justify-between">
                  <span>Status</span>
                  <span>
                    {networkType === "Slow" ? "Slow 🐢" : networkType === "Medium" ? "Medium ⚡" : "Fast 🚀"}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>Adaptive Mode</span>
                  <span>ON</span>
                </div>
              </div>
            ) : (
              <p className="mt-4 text-xs font-semibold text-on-surface-variant">Idle</p>
            )}
          </div>
        </aside>
      </div>
    </main>
  );

  const renderBuckets = () => (
    <main className="flex-1 w-full max-w-[1440px] mx-auto px-6 lg:px-10 py-10 space-y-6">
      {renderDataError}

      <div>
        <h1 className="text-3xl font-extrabold tracking-tighter headline text-primary">Buckets</h1>
        <p className="text-sm text-on-surface-variant font-medium mt-1">Validate and save S3 bucket credentials for this account.</p>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">
        <section className="xl:col-span-5 bg-surface-container-lowest rounded-xl p-6 border border-surface-container-high shadow-sm">
          <h2 className="text-lg font-bold text-primary headline">Add Bucket</h2>
          <form className="mt-4 space-y-4" onSubmit={handleAddBucket}>
            <div>
              <label className="block text-xs font-bold uppercase tracking-widest text-on-surface-variant mb-1">Bucket Name</label>
              <input
                className={`w-full rounded-lg bg-surface-container-highest px-3 py-2.5 text-sm ${bucketFormTouched.bucket_name && bucketFormErrors.bucket_name ? "border border-error" : "border border-transparent"}`}
                value={bucketForm.bucket_name}
                onChange={(event) => handleBucketFieldChange("bucket_name", event.target.value)}
                onBlur={() => handleBucketFieldBlur("bucket_name")}
                placeholder="my-medical-bucket"
              />
              <p className="mt-1 text-[11px] text-on-surface-variant font-medium">Example: medivault-bucket-001</p>
              {bucketFormTouched.bucket_name && bucketFormErrors.bucket_name ? (
                <p className="mt-1 text-[11px] text-error font-semibold">{bucketFormErrors.bucket_name}</p>
              ) : null}
            </div>

            <div>
              <label className="block text-xs font-bold uppercase tracking-widest text-on-surface-variant mb-1">Region</label>
              <input
                className={`w-full rounded-lg bg-surface-container-highest px-3 py-2.5 text-sm ${bucketFormTouched.region && bucketFormErrors.region ? "border border-error" : "border border-transparent"}`}
                value={bucketForm.region}
                onChange={(event) => handleBucketFieldChange("region", event.target.value)}
                onBlur={() => handleBucketFieldBlur("region")}
                placeholder="ap-south-1"
                list="aws-region-suggestions"
              />
              <datalist id="aws-region-suggestions">
                <option value="ap-south-1" />
                <option value="ap-southeast-1" />
                <option value="us-east-1" />
                <option value="us-west-2" />
                <option value="eu-west-1" />
              </datalist>
              {bucketFormTouched.region && bucketFormErrors.region ? (
                <p className="mt-1 text-[11px] text-error font-semibold">{bucketFormErrors.region}</p>
              ) : null}
            </div>

            <div>
              <label className="block text-xs font-bold uppercase tracking-widest text-on-surface-variant mb-1">Size Limit (GB)</label>
              <input
                type="number"
                min="1"
                step="1"
                className={`w-full rounded-lg bg-surface-container-highest px-3 py-2.5 text-sm ${bucketFormTouched.size_limit_gb && bucketFormErrors.size_limit_gb ? "border border-error" : "border border-transparent"}`}
                value={bucketForm.size_limit_gb}
                onChange={(event) => handleBucketFieldChange("size_limit_gb", event.target.value)}
                onBlur={() => handleBucketFieldBlur("size_limit_gb")}
                placeholder="10"
              />
              {bucketFormTouched.size_limit_gb && bucketFormErrors.size_limit_gb ? (
                <p className="mt-1 text-[11px] text-error font-semibold">{bucketFormErrors.size_limit_gb}</p>
              ) : null}
            </div>

            <div>
              <label className="block text-xs font-bold uppercase tracking-widest text-on-surface-variant mb-1">AWS Access Key ID</label>
              <input
                className={`w-full rounded-lg bg-surface-container-highest px-3 py-2.5 text-sm ${bucketFormTouched.aws_access_key_id && bucketFormErrors.aws_access_key_id ? "border border-error" : "border border-transparent"}`}
                value={bucketForm.aws_access_key_id}
                onChange={(event) => handleBucketFieldChange("aws_access_key_id", event.target.value)}
                onBlur={() => handleBucketFieldBlur("aws_access_key_id")}
                placeholder="AKIA..."
              />
              {bucketFormTouched.aws_access_key_id && bucketFormErrors.aws_access_key_id ? (
                <p className="mt-1 text-[11px] text-error font-semibold">{bucketFormErrors.aws_access_key_id}</p>
              ) : null}
            </div>

            <div>
              <label className="block text-xs font-bold uppercase tracking-widest text-on-surface-variant mb-1">AWS Secret Access Key</label>
              <input
                type="password"
                className={`w-full rounded-lg bg-surface-container-highest px-3 py-2.5 text-sm ${bucketFormTouched.aws_secret_access_key && bucketFormErrors.aws_secret_access_key ? "border border-error" : "border border-transparent"}`}
                value={bucketForm.aws_secret_access_key}
                onChange={(event) => handleBucketFieldChange("aws_secret_access_key", event.target.value)}
                onBlur={() => handleBucketFieldBlur("aws_secret_access_key")}
                placeholder="Secret key"
              />
              {bucketFormTouched.aws_secret_access_key && bucketFormErrors.aws_secret_access_key ? (
                <p className="mt-1 text-[11px] text-error font-semibold">{bucketFormErrors.aws_secret_access_key}</p>
              ) : null}
            </div>

            <div className="border border-surface-container-high rounded-lg overflow-hidden">
              <button
                type="button"
                onClick={() => setBucketAdvancedOpen((prev) => !prev)}
                className="w-full flex items-center justify-between px-3 py-2.5 text-xs font-bold uppercase tracking-widest text-on-surface-variant bg-surface-container-low"
              >
                <span>Advanced Options</span>
                <span>{bucketAdvancedOpen ? "Hide" : "Show"}</span>
              </button>
              {bucketAdvancedOpen ? (
                <div className="p-3 space-y-3 bg-surface-container-lowest">
                  <label className="flex items-center justify-between gap-3 text-xs font-semibold text-on-surface">
                    <span>Enable KMS Encryption</span>
                    <input
                      type="checkbox"
                      checked={Boolean(bucketForm.use_kms)}
                      onChange={(event) => handleBucketFieldChange("use_kms", event.target.checked)}
                    />
                  </label>

                  <div>
                    <label className="block text-xs font-bold uppercase tracking-widest text-on-surface-variant mb-1">KMS Key ID / ARN</label>
                    <input
                      className={`w-full rounded-lg bg-surface-container-highest px-3 py-2.5 text-sm ${bucketFormTouched.kms_key_id && bucketFormErrors.kms_key_id ? "border border-error" : "border border-transparent"}`}
                      value={bucketForm.kms_key_id}
                      onChange={(event) => handleBucketFieldChange("kms_key_id", event.target.value)}
                      onBlur={() => handleBucketFieldBlur("kms_key_id")}
                      placeholder="arn:aws:kms:region:account:key/..."
                    />
                    {bucketFormTouched.kms_key_id && bucketFormErrors.kms_key_id ? (
                      <p className="mt-1 text-[11px] text-error font-semibold">{bucketFormErrors.kms_key_id}</p>
                    ) : null}
                  </div>

                  <div>
                    <label className="block text-xs font-bold uppercase tracking-widest text-on-surface-variant mb-1">Notes (optional)</label>
                    <textarea
                      rows={3}
                      className={`w-full rounded-lg bg-surface-container-highest px-3 py-2.5 text-sm ${bucketFormTouched.notes && bucketFormErrors.notes ? "border border-error" : "border border-transparent"}`}
                      value={bucketForm.notes}
                      onChange={(event) => handleBucketFieldChange("notes", event.target.value)}
                      onBlur={() => handleBucketFieldBlur("notes")}
                      placeholder="Internal notes about this bucket"
                    />
                    {bucketFormTouched.notes && bucketFormErrors.notes ? (
                      <p className="mt-1 text-[11px] text-error font-semibold">{bucketFormErrors.notes}</p>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>

            <button
              type="submit"
              disabled={bucketSaving}
              className="w-full rounded-lg bg-primary text-on-primary py-2.5 text-sm font-bold disabled:opacity-60"
            >
              {bucketSaving ? "Saving..." : "Validate And Save Bucket"}
            </button>
          </form>
        </section>

        <section className="xl:col-span-7 bg-surface-container-lowest rounded-xl border border-surface-container-high shadow-sm overflow-hidden">
          <div className="px-6 py-4 border-b border-surface-container-high">
            <h2 className="text-lg font-bold text-primary headline">Saved Buckets ({buckets.length})</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="text-[10px] uppercase tracking-widest text-on-surface-variant bg-surface-container-low/50">
                  <th className="px-6 py-4">Bucket</th>
                  <th className="px-6 py-4">Region</th>
                  <th className="px-6 py-4">Validation</th>
                  <th className="px-6 py-4 text-right">Actions</th>
                  <th className="px-6 py-4 text-right">Added At</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-container-high/50">
                {buckets.length === 0 ? (
                  <tr>
                    <td colSpan="5" className="px-6 py-10 text-sm text-on-surface-variant text-center font-medium">
                      No buckets have been saved yet.
                    </td>
                  </tr>
                ) : (
                  buckets.map((bucket) => (
                    <tr key={bucket.id} className="hover:bg-surface-container-low/30 transition-colors">
                      <td className="px-6 py-5 text-sm font-semibold text-primary">
                        <div>{bucket.display_name || bucket.bucket_name}</div>
                        <p className="mt-0.5 text-[11px] font-medium text-on-surface-variant">{bucket.bucket_name}</p>
                        {(() => {
                          const usage = bucketUsageByName[bucket.bucket_name];
                          const usedBytes = Number(usage?.used || 0);
                          const limitBytes = Number(usage?.limit || bucket.size_limit || 0);
                          const rawPercent = Number(usage?.percent || 0);
                          const clampedPercent = Math.max(0, Math.min(rawPercent, 100));
                          const status = usage?.status || "ok";

                          const barClass = status === "exceeded"
                            ? "bg-error"
                            : status === "warning"
                              ? "bg-warning"
                              : "bg-teal-600";

                          const messageClass = status === "exceeded"
                            ? "text-error"
                            : status === "warning"
                              ? "text-warning"
                              : "text-on-surface-variant";

                          return (
                            <div className="mt-2 space-y-1">
                              <div className="flex items-center justify-between text-[11px] font-semibold text-on-surface-variant">
                                <span>{formatBytes(usedBytes)} / {formatBytes(limitBytes)}</span>
                                <span>{rawPercent.toFixed(1)}%</span>
                              </div>
                              <div className="h-2 rounded bg-surface-container-low overflow-hidden">
                                <div className={`h-full rounded ${barClass}`} style={{ width: `${clampedPercent}%` }}></div>
                              </div>
                              {usage?.message ? (
                                <p className={`text-[11px] font-semibold ${messageClass}`}>{usage.message}</p>
                              ) : null}
                            </div>
                          );
                        })()}
                      </td>
                      <td className="px-6 py-5 text-xs font-bold uppercase tracking-wide text-on-surface-variant">{bucket.region || "-"}</td>
                      <td className="px-6 py-5 text-xs font-bold uppercase tracking-wide">
                        {bucket.validation_status && bucket.validation_status !== "verified" ? (
                          <span className="text-warning">Pending AWS Validation</span>
                        ) : (
                          <span className="text-teal-600">Verified</span>
                        )}
                      </td>
                      <td className="px-6 py-5 text-right">
                        <div className="inline-flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => handleOpenEditBucket(bucket)}
                            disabled={bucket.system_default || bucketUpdating}
                            className="rounded-lg bg-surface-container-high text-primary px-3 py-1.5 text-xs font-bold disabled:opacity-60"
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDeleteBucket(bucket)}
                            disabled={bucket.system_default || bucketDeletingId === bucket.id}
                            className="rounded-lg bg-error-container text-error px-3 py-1.5 text-xs font-bold disabled:opacity-60"
                          >
                            {bucket.system_default ? "Locked" : bucketDeletingId === bucket.id ? "Deleting..." : "Delete"}
                          </button>
                        </div>
                      </td>
                      <td className="px-6 py-5 text-xs text-on-surface-variant text-right font-medium">{formatDate(bucket.created_at)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      {bucketDeleteTarget ? (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/35 px-4">
          <div className="w-full max-w-md rounded-xl bg-surface-container-lowest border border-surface-container-high shadow-xl p-6">
            <h3 className="text-lg font-bold text-primary headline">Confirm Bucket Removal</h3>
            <p className="mt-2 text-sm font-medium text-on-surface-variant">
              This will remove the bucket configuration from MediVault.
              It will not delete the actual AWS bucket or stored files.
            </p>
            <p className="mt-3 text-xs font-semibold text-on-surface-variant">
              Type "{DELETE_BUCKET_CONFIRM_PHRASE}" to confirm.
            </p>

            <input
              className="mt-2 w-full rounded-lg bg-surface-container-highest px-3 py-2.5 text-sm border border-surface-container-high"
              value={bucketDeleteConfirmText}
              onChange={(event) => setBucketDeleteConfirmText(event.target.value)}
              placeholder={DELETE_BUCKET_CONFIRM_PHRASE}
            />

            {bucketDeleteConfirmText.length > 0 && !canConfirmBucketDelete ? (
              <p className="mt-1 text-[11px] text-error font-semibold">Please type Delete Bucket exactly</p>
            ) : null}

            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={handleCloseDeleteBucketModal}
                disabled={Boolean(bucketDeletingId)}
                className="rounded-lg bg-surface-container-high text-primary px-4 py-2 text-xs font-bold disabled:opacity-60"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmDeleteBucket}
                disabled={!canConfirmBucketDelete || bucketDeletingId === bucketDeleteTarget.id}
                className="rounded-lg bg-error-container text-error px-4 py-2 text-xs font-bold disabled:opacity-60"
              >
                {bucketDeletingId === bucketDeleteTarget.id ? "Deleting..." : "Delete"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {bucketEditForm.bucket_id ? (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/35 px-4">
          <div className="w-full max-w-lg rounded-xl bg-surface-container-lowest border border-surface-container-high shadow-xl p-6">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-lg font-bold text-primary headline">Edit Bucket</h3>
                <p className="mt-1 text-xs font-medium text-on-surface-variant">Update saved bucket metadata.</p>
              </div>
              <button
                type="button"
                onClick={handleCloseEditBucket}
                disabled={bucketUpdating}
                className="rounded-lg bg-surface-container-high px-2.5 py-1 text-xs font-bold text-primary disabled:opacity-60"
              >
                Close
              </button>
            </div>

            <form className="mt-4 space-y-4" onSubmit={handleSaveBucketEdit}>
              <div>
                <label className="block text-xs font-bold uppercase tracking-widest text-on-surface-variant mb-1">Bucket Name</label>
                <input
                  readOnly
                  className="w-full rounded-lg bg-surface-container-highest px-3 py-2.5 text-sm border border-surface-container-high text-on-surface-variant"
                  value={bucketEditForm.bucket_name}
                />
              </div>

              <div>
                <label className="block text-xs font-bold uppercase tracking-widest text-on-surface-variant mb-1">Display Name</label>
                <input
                  className={`w-full rounded-lg bg-surface-container-highest px-3 py-2.5 text-sm ${bucketEditTouched.display_name && bucketEditErrors.display_name ? "border border-error" : "border border-transparent"}`}
                  value={bucketEditForm.display_name}
                  onChange={(event) => handleBucketEditFieldChange("display_name", event.target.value)}
                  onBlur={() => handleBucketEditFieldBlur("display_name")}
                  placeholder="My Team Bucket"
                />
                {bucketEditTouched.display_name && bucketEditErrors.display_name ? (
                  <p className="mt-1 text-[11px] text-error font-semibold">{bucketEditErrors.display_name}</p>
                ) : null}
              </div>

              <div>
                <label className="block text-xs font-bold uppercase tracking-widest text-on-surface-variant mb-1">Region</label>
                <input
                  className={`w-full rounded-lg bg-surface-container-highest px-3 py-2.5 text-sm ${bucketEditTouched.region && bucketEditErrors.region ? "border border-error" : "border border-transparent"}`}
                  value={bucketEditForm.region}
                  onChange={(event) => handleBucketEditFieldChange("region", event.target.value)}
                  onBlur={() => handleBucketEditFieldBlur("region")}
                  placeholder="ap-south-1"
                  list="aws-region-suggestions"
                />
                {bucketEditTouched.region && bucketEditErrors.region ? (
                  <p className="mt-1 text-[11px] text-error font-semibold">{bucketEditErrors.region}</p>
                ) : null}
              </div>

              <div>
                <label className="block text-xs font-bold uppercase tracking-widest text-on-surface-variant mb-1">Size Limit (GB)</label>
                <input
                  type="number"
                  min="1"
                  step="0.01"
                  className={`w-full rounded-lg bg-surface-container-highest px-3 py-2.5 text-sm ${bucketEditTouched.size_limit_gb && bucketEditErrors.size_limit_gb ? "border border-error" : "border border-transparent"}`}
                  value={bucketEditForm.size_limit_gb}
                  onChange={(event) => handleBucketEditFieldChange("size_limit_gb", event.target.value)}
                  onBlur={() => handleBucketEditFieldBlur("size_limit_gb")}
                  placeholder="10"
                />
                {bucketEditTouched.size_limit_gb && bucketEditErrors.size_limit_gb ? (
                  <p className="mt-1 text-[11px] text-error font-semibold">{bucketEditErrors.size_limit_gb}</p>
                ) : null}
              </div>

              <div className="border border-surface-container-high rounded-lg overflow-hidden">
                <button
                  type="button"
                  onClick={() => setBucketEditAdvancedOpen((prev) => !prev)}
                  className="w-full flex items-center justify-between px-3 py-2.5 text-xs font-bold uppercase tracking-widest text-on-surface-variant bg-surface-container-low"
                >
                  <span>Advanced Options</span>
                  <span>{bucketEditAdvancedOpen ? "Hide" : "Show"}</span>
                </button>
                {bucketEditAdvancedOpen ? (
                  <div className="p-3 space-y-3 bg-surface-container-lowest">
                    <label className="flex items-center justify-between gap-3 text-xs font-semibold text-on-surface">
                      <span>Enable KMS Encryption</span>
                      <input
                        type="checkbox"
                        checked={Boolean(bucketEditForm.use_kms)}
                        onChange={(event) => handleBucketEditFieldChange("use_kms", event.target.checked)}
                      />
                    </label>

                    <div>
                      <label className="block text-xs font-bold uppercase tracking-widest text-on-surface-variant mb-1">KMS Key ID / ARN</label>
                      <input
                        className={`w-full rounded-lg bg-surface-container-highest px-3 py-2.5 text-sm ${bucketEditTouched.kms_key_id && bucketEditErrors.kms_key_id ? "border border-error" : "border border-transparent"}`}
                        value={bucketEditForm.kms_key_id}
                        onChange={(event) => handleBucketEditFieldChange("kms_key_id", event.target.value)}
                        onBlur={() => handleBucketEditFieldBlur("kms_key_id")}
                        placeholder="arn:aws:kms:region:account:key/..."
                      />
                      {bucketEditTouched.kms_key_id && bucketEditErrors.kms_key_id ? (
                        <p className="mt-1 text-[11px] text-error font-semibold">{bucketEditErrors.kms_key_id}</p>
                      ) : null}
                    </div>

                    <div>
                      <label className="block text-xs font-bold uppercase tracking-widest text-on-surface-variant mb-1">Notes (optional)</label>
                      <textarea
                        rows={3}
                        className={`w-full rounded-lg bg-surface-container-highest px-3 py-2.5 text-sm ${bucketEditTouched.notes && bucketEditErrors.notes ? "border border-error" : "border border-transparent"}`}
                        value={bucketEditForm.notes}
                        onChange={(event) => handleBucketEditFieldChange("notes", event.target.value)}
                        onBlur={() => handleBucketEditFieldBlur("notes")}
                        placeholder="Internal notes about this bucket"
                      />
                      {bucketEditTouched.notes && bucketEditErrors.notes ? (
                        <p className="mt-1 text-[11px] text-error font-semibold">{bucketEditErrors.notes}</p>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </div>

              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={handleCloseEditBucket}
                  disabled={bucketUpdating}
                  className="rounded-lg bg-surface-container-high text-primary px-4 py-2 text-xs font-bold disabled:opacity-60"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={bucketUpdating}
                  className="rounded-lg bg-primary text-on-primary px-4 py-2 text-xs font-bold disabled:opacity-60"
                >
                  {bucketUpdating ? "Saving..." : "Save Changes"}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </main>
  );

  const renderHistory = () => (
    <main className="flex-1 w-full max-w-[1440px] mx-auto px-6 lg:px-10 py-10 space-y-6">
      {renderDataError}
      <div>
        <h1 className="text-3xl font-extrabold tracking-tighter headline text-primary">History</h1>
        <p className="text-sm text-on-surface-variant font-medium mt-1">Complete upload records from server data.</p>
      </div>
      {renderHistoryTable(paginatedHistoryRecords, "No upload records found for the selected search/filter.")}

      {showClearHistoryModal ? (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/35 px-4">
          <div className="w-full max-w-md rounded-xl bg-surface-container-lowest border border-surface-container-high shadow-xl p-6">
            <h3 className="text-lg font-bold text-primary headline">Clear Upload History</h3>
            <p className="mt-2 text-sm font-medium text-on-surface-variant">
              This removes history records from MediVault. It does not delete objects from S3.
            </p>
            <p className="mt-3 text-xs font-semibold text-on-surface-variant">
              Type "{CLEAR_HISTORY_CONFIRM_PHRASE}" to confirm.
            </p>
            <input
              className="mt-2 w-full rounded-lg bg-surface-container-highest px-3 py-2.5 text-sm border border-surface-container-high"
              value={clearHistoryConfirmText}
              onChange={(event) => setClearHistoryConfirmText(event.target.value)}
              placeholder={CLEAR_HISTORY_CONFIRM_PHRASE}
            />
            {clearHistoryConfirmText.length > 0 && !canConfirmClearHistory ? (
              <p className="mt-1 text-[11px] text-error font-semibold">Please type Clear History exactly</p>
            ) : null}

            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={handleCloseClearHistoryModal}
                disabled={clearingHistory}
                className="rounded-lg bg-surface-container-high text-primary px-4 py-2 text-xs font-bold disabled:opacity-60"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmClearHistory}
                disabled={!canConfirmClearHistory || clearingHistory}
                className="rounded-lg bg-error-container text-error px-4 py-2 text-xs font-bold disabled:opacity-60"
              >
                {clearingHistory ? "Clearing..." : "Clear"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );

  const renderFiles = () => (
    <BucketFileBrowser buckets={buckets} pushToast={pushToast} onDataChanged={fetchWorkspaceData} />
  );

  if (!authReady) {
    return (
      <div className="bg-background text-on-surface min-h-screen flex flex-col items-center justify-center font-body">
        <header className="text-center mb-8">
          <div className="text-5xl mb-4">🏥</div>
          <h1 className="text-4xl font-extrabold tracking-tighter text-primary headline mb-2">
            MediVault
          </h1>
          <p className="text-on-surface-variant font-medium">Verifying session...</p>
        </header>
        <ToastStack toasts={toasts} onDismiss={dismissToast} />
      </div>
    );
  }

  if (!token) {
    return (
      <div className="bg-background text-on-surface min-h-screen flex flex-col font-body">
        <Login
          onLogin={(newToken) => {
            setAuthReady(false);
            setActiveTab("dashboard");
            setToken(newToken);
          }}
        />
        <ToastStack toasts={toasts} onDismiss={dismissToast} />
      </div>
    );
  }

  const tabs = [
    { key: "dashboard", label: "Dashboard" },
    { key: "upload", label: "Upload" },
    { key: "buckets", label: "Buckets" },
    { key: "files", label: "Files" },
    { key: "history", label: "History" },
  ];

  return (
    <div className="bg-background text-on-surface min-h-screen flex flex-col font-body">
      <header className={`sticky top-0 z-50 w-full backdrop-blur-2xl border-b border-surface-container-high ${isDarkMode ? "bg-surface-container-low" : "bg-slate-50/90"}`}>
        <div className="flex flex-col w-full max-w-[1440px] mx-auto px-6 lg:px-10 gap-4 py-4 headline tracking-tight antialiased">
          <div className="flex items-center justify-between gap-6">
            <div className="text-2xl font-extrabold tracking-tighter text-primary">MediVault</div>
            <div className="flex items-center gap-4" ref={userMenuRef}>
              {dataLoading ? <span className="text-xs font-bold text-on-surface-variant">Syncing...</span> : null}
              <button
                type="button"
                onClick={fetchWorkspaceData}
                className="px-3 py-2 rounded-lg bg-surface-container-low text-xs font-bold text-primary"
              >
                Refresh
              </button>

              <button
                type="button"
                onClick={toggleTheme}
                className="px-3 py-2 rounded-lg bg-surface-container-low text-xs font-bold text-primary hover:bg-surface-container-high transition-colors flex items-center gap-1.5"
                aria-label={isDarkMode ? "Switch to light mode" : "Switch to dark mode"}
                title={isDarkMode ? "Switch to light mode" : "Switch to dark mode"}
              >
                <span className="material-symbols-outlined text-base leading-none">
                  {isDarkMode ? "light_mode" : "dark_mode"}
                </span>
                <span>{isDarkMode ? "Light" : "Dark"}</span>
              </button>

              <div className="relative">
                <button
                  type="button"
                  onClick={handleToggleUserMenu}
                  className="flex items-center gap-2 p-2 rounded-lg bg-surface-container-low hover:bg-surface-container-high transition-all"
                  aria-haspopup="menu"
                  aria-expanded={userMenuOpen}
                  title="Open user menu"
                >
                  <span className="text-xs font-bold text-primary">{currentUser?.username || "User"}</span>
                  <span className="material-symbols-outlined text-xl">account_circle</span>
                </button>

                {userMenuOpen ? (
                  <div className="absolute right-0 mt-2 w-72 rounded-xl border border-surface-container-high bg-surface-container-lowest shadow-lg p-2 z-50">
                    <button
                      type="button"
                      onClick={handleShowUserDetails}
                      className="w-full text-left rounded-lg px-3 py-2 text-sm font-bold text-primary hover:bg-surface-container-low"
                    >
                      User Details
                    </button>

                    {showUserDetails ? (
                      <div className="mx-1 mt-2 rounded-lg bg-surface-container-low p-3 text-xs text-on-surface-variant font-semibold space-y-2">
                        <div className="flex justify-between gap-4">
                          <span>Username</span>
                          <span className="text-primary truncate max-w-[130px]" title={currentUser?.username || "User"}>
                            {currentUser?.username || "User"}
                          </span>
                        </div>
                        <div className="flex justify-between gap-4">
                          <span>Configured Buckets</span>
                          <span className="text-primary">{metrics.configuredBuckets}</span>
                        </div>
                        <div className="flex justify-between gap-4">
                          <span>Total Uploads</span>
                          <span className="text-primary">{metrics.totalUploads}</span>
                        </div>
                      </div>
                    ) : null}

                    <button
                      type="button"
                      onClick={handleLogout}
                      className="mt-2 w-full text-left rounded-lg px-3 py-2 text-sm font-bold text-error hover:bg-error-container"
                    >
                      Logout
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
          </div>

          <nav className="flex items-center gap-2 overflow-x-auto">
            {tabs.map((tab) => {
              const isActive = tab.key === activeTab;
              return (
                <button
                  key={tab.key}
                  type="button"
                  onClick={() => setActiveTab(tab.key)}
                  className={`px-4 py-2 rounded-lg text-sm font-bold transition-colors ${
                    isActive
                      ? "bg-primary text-on-primary"
                      : "bg-surface-container-low text-on-surface-variant hover:text-primary"
                  }`}
                >
                  {tab.label}
                </button>
              );
            })}
          </nav>
        </div>
      </header>

      {activeTab === "dashboard" ? renderDashboard() : null}
      {activeTab === "upload" ? renderUploadCenter() : null}
      {activeTab === "buckets" ? renderBuckets() : null}
      {activeTab === "files" ? renderFiles() : null}
      {activeTab === "history" ? renderHistory() : null}

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
