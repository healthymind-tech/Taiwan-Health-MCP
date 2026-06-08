// File upload with progress, via XHR (fetch cannot report upload progress).
// Mirrors the old admin_html_modules.py uploader: query-string metadata,
// raw file body, cookie auth.

export interface UploadParams {
  moduleKey: string;
  sourceRole: string;
  filename: string;
  autoActivate: boolean;
}

export interface UploadResult {
  uploaded_file?: Record<string, unknown>;
  duplicate?: boolean;
  message?: string;
}

export function uploadWithProgress(
  file: File,
  params: UploadParams,
  onProgress: (pct: number) => void,
): Promise<UploadResult> {
  const query = new URLSearchParams({
    module_key: params.moduleKey,
    source_role: params.sourceRole,
    filename: params.filename,
    auto_activate: params.autoActivate ? "true" : "false",
  });

  return new Promise<UploadResult>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/admin/api/uploads?${query.toString()}`);
    xhr.withCredentials = true;
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };

    xhr.onload = () => {
      let payload: (UploadResult & { error?: string }) | null = null;
      try {
        payload = JSON.parse(xhr.responseText);
      } catch {
        payload = null;
      }
      if (xhr.status === 401) {
        window.location.href = "/admin/login";
        reject(new Error("Authentication required"));
        return;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(payload ?? {});
      } else {
        reject(new Error(payload?.error || `Upload failed (${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new Error("Network error during upload"));

    xhr.send(file);
  });
}
