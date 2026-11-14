import { useRef, useState } from "react";
import {
  FileText,
  FolderOpen,
  Upload,
  X,
  ShieldCheck,
  AlertCircle,
} from "lucide-react";
import { useFiles } from "../context/files";
import { FILE_ACCEPT, formatBytes } from "../lib/files";
import { Button } from "./ui/button";

export function FileDropzone({ compact = false }: { compact?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  const { files, addFiles, removeFile, clearFiles, error, dismissError } =
    useFiles();

  return (
    <section
      className={`file-section ${compact ? "compact" : ""}`}
      aria-label="本地文件选择"
    >
      <div
        className={`dropzone ${dragging ? "dragging" : ""}`}
        onDragEnter={(event) => {
          event.preventDefault();
          depth.current++;
          setDragging(true);
        }}
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }}
        onDragLeave={(event) => {
          event.preventDefault();
          depth.current--;
          if (depth.current <= 0) {
            depth.current = 0;
            setDragging(false);
          }
        }}
        onDrop={(event) => {
          event.preventDefault();
          depth.current = 0;
          setDragging(false);
          addFiles(Array.from(event.dataTransfer.files));
        }}
      >
        <div className="dropzone-symbol">
          <Upload size={24} strokeWidth={1.6} />
        </div>
        <div className="dropzone-copy">
          <h2>
            {dragging ? "松开鼠标，添加文件" : "把文件放在这里，开始整理"}
          </h2>
          <p>拖入文档，或从电脑中选择文件</p>
        </div>
        <Button onClick={() => input.current?.click()}>
          <FolderOpen size={16} />
          选择文件
        </Button>
        <input
          ref={input}
          className="sr-only"
          tabIndex={-1}
          type="file"
          multiple
          accept={FILE_ACCEPT}
          aria-label="选择本地文件"
          onChange={(event) => {
            addFiles(Array.from(event.target.files ?? []));
            event.target.value = "";
          }}
        />
        <p className="dropzone-formats">
          PDF、Word、PowerPoint、Excel 及图片 <span>·</span> 单个文件 ≤ 100
          MB，最多 20 个
        </p>
      </div>
      <div className="file-privacy">
        <ShieldCheck size={13} />
        <span>文件留在你的设备上。当前仅读取基本信息，不上传、不处理。</span>
      </div>
      {error && (
        <div className="error-message" role="alert">
          <AlertCircle size={17} />
          <span>{error}</span>
          <Button
            variant="ghost"
            size="icon"
            aria-label="关闭文件提示"
            onClick={dismissError}
          >
            <X size={15} />
          </Button>
        </div>
      )}
      {files.length > 0 && (
        <div className="selected-files">
          <div className="selected-heading">
            <h3>
              已选择的文件 <span>{files.length}</span>
            </h3>
            <Button size="sm" variant="ghost" onClick={clearFiles}>
              清空列表
            </Button>
          </div>
          <ul>
            {files.map((file) => (
              <li key={file.id}>
                <span className="selected-file-icon">
                  <FileText size={21} />
                </span>
                <div className="selected-file-name">
                  <strong title={file.name}>{file.name}</strong>
                  <span>
                    {formatBytes(file.size)} <span>·</span>{" "}
                    {file.type || "未知 MIME 类型"}
                  </span>
                </div>
                <span className="metadata-badge">仅文件信息</span>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`移除 ${file.name}`}
                  onClick={() => removeFile(file.id)}
                >
                  <X size={15} />
                </Button>
              </li>
            ))}
          </ul>
          <p className="selected-note" role="status">
            已读取 {files.length}{" "}
            个文件的基本信息。处理引擎尚未开放，刷新页面后列表将清空。
          </p>
        </div>
      )}
    </section>
  );
}
