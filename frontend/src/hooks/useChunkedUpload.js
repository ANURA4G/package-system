import { useState, useRef, useCallback } from "react";
import { splitFileIntoChunks } from "../utils/chunker";
import { startUpload, getPresignedUrl, completeUpload, abortUpload, updatePart, resumeSession } from "../api/uploadApi";

const MAX_RETRIES = 3;
const MAX_CONCURRENT = 5;
const RETRY_BASE_DELAY = 1000;
const NON_RETRYABLE_STATUSES = new Set([400, 401, 403, 404, 422]);

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

  return {
    kind: "generic",
    status,
    message: detail,
    occurredAt: Date.now(),
  };
}

export function useChunkedUpload() {
  const [status, setStatus] = useState("idle");
  const [progress, setProgress] = useState(0);
  const [chunkStatuses, setChunkStatuses] = useState([]);
  const [error, setError] = useState(null);
  const [errorMeta, setErrorMeta] = useState(null);
  const [uploadInfo, setUploadInfo] = useState(null);

  const isPausedRef = useRef(false);
  const fileRef = useRef(null);
  const activeUploadRef = useRef(false);
  const preparedSessionRef = useRef(null);

  const prepareUpload = useCallback(async (file) => {
    if (!file) {
      preparedSessionRef.current = null;
      return null;
    }

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
  }, []);

  const uploadChunk = async (chunk, fileId, fileKey, uploadId, retryCount = 0) => {
    try {
      const { url } = await getPresignedUrl(fileKey, uploadId, chunk.partNumber);

      const response = await fetch(url, {
        method: "PUT",
        body: chunk.blob,
        headers: { "Content-Type": "application/octet-stream" },
      });

      if (!response.ok) {
        const s3Error = new Error(`S3 returned ${response.status}`);
        s3Error.status = response.status;
        throw s3Error;
      }

      const etag = response.headers.get("ETag");
      if (!etag) throw new Error("No ETag returned from S3");

      await updatePart(fileId, fileKey, uploadId, chunk.partNumber, etag);
      
      return { ETag: etag, PartNumber: chunk.partNumber };
    } catch (err) {
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
        return uploadChunk(chunk, fileId, fileKey, uploadId, retryCount + 1);
      }

      const exhaustedError = new Error("Chunk upload failed after maximum retries");
      exhaustedError.code = "MAX_RETRIES_EXCEEDED";
      exhaustedError.partNumber = chunk.partNumber;
      exhaustedError.status = status;
      exhaustedError.cause = err;
      throw exhaustedError;
    }
  };

  const uploadWithPool = async (chunks, fileId, fileKey, uploadId, completedPartNumbers, totalPartsHint = 0) => {
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

      return uploadChunk(chunk, fileId, fileKey, uploadId)
        .then((result) => {
          setOneStatus(chunk.partNumber, "completed");
          completedSet.add(chunk.partNumber);
          parts.push(result);
          doneCount++;
          setProgress(Math.round((doneCount / Math.max(totalChunks, 1)) * 100));

          return processNext();
        })
        .catch((err) => {
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

  const upload = useCallback(async (file) => {
    if (!file || activeUploadRef.current) return;

    activeUploadRef.current = true;
    fileRef.current = file;
    isPausedRef.current = false;
    setError(null);
    setErrorMeta(null);
    setStatus("uploading");
    setProgress(0);

    try {
      const chunks = splitFileIntoChunks(file);
      const fileId = buildFileId(file);
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
        const result = await startUpload(fileId, file.name, file.type, file.size);
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
          const result = await startUpload(fileId, file.name, file.type, file.size);
          uploadId = result.upload_id;
          fileKey = result.file_key;
        }
      }

      preparedSessionRef.current = null;

      setUploadInfo({ uploadId, fileKey });

      const { parts, complete } = await uploadWithPool(
        chunks, fileId, fileKey, uploadId, completedPartNumbers, totalParts
      );

      if (!complete) return; 

      await completeUpload(fileId, fileKey, uploadId, file.name, file.size, parts);
      setStatus("completed");
      setProgress(100);
    } catch (err) {
      if (isPausedRef.current) return;

      const normalizedError = normalizeUploadError(err);
      setError(normalizedError.message);
      setErrorMeta(normalizedError);
      setStatus("error");
    } finally {
      activeUploadRef.current = false;
    }
  }, []);

  const pause = useCallback(() => {
    isPausedRef.current = true;
    setStatus("paused");
  }, []);

  const resume = useCallback(() => {
    if (fileRef.current) upload(fileRef.current);
  }, [upload]);

  const cancel = useCallback(async () => {
    isPausedRef.current = true;
    activeUploadRef.current = false;
    preparedSessionRef.current = null;
    if (uploadInfo) {
      try { await abortUpload(uploadInfo.fileKey, uploadInfo.uploadId); } catch { }
    }
    setStatus("idle");
    setProgress(0);
    setChunkStatuses([]);
    setError(null);
    setErrorMeta(null);
    setUploadInfo(null);
  }, [uploadInfo]);

  return { status, progress, chunkStatuses, error, errorMeta, uploadInfo, prepareUpload, upload, pause, resume, cancel };
}
