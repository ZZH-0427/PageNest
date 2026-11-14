import { ArrowRight, CircleDashed, Info, LockKeyhole } from "lucide-react";
import { tools } from "../config/tools";
import { FileDropzone } from "../components/file-dropzone";
import { Button } from "../components/ui/button";

export function ToolPage({ tool }: { tool: (typeof tools)[number] }) {
  return (
    <div className="page tool-page">
      <div className="page-title">
        <div className="eyebrow">
          YOUR DOCUMENT WORKSPACE / {tool.english.toUpperCase()}
        </div>
        <div className="title-line">
          <h1>{tool.name}</h1>
          <span className="soon-badge large">即将推出</span>
        </div>
        <p>{tool.detail}</p>
      </div>
      <div className="development-notice">
        <CircleDashed size={19} />
        <div>
          <strong>好工具，值得认真打磨。</strong>
          <p>
            当前版本可选择文件并查看基本信息。此模块的实际处理能力尚在开发中。
          </p>
        </div>
      </div>
      <div className="section-heading">
        <h2>
          计划支持 <span>{tool.english}</span>
        </h2>
        <span className="section-meta">功能预览</span>
      </div>
      <div className="capability-grid">
        {tool.formats.map((format, index) => (
          <div className={`capability-card ${tool.color}`} key={format}>
            <span className="tool-icon">
              <tool.icon size={20} />
            </span>
            <div>
              <h3>{format}</h3>
              <span>待接入处理引擎</span>
            </div>
            <span className="capability-index">0{index + 1}</span>
          </div>
        ))}
      </div>
      <FileDropzone compact />
      <div className="processing-bar">
        <span>
          <LockKeyhole size={15} />
          处理功能尚未开放
        </span>
        <Button disabled aria-describedby="processing-limitation">
          开始处理
          <ArrowRight size={15} />
        </Button>
      </div>
      <p id="processing-limitation" className="limitation">
        <Info size={15} />
        {tool.future}
      </p>
    </div>
  );
}
