import { useState, useRef, useCallback } from "react";
import { splitFileIntoChunks } from "../utils/chunker";
import { computeFileChecksum } from "../utils/checksum";
import { validateFileTypeByMagicBytes } from "../utils/fileTypeUtils";
import { startUpload, getPresignedUrl, completeUpload, abortUpload, updatePart, resumeSession } from "../api/uploadApi";

const MAX_RETRIES = 3;
const MAX_CONCURRENT = 5;
const RETRY_BASE_DELAY = 1000;
const NON_RETRYABLE_STATUSES = new Set([400, 401, 403, 404, 422]);
const START_CHECKSUM_WAIT_MS = 200;
const PENDING_CHECKSUM = "pending";
const MIN_S3_CHUNK_MB = 5;
const MAX_S3_CHUNK_MB = 10;
const MEDIUM_S3_CHUNK_MB = 7;
const DEFAULT_CHUNK_MB = 5;
const MB_BYTES = 1024 * 1024;
const ADAPTIVE_BASELINE_CHUNKS = 2;
const SPEED_WINDOW_SIZE = 3;

function buildFileId(file) {
  return `${file.name}-${file.size}`;
}

function extractStatus(err) {
  return err?.status || err?.response?.status || err?.cause?.status || err?.cause?.response?.status;
}

function extractDetail(err) {
  return err?.response?.data?.detail || err?.cause?.response?.data?.detail || err?.message;
}

function normalizeUploadError(err) {
  const status = extractStatus(err);
  const detail = extractDetail(err) || "Upload failed";

  if (err?.code === "MAX_RETRIES_EXCEEDED") {
    const partLabel = err?.partNumber ? ` (chunk ${err.partNumber})` : "";
    return {
      kind: "chunk_retry_exhausted",
      status,
      message: `A file chunk failed after multiple retries${partLabel}. Check your connection and resume upload.`,
      occurredAt: Date.now(),
    };
  }

  if (err?.code === "AUTH_ERROR" || status === 401 || status === 403) {
    return {
      kind: "auth",
      status,
      message: "Your login session is expired or invalid. Please sign in again and retry.",
      occurredAt: Date.now(),
    };
  }

  if (status === 422) {
    return {
      kind: "validation",
      status,
      message: `Upload request validation failed: ${detail}`,
      occurredAt: Date.now(),
    };
  }

  if (status === 400) {
    return {
      kind: "bad_request",
      status,
      message: `Upload request was rejected: ${detail}`,
      occurredAt: Date.now(),
    };
  }

  if (err?.code === "FILE_TYPE_NOT_ALLOWED" || status === 415) {
    return {
      kind: "file_type",
      status,
      message: err?.message || "Unsupported file type. Allowed types: DICOM, JPEG, PNG, PDF, ZIP.",
      occurredAt: Date.now(),
    };
  }

  return {
    kind: "generic",
    status,
    message: detail,
    occurredAt: Date.now(),
  };
}

function getStartChecksumValue(checksumPromise, timeoutMs = START_CHECKSUM_WAIT_MS) {
  return new Promise((resolve) => {
    let settled = false;
    const timerId = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(PENDING_CHECKSUM);
    }, timeoutMs);

    checksumPromise
      .then((value) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timerId);
        resolve(value || PENDING_CHECKSUM);
      })
      .catch(() => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timerId);
        resolve(PENDING_CHECKSUM);
      });
  });
}

function getDisplayChunkBySpeed(speedMB) {
  if (!Number.isFinite(speedMB) || speedMB < 1) {
    return MIN_S3_CHUNK_MB;
  }
  if (speedMB < 3) {
    return MEDIUM_S3_CHUNK_MB;
  }
  return MAX_S3_CHUNK_MB;
}

function getNetworkType(speedMB) {
  if (!Number.isFinite(speedMB) || speedMB < 1) {
    return "Slow";
  }
  if (speedMB <= 3) {
    return "Medium";
  }
  return "Fast";
}

export function useChunkedUpload() {
  const [status, setStatus] = useState("idle");
  const [progress, setProgress] = useState(0);
  const [chunkStatuses, setChunkStatuses] = useState([]);
  const [error, setError] = useState(null);
  const [errorMeta, setErrorMeta] = useState(null);
  const [uploadInfo, setUploadInfo] = useState(null);
  const [networkType, setNetworkType] = useState("Medium");
  const [displayChunkMB, setDisplayChunkMB] = useState(DEFAULT_CHUNK_MB);
  const [avgUploadSpeedMB, setAvgUploadSpeedMB] = useState(null);

  const isPausedRef = useRef(false);
  const fileRef = useRef(null);
  const activeUploadRef = useRef(false);
  const preparedSessionRef = useRef(null);
  const checksumPromisesRef = useRef(new Map());
  const fileValidationPromisesRef = useRef(new Map());
  const speedSamplesRef = useRef([]);
  const uploadedChunkCountRef = useRef(0);
  const safeChunkSizeBytesRef = useRef(DEFAULT_CHUNK_MB * MB_BYTES);
  const uploadRunIdRef = useRef(0);
  const activeFetchControllersRef = useRef(new Set());

  const abortActiveChunkRequests = useCallback(() => {
    activeFetchControllersRef.current.forEach((controller) => {
      try {
        controller.abort();
      } catch {
        // No-op: best-effort abort for in-flight chunk PUTs.
      }
    });
    activeFetchControllersRef.current.clear();
  }, []);

  const resetAdaptiveMetrics = useCallback(() => {
    speedSamplesRef.current = [];
    uploadedChunkCountRef.current = 0;
    safeChunkSizeBytesRef.current = DEFAULT_CHUNK_MB * MB_BYTES;
    setDisplayChunkMB(DEFAULT_CHUNK_MB);
    setNetworkType("Medium");
    setAvgUploadSpeedMB(null);
  }, []);

  const applyAdaptiveTelemetry = useCallback((chunkSizeBytes, elapsedMs) => {
    try {
      const timeSec = Math.max(elapsedMs / 1000, 0.001);
      const speedBytes = chunkSizeBytes / timeSec;
      const speedMB = speedBytes / MB_BYTES;

      const nextSamples = [...speedSamplesRef.current, speedMB].slice(-SPEED_WINDOW_SIZE);
      speedSamplesRef.current = nextSamples;
      uploadedChunkCountRef.current += 1;

      const avgSpeed = nextSamples.reduce((acc, value) => acc + value, 0) / Math.max(nextSamples.length, 1);
      setAvgUploadSpeedMB(avgSpeed);
      setNetworkType(getNetworkType(avgSpeed));

      if (uploadedChunkCountRef.current < ADAPTIVE_BASELINE_CHUNKS) {
        return;
      }

      const nextDisplayChunkMB = getDisplayChunkBySpeed(avgSpeed);

      setDisplayChunkMB(nextDisplayChunkMB);

      safeChunkSizeBytesRef.current = Math.min(
        Math.max(nextDisplayChunkMB, MIN_S3_CHUNK_MB),
        MAX_S3_CHUNK_MB,
      ) * MB_BYTES;
    } catch {
      safeChunkSizeBytesRef.current = MIN_S3_CHUNK_MB * MB_BYTES;
      setDisplayChunkMB(DEFAULT_CHUNK_MB);
      setNetworkType("Medium");
      setAvgUploadSpeedMB(null);
    }
  }, []);

  const getOrCreateFileValidationPromise = useCallback((file) => {
    const fileId = buildFileId(file);
    const existingPromise = fileValidationPromisesRef.current.get(fileId);
    if (existingPromise) return existingPromise;

    const validationPromise = validateFileTypeByMagicBytes(file)
      .then((result) => result)
      .catch(() => ({
        isAllowed: false,
        detectedType: "unknown",
        message: "Unable to validate file type. Try selecting the file again.",
      }));

    fileValidationPromisesRef.current.set(fileId, validationPromise);
    return validationPromise;
  }, []);

  const ensureFileTypeAllowed = useCallback(async (file) => {
    const validation = await getOrCreateFileValidationPromise(file);
    if (validation?.isAllowed) {
      return validation;
    }

    const blockedError = new Error(
      validation?.message || "Unsupported file type. Allowed types: DICOM, JPEG, PNG, PDF, ZIP."
    );
    blockedError.code = "FILE_TYPE_NOT_ALLOWED";
    blockedError.detectedType = validation?.detectedType || "unknown";
    throw blockedError;
  }, [getOrCreateFileValidationPromise]);

  const getOrCreateChecksumPromise = useCallback((file) => {
    const fileId = buildFileId(file);
    const existingPromise = checksumPromisesRef.current.get(fileId);
    if (existingPromise) return existingPromise;

    const checksumPromise = computeFileChecksum(file)
      .then((value) => value || PENDING_CHECKSUM)
      .catch(() => PENDING_CHECKSUM);

    checksumPromisesRef.current.set(fileId, checksumPromise);
    return checksumPromise;
  }, []);

  const prepareUpload = useCallback(async (file) => {
    if (!file) {
      preparedSessionRef.current = null;
      return null;
    }

    await ensureFileTypeAllowed(file);

    const fileId = buildFileId(file);
    const savedState = await resumeSession(fileId);

    if (savedState) {
      const completedPartNumbers = new Set(savedState.uploaded_part_numbers || []);
      const totalParts = savedState.total_parts > 0 ? savedState.total_parts : 0;

      preparedSessionRef.current = {
        fileId,
        hasSession: true,
        uploadId: savedState.upload_id,
        fileKey: savedState.file_key,
        completedPartNumbers,
        totalParts,
      };
      return preparedSessionRef.current;
    }

    preparedSessionRef.current = { fileId, hasSession: false };
    return preparedSessionRef.current;
  }, [ensureFileTypeAllowed]);

  const uploadChunk = async (chunk, fileId, fileKey, uploadId, runId, retryCount = 0) => {
    try {
      if (runId !== uploadRunIdRef.current) {
        const staleError = new Error("Stale upload run");
        staleError.code = "STALE_UPLOAD_RUN";
        throw staleError;
      }

      const { url } = await getPresignedUrl(fileKey, uploadId, chunk.partNumber);

      const startTime = Date.now();
      const controller = new AbortController();
      activeFetchControllersRef.current.add(controller);

      let response;
      try {
        response = await fetch(url, {
          method: "PUT",
          body: chunk.blob,
          headers: { "Content-Type": "application/octet-stream" },
          signal: controller.signal,
        });
      } finally {
        activeFetchControllersRef.current.delete(controller);
      }

      const endTime = Date.now();

      if (runId !== uploadRunIdRef.current) {
        const staleError = new Error("Stale upload run");
        staleError.code = "STALE_UPLOAD_RUN";
        throw staleError;
      }

      if (!response.ok) {
        const s3Error = new Error(`S3 returned ${response.status}`);
        s3Error.status = response.status;
        throw s3Error;
      }

      const etag = response.headers.get("ETag");
      if (!etag) throw new Error("No ETag returned from S3");

      if (runId !== uploadRunIdRef.current) {
        const staleError = new Error("Stale upload run");
        staleError.code = "STALE_UPLOAD_RUN";
        throw staleError;
      }

      await updatePart(fileId, fileKey, uploadId, chunk.partNumber, etag);
      applyAdaptiveTelemetry(chunk.blob.size, endTime - startTime);
      
      return { ETag: etag, PartNumber: chunk.partNumber };
    } catch (err) {
      if (err?.name === "AbortError") {
        const aborted = new Error("Chunk upload aborted");
        aborted.code = "STALE_UPLOAD_RUN";
        throw aborted;
      }

      if (err?.code === "STALE_UPLOAD_RUN") {
        throw err;
      }

      const status = extractStatus(err);

      if (status === 401 || status === 403) {
        const authError = new Error("Authentication failed while uploading chunk");
        authError.code = "AUTH_ERROR";
        authError.status = status;
        authError.cause = err;
        throw authError;
      }

      if (status && NON_RETRYABLE_STATUSES.has(status)) {
        throw err;
      }

      if (retryCount < MAX_RETRIES) {
        const delay = RETRY_BASE_DELAY * Math.pow(2, retryCount);
        await new Promise((r) => setTimeout(r, delay));
        return uploadChunk(chunk, fileId, fileKey, uploadId, runId, retryCount + 1);
      }

      const exhaustedError = new Error("Chunk upload failed after maximum retries");
      exhaustedError.code = "MAX_RETRIES_EXCEEDED";
      exhaustedError.partNumber = chunk.partNumber;
      exhaustedError.status = status;
      exhaustedError.cause = err;
      throw exhaustedError;
    }
  };

  const uploadWithPool = async (chunks, fileId, fileKey, uploadId, runId, completedPartNumbers, totalPartsHint = 0) => {
    const completedSet = completedPartNumbers instanceof Set
      ? completedPartNumbers
      : new Set(completedPartNumbers || []);

    const remaining = chunks.filter(
      (c) => !completedSet.has(c.partNumber)
    );

    const totalChunks = totalPartsHint > 0 ? totalPartsHint : chunks.length;
    let doneCount = completedSet.size;
    const parts = [];

    const statuses = chunks.map((c) => ({
      partNumber: c.partNumber,
      status: completedSet.has(c.partNumber) ? "completed" : "pending",
    }));
    setChunkStatuses([...statuses]);

    const setOneStatus = (partNumber, newStatus) => {
      const idx = statuses.findIndex((s) => s.partNumber === partNumber);
      if (idx !== -1) statuses[idx].status = newStatus;
      setChunkStatuses([...statuses]);
    };

    let queueIdx = 0;
    let hasError = null;

    const processNext = () => {
      if (isPausedRef.current || hasError || queueIdx >= remaining.length) {
        return Promise.resolve();
      }

      const chunk = remaining[queueIdx++];

      // Explicit guard: skip chunks already marked as uploaded.
      if (completedSet.has(chunk.partNumber)) {
        setOneStatus(chunk.partNumber, "completed");
        return processNext();
      }

      setOneStatus(chunk.partNumber, "uploading");

      return uploadChunk(chunk, fileId, fileKey, uploadId, runId)
        .then((result) => {
          if (runId !== uploadRunIdRef.current) {
            return;
          }

          setOneStatus(chunk.partNumber, "completed");
          completedSet.add(chunk.partNumber);
          parts.push(result);
          doneCount++;
          setProgress(Math.round((doneCount / Math.max(totalChunks, 1)) * 100));

          return processNext();
        })
        .catch((err) => {
          if (err?.code === "STALE_UPLOAD_RUN") {
            return;
          }

          setOneStatus(chunk.partNumber, "error");
          hasError = err;
        });
    };

    const poolSize = Math.min(MAX_CONCURRENT, remaining.length);
    const workers = Array.from({ length: poolSize }, () => processNext());

    await Promise.all(workers);

    if (hasError && !isPausedRef.current) throw hasError;

    if (isPausedRef.current) {
      return { parts, complete: false };
    }

    return { parts, complete: true };
  };

  const upload = useCallback(async (file, selectedBucketName = null) => {
    if (!file || activeUploadRef.current) return;

    const currentRunId = uploadRunIdRef.current + 1;
    uploadRunIdRef.current = currentRunId;
    abortActiveChunkRequests();

    activeUploadRef.current = true;
    fileRef.current = file;
    isPausedRef.current = false;
    setError(null);
    setErrorMeta(null);
    setStatus("uploading");
    setProgress(0);
    resetAdaptiveMetrics();

    try {
      await ensureFileTypeAllowed(file);

      const chunks = splitFileIntoChunks(file, MIN_S3_CHUNK_MB * MB_BYTES);
      const fileId = buildFileId(file);
      const checksumPromise = getOrCreateChecksumPromise(file);
      let uploadId, fileKey;
      let completedPartNumbers = new Set();
      let totalParts = chunks.length;

      const prepared = preparedSessionRef.current;

      if (prepared && prepared.fileId === fileId && prepared.hasSession) {
        uploadId = prepared.uploadId;
        fileKey = prepared.fileKey;
        completedPartNumbers = new Set(prepared.completedPartNumbers || []);
        totalParts = prepared.totalParts > 0 ? prepared.totalParts : chunks.length;
        setProgress(Math.round((completedPartNumbers.size / Math.max(totalParts, 1)) * 100));
      } else if (prepared && prepared.fileId === fileId && !prepared.hasSession) {
        const startChecksum = await getStartChecksumValue(checksumPromise);
        const result = await startUpload(
          fileId,
          file.name,
          file.type,
          file.size,
          startChecksum,
          selectedBucketName,
        );
        uploadId = result.upload_id;
        fileKey = result.file_key;
      } else {
        const savedState = await resumeSession(fileId);

        if (savedState) {
          uploadId = savedState.upload_id;
          fileKey = savedState.file_key;
          completedPartNumbers = new Set(savedState.uploaded_part_numbers || []);
          totalParts = savedState.total_parts > 0 ? savedState.total_parts : chunks.length;
          setProgress(Math.round((completedPartNumbers.size / Math.max(totalParts, 1)) * 100));
        } else {
          const startChecksum = await getStartChecksumValue(checksumPromise);
          const result = await startUpload(
            fileId,
            file.name,
            file.type,
            file.size,
            startChecksum,
            selectedBucketName,
          );
          uploadId = result.upload_id;
          fileKey = result.file_key;
        }
      }

      preparedSessionRef.current = null;

      if (currentRunId !== uploadRunIdRef.current) return;

      setUploadInfo({ uploadId, fileKey });

      const { parts, complete } = await uploadWithPool(
        chunks, fileId, fileKey, uploadId, currentRunId, completedPartNumbers, totalParts
      );

      if (currentRunId !== uploadRunIdRef.current) return;

      if (!complete) return; 

      const finalChecksum = (await checksumPromise) || PENDING_CHECKSUM;
      await completeUpload(fileId, fileKey, uploadId, file.name, file.size, parts, finalChecksum);

      if (currentRunId !== uploadRunIdRef.current) return;

      setStatus("completed");
      setProgress(100);
      setUploadInfo(null);
      checksumPromisesRef.current.delete(fileId);
      fileValidationPromisesRef.current.delete(fileId);
    } catch (err) {
      if (err?.code === "STALE_UPLOAD_RUN" || currentRunId !== uploadRunIdRef.current) {
        return;
      }

      if (isPausedRef.current) return;

      safeChunkSizeBytesRef.current = MIN_S3_CHUNK_MB * MB_BYTES;
      setDisplayChunkMB(DEFAULT_CHUNK_MB);
      setNetworkType("Medium");
      setAvgUploadSpeedMB(null);

      const normalizedError = normalizeUploadError(err);
      setError(normalizedError.message);
      setErrorMeta(normalizedError);
      setStatus("error");
    } finally {
      if (currentRunId === uploadRunIdRef.current) {
        activeUploadRef.current = false;
      }
    }
  }, [ensureFileTypeAllowed, getOrCreateChecksumPromise, resetAdaptiveMetrics, abortActiveChunkRequests]);

  const pause = useCallback(() => {
    isPausedRef.current = true;
    setStatus("paused");
  }, []);

  const resume = useCallback(() => {
    if (fileRef.current) upload(fileRef.current, null);
  }, [upload]);

  const cancel = useCallback(async () => {
    isPausedRef.current = true;
    activeUploadRef.current = false;
    uploadRunIdRef.current += 1;
    abortActiveChunkRequests();
    preparedSessionRef.current = null;
    if (fileRef.current) {
      checksumPromisesRef.current.delete(buildFileId(fileRef.current));
      fileValidationPromisesRef.current.delete(buildFileId(fileRef.current));
    }
    if (uploadInfo) {
      try { await abortUpload(uploadInfo.fileKey, uploadInfo.uploadId); } catch { }
    }
    fileRef.current = null;
    setStatus("idle");
    setProgress(0);
    setChunkStatuses([]);
    setError(null);
    setErrorMeta(null);
    setUploadInfo(null);
    resetAdaptiveMetrics();
  }, [uploadInfo, resetAdaptiveMetrics, abortActiveChunkRequests]);

  return {
    status,
    progress,
    chunkStatuses,
    error,
    errorMeta,
    uploadInfo,
    networkType,
    displayChunkMB,
    avgUploadSpeedMB,
    prepareUpload,
    upload,
    pause,
    resume,
    cancel,
  };
}
