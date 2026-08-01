import { useState, useRef, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { X, Upload, Loader, Download, FileText, Image as ImageIcon, CheckCircle } from "lucide-react";
import { api } from "../../lib/api";
import { toast } from "../../components/toast";
import styles from "./OcrTestModal.module.css";

interface OcrTestResult {
  ok: boolean;
  markdown?: string;
  analysis?: Record<string, unknown>;
  ocrProvider?: string;
  analysisProvider?: string | null;
  analysisConfigured?: boolean;
  error?: string;
  detail?: string;
}

interface SampleFile {
  id: string;
  name: string;
  filename: string;
  type: "pdf" | "image";
  description: string;
  mimeType: string;
  sizeBytes?: number;
}

interface OcrTestModalProps {
  isOpen: boolean;
  onClose: () => void;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function getFilePreviewUrl(file: File): string | null {
  if (file.type.startsWith("image/")) {
    return URL.createObjectURL(file);
  }
  if (file.type === "application/pdf") {
    return "pdf"; // Special marker for PDF
  }
  return null;
}

// Simple Markdown to HTML renderer
function renderMarkdown(markdown: string): string {
  let html = markdown;

  // Headers
  html = html.replace(/^### (.*?)$/gm, "<h3>$1</h3>");
  html = html.replace(/^## (.*?)$/gm, "<h2>$1</h2>");
  html = html.replace(/^# (.*?)$/gm, "<h1>$1</h1>");

  // Bold
  html = html.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/__(.+?)__/g, "<strong>$1</strong>");

  // Italic
  html = html.replace(/\*(.*?)\*/g, "<em>$1</em>");

  // Code blocks
  html = html.replace(/```[\s\S]*?```/g, (match) => {
    const code = match.replace(/```/g, "").trim();
    return `<pre><code>${escapeHtml(code)}</code></pre>`;
  });

  // Inline code
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");

  // Line breaks and paragraphs
  html = html.split("\n").map((line) => {
    if (!line.trim()) return "<br>";
    if (line.startsWith("<h") || line.startsWith("<pre")) return line;
    return `<p>${line}</p>`;
  }).join("\n");

  // Lists
  html = html.replace(/^- (.*?)$/gm, "<li>$1</li>");
  html = html.replace(/(<li>.*?<\/li>)/s, "<ul>$1</ul>");

  return html;
}

function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  };
  return text.replace(/[&<>"']/g, (char) => map[char]);
}

function MarkdownViewer({ content }: { content: string }): JSX.Element {
  return (
    <div
      className={styles.markdownViewer}
      dangerouslySetInnerHTML={{
        __html: renderMarkdown(content),
      }}
    />
  );
}

export function OcrTestModal({ isOpen, onClose }: OcrTestModalProps): JSX.Element | null {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [result, setResult] = useState<OcrTestResult | null>(null);
  const [activeTab, setActiveTab] = useState<"markdown" | "json">("markdown");
  const [loadingSampleId, setLoadingSampleId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const samplesQuery = useQuery({
    queryKey: ["ocr-samples"],
    queryFn: () => api.get<{ samples: SampleFile[] }>("/admin/api/ocr/samples"),
    enabled: isOpen,
  });

  // Update preview when file changes
  useEffect(() => {
    if (selectedFile) {
      const url = getFilePreviewUrl(selectedFile);
      setPreviewUrl(url);
    } else {
      setPreviewUrl(null);
    }
  }, [selectedFile]);

  if (!isOpen) return null;

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    const files = e.dataTransfer.files;
    if (files.length > 0) {
      setSelectedFile(files[0]);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      setSelectedFile(e.target.files[0]);
    }
  };

  const handleUseSample = async (sampleId: string) => {
    setLoadingSampleId(sampleId);
    try {
      const response = await fetch(`/admin/api/ocr/samples/${sampleId}`);
      if (!response.ok) {
        throw new Error(`Failed to load sample: HTTP ${response.status}`);
      }

      const blob = await response.blob();
      const filename = `${sampleId}${blob.type === "application/pdf" ? ".pdf" : ".jpg"}`;
      const file = new File([blob], filename, { type: blob.type });
      setSelectedFile(file);
      toast.success(`Loaded sample: ${filename}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      toast.error(`Failed to load sample: ${message}`);
    } finally {
      setLoadingSampleId(null);
    }
  };

  const handleConvert = async () => {
    if (!selectedFile) {
      toast.error("Please select a file first");
      return;
    }

    setIsLoading(true);
    try {
      // Create FormData to send file + filename
      const formData = new FormData();
      formData.append("file", selectedFile);
      formData.append("filename", selectedFile.name);

      const response = await fetch("/admin/api/ocr/test", {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        const errorData = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        throw new Error(
          String(errorData.detail || errorData.error || `HTTP ${response.status}`),
        );
      }

      const data = (await response.json()) as OcrTestResult;
      setResult(data);
      setActiveTab("markdown");
      if (data.ok) {
        toast.success("OCR test completed successfully");
      } else {
        toast.error(data.error || "OCR test failed");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error occurred";
      toast.error(`OCR test failed: ${message}`);
      setResult({ ok: false, error: "OCR test failed", detail: message });
    } finally {
      setIsLoading(false);
    }
  };

  const handleClearResults = () => {
    setResult(null);
    setSelectedFile(null);
  };

  return (
    <div className={styles.modalOverlay} onClick={onClose}>
      <div className={styles.modalContent} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <h2>OCR Test Tool</h2>
          <button className={styles.closeBtn} onClick={onClose}>
            <X size={20} />
          </button>
        </div>

        <div className={styles.container}>
          {/* Left Panel - File Upload & Preview */}
          <div className={styles.leftPanel}>
            {/* Preview Area */}
            <div className={styles.previewSection}>
              {previewUrl ? (
                <div className={styles.previewArea}>
                  {previewUrl === "pdf" ? (
                    <div className={styles.pdfPlaceholder}>
                      <FileText size={48} />
                      <p>{selectedFile?.name}</p>
                      <p className={styles.fileSize}>{formatFileSize(selectedFile?.size || 0)}</p>
                    </div>
                  ) : (
                    <img src={previewUrl} alt="Preview" className={styles.imagePreview} />
                  )}
                </div>
              ) : (
                <div className={styles.previewPlaceholder}>
                  <ImageIcon size={48} />
                  <p>File preview will appear here</p>
                </div>
              )}
            </div>

            {/* Upload Section */}
            <div className={styles.uploadSection}>
              <div
                className={`${styles.dropZone} ${isDragging ? styles.dragging : ""}`}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
              >
                <Upload size={28} />
                <p className={styles.dropText}>Drag & drop PDF or image</p>
                <p className={styles.dropSubtext}>or click to select</p>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,.jpg,.jpeg,.png,.gif,.bmp,.webp,.tiff"
                onChange={handleFileChange}
                style={{ display: "none" }}
              />

              {selectedFile && (
                <div className={styles.selectedFile}>
                  <div className={styles.selectedFileIcon}>
                    {selectedFile.type === "application/pdf" ? (
                      <FileText size={20} />
                    ) : (
                      <ImageIcon size={20} />
                    )}
                  </div>
                  <div className={styles.selectedFileInfo}>
                    <p className={styles.fileName}>{selectedFile.name}</p>
                    <p className={styles.fileSize}>{formatFileSize(selectedFile.size)}</p>
                  </div>
                </div>
              )}
            </div>

            {/* Sample Files */}
            {samplesQuery.data?.samples && samplesQuery.data.samples.length > 0 && (
              <div className={styles.samplesSection}>
                <h4>Sample Files</h4>
                <div className={styles.sampleList}>
                  {samplesQuery.data.samples.map((sample) => (
                    <button
                      key={sample.id}
                      className={`${styles.sampleBtn} ${loadingSampleId === sample.id ? styles.loading : ""}`}
                      onClick={() => handleUseSample(sample.id)}
                      disabled={loadingSampleId === sample.id || isLoading}
                      title={sample.description}
                    >
                      <div className={styles.sampleIcon}>
                        {sample.type === "pdf" ? (
                          <FileText size={16} />
                        ) : (
                          <ImageIcon size={16} />
                        )}
                      </div>
                      <div className={styles.sampleText}>
                        <p>{sample.name}</p>
                      </div>
                      {loadingSampleId === sample.id && (
                        <Loader size={14} className={styles.spinner} />
                      )}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Action Buttons */}
            <div className={styles.actionBar}>
              <button
                className={`${styles.convertBtn} ${isLoading ? styles.converting : ""}`}
                onClick={handleConvert}
                disabled={!selectedFile || isLoading}
              >
                {isLoading ? (
                  <>
                    <span className={styles.loadingSpinner} />
                    Converting...
                  </>
                ) : (
                  <>
                    <CheckCircle size={18} />
                    Convert
                  </>
                )}
              </button>
              <button
                className={styles.clearBtn}
                onClick={handleClearResults}
                disabled={!selectedFile && !result}
              >
                Clear
              </button>
            </div>
          </div>

          {/* Right Panel - Results */}
          <div className={styles.rightPanel}>
            {!result ? (
              <div className={styles.resultPlaceholder}>
                <div className={styles.placeholderIcon}>
                  <FileText size={56} />
                </div>
                <p className={styles.placeholderText}>Select a file and click Convert</p>
                <p className={styles.placeholderSubtext}>OCR results will appear here</p>
              </div>
            ) : result.ok ? (
              <>
                <div className={styles.resultHeader}>
                  <div>
                    <h3>OCR Results</h3>
                    <div className={styles.resultMeta}>
                      <span className={styles.provider}>
                        <strong>OCR:</strong> {result.ocrProvider}
                      </span>
                      {result.analysisConfigured ? (
                        <span className={styles.provider}>
                          <strong>LLM:</strong> {result.analysisProvider || "Processing"}
                        </span>
                      ) : (
                        <span className={styles.providerDisabled}>
                          <strong>LLM:</strong> Not configured
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                <div className={styles.tabsBar}>
                  <button
                    className={`${styles.tabBtn} ${activeTab === "markdown" ? styles.active : ""}`}
                    onClick={() => setActiveTab("markdown")}
                  >
                    <FileText size={16} />
                    OCR Text
                  </button>
                  <button
                    className={`${styles.tabBtn} ${activeTab === "json" ? styles.active : ""} ${
                      !result.analysisConfigured ? styles.disabled : ""
                    }`}
                    onClick={() => result.analysisConfigured && setActiveTab("json")}
                    disabled={!result.analysisConfigured}
                    title={
                      result.analysisConfigured
                        ? undefined
                        : "Configure Analysis LM in Settings to use this"
                    }
                  >
                    <FileText size={16} />
                    Analysis JSON
                  </button>
                </div>

                <div className={styles.resultBody}>
                  {activeTab === "markdown" && (
                    result.markdown ? (
                      <MarkdownViewer content={result.markdown} />
                    ) : (
                      <p className={styles.emptyMessage}>No OCR content</p>
                    )
                  )}
                  {activeTab === "json" && result.analysisConfigured && (
                    result.analysis ? (
                      <pre className={styles.jsonBlock}>
                        {JSON.stringify(result.analysis, null, 2)}
                      </pre>
                    ) : (
                      <p className={styles.emptyMessage}>No analysis data</p>
                    )
                  )}
                </div>
              </>
            ) : (
              <div className={styles.errorBox}>
                <div className={styles.errorIcon}>⚠️</div>
                <h3>Processing Failed</h3>
                <p>{result.error}</p>
                {result.detail && <p className={styles.errorDetail}>{result.detail}</p>}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
