import { Link } from "react-router-dom";
import {
  ArrowRight,
  ArrowUpRight,
  FileText,
  ShieldCheck,
  Zap,
  LockKeyhole,
  Layers,
  Sparkles,
} from "lucide-react";
import { tools } from "../config/tools";
import { FileDropzone } from "../components/file-dropzone";

export function Dashboard() {
  return (
    <div className="page dashboard-page">
      <section className="hero">
        <div className="hero-copy">
          <div className="eyebrow">
            <span /> A LITTLE SPACE. A LOT MORE CLARITY.
          </div>
          <h1>
            让文档处理，
            <br />
            <span>回归简单。</span>
          </h1>
          <p>
            转换、压缩、整理与识别。
            <br className="mobile-break" />
            你的下一站文档工作流，从 PageNest 开始。
          </p>
          <div className="hero-badges">
            <span>
              <ShieldCheck size={14} />
              本地优先
            </span>
            <span>
              <Zap size={14} />
              轻盈高效
            </span>
            <span>
              <Layers size={14} />
              模块化工作站
            </span>
          </div>
        </div>
        <div className="hero-art" aria-hidden="true">
          <div className="art-orbit" />
          <div className="art-sheet sheet-back">
            <span className="sheet-label">DOCX</span>
            <span className="sheet-line" />
            <span className="sheet-line short" />
            <div className="sheet-chart">
              <i />
              <i />
              <i />
            </div>
          </div>
          <div className="art-sheet sheet-front">
            <span className="sheet-fold" />
            <div className="sheet-icon">
              <FileText size={29} strokeWidth={1.5} />
            </div>
            <span className="sheet-label">
              A place for
              <br />
              every page.
            </span>
            <span className="sheet-line" />
            <span className="sheet-line short" />
            <span className="sheet-bottom">
              PAGENEST <span>01</span>
            </span>
          </div>
          <span className="art-spark">
            <Sparkles size={18} />
          </span>
          <span className="art-caption">
            <span /> 少一点繁杂，多一点专注
          </span>
        </div>
      </section>
      <FileDropzone />
      <section className="tools-section">
        <div className="section-heading">
          <div>
            <h2>
              常用工具 <span>为日常文档，找到顺手的工具</span>
            </h2>
          </div>
          <span className="section-meta">
            4 个模块 <span>·</span> 持续构建中
          </span>
        </div>
        <div className="tools-grid">
          {tools.map((tool) => (
            <Link
              to={`/${tool.id}`}
              className={`tool-card ${tool.color}`}
              key={tool.id}
            >
              <div className="tool-card-top">
                <span className="tool-icon">
                  <tool.icon size={23} strokeWidth={1.6} />
                </span>
                <ArrowUpRight className="card-arrow" size={17} />
              </div>
              <h3>{tool.name}</h3>
              <p>{tool.description}</p>
              <div className="tool-card-bottom">
                <span>{tool.english}</span>
                <span className="soon-badge">即将推出</span>
              </div>
            </Link>
          ))}
        </div>
      </section>
      <section className="dashboard-bottom">
        <div className="privacy-card">
          <span className="privacy-icon">
            <LockKeyhole size={22} strokeWidth={1.5} />
          </span>
          <div>
            <h3>你的文件，始终由你掌控。</h3>
            <p>无需账号，不上传文档。为隐私留出空间，也为专注留出空间。</p>
            <Link to="/settings">
              了解本地优先 <ArrowRight size={13} />
            </Link>
          </div>
          <span className="privacy-watermark" aria-hidden="true">
            <ShieldCheck size={100} strokeWidth={0.7} />
          </span>
        </div>
        <div className="recent-card">
          <div className="recent-heading">
            <h3>任务记录</h3>
            <Link to="/tasks" aria-label="查看任务记录">
              <ArrowUpRight size={16} />
            </Link>
          </div>
          <div className="recent-empty">
            <span>
              <FileText size={21} strokeWidth={1.4} />
            </span>
            <div>
              <strong>从一份文档开始</strong>
              <p>处理引擎上线后，在这里回顾你的任务。</p>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
