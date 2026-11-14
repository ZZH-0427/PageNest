import { useTheme } from "../context/theme";
import { useFiles } from "../context/files";
import {
  Monitor,
  Sun,
  Moon,
  ShieldCheck,
  HardDrive,
  Palette,
  Info,
} from "lucide-react";
import { Button } from "../components/ui/button";

export function Settings() {
  const { theme, setTheme } = useTheme();
  const { files, clearFiles } = useFiles();
  return (
    <div className="page settings-page">
      <div className="page-title">
        <div className="eyebrow">MAKE ROOM FOR YOUR WAY</div>
        <h1>设置</h1>
        <p>让工作空间，更贴合你的习惯。</p>
      </div>
      <section className="settings-panel">
        <div className="settings-heading">
          <Palette size={18} />
          <div>
            <h2>外观</h2>
            <p>选择喜欢的主题，或与系统保持一致。</p>
          </div>
        </div>
        <div className="theme-options" role="radiogroup" aria-label="主题模式">
          {(
            [
              { id: "light", label: "浅色", icon: Sun },
              { id: "dark", label: "深色", icon: Moon },
              { id: "system", label: "跟随系统", icon: Monitor },
            ] as const
          ).map((option) => (
            <label
              className={`theme-option ${theme === option.id ? "selected" : ""}`}
              key={option.id}
            >
              <input
                type="radio"
                name="theme"
                value={option.id}
                checked={theme === option.id}
                onChange={() => setTheme(option.id)}
              />
              <span className={`theme-preview ${option.id}`}>
                <i />
                <span>
                  <b />
                  <b />
                  <b />
                </span>
              </span>
              <span className="theme-option-name">
                <option.icon size={15} />
                {option.label}
                <i />
              </span>
            </label>
          ))}
        </div>
        <p className="settings-note">
          主题偏好仅保存在当前浏览器中；跟随系统会自动响应系统主题变化。
        </p>
      </section>
      <section className="settings-panel">
        <div className="settings-heading">
          <HardDrive size={18} />
          <div>
            <h2>本地处理引擎</h2>
            <p>高级文档处理将通过可选的 Windows 本地引擎提供。</p>
          </div>
          <span className="soon-badge">尚未接入</span>
        </div>
        <div className="engine-description">
          <span className="engine-description-icon">
            <Monitor size={25} />
          </span>
          <div>
            <strong>为更强大的本地工作流预留空间</strong>
            <p>
              未来支持 Office 转换、高级压缩与
              OCR。此版本不尝试连接服务，不需要安装 Python。
            </p>
          </div>
        </div>
      </section>
      <section className="settings-panel">
        <div className="settings-heading">
          <ShieldCheck size={18} />
          <div>
            <h2>隐私与本地数据</h2>
            <p>你的文件，不离开你的设备。</p>
          </div>
        </div>
        <ul className="privacy-list">
          <li>
            文件选择仅在内存中保存名称、类型、大小等基本信息，不上传文档。
          </li>
          <li>不保存文档内容和文件列表；刷新或关闭页面即清空。</li>
          <li>无账户、无统计追踪；仅在本地保存主题偏好。</li>
        </ul>
        <div className="settings-data-row">
          <div>
            <strong>当前文件列表</strong>
            <span>已选择 {files.length} 个文件 · 清空不会删除电脑中的文件</span>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={files.length === 0}
            onClick={clearFiles}
          >
            清空文件列表
          </Button>
        </div>
      </section>
      <div className="about-line">
        <Info size={15} />
        <span>PageNest v0.1.0 · 本地优先的模块化文档工作站</span>
        <span>Phase 1 / 界面预览</span>
      </div>
    </div>
  );
}
