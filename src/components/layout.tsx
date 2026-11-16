import { useEffect } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import {
  ArrowUpRight,
  ChevronRight,
  FileText,
  Monitor,
  Moon,
  Search,
  ShieldCheck,
  Sun,
  Settings2,
} from "lucide-react";
import { navigation } from "../config/tools";
import { useTheme } from "../context/theme";
import { Button } from "./ui/button";

export function Layout() {
  const { theme, setTheme } = useTheme();
  const location = useLocation();
  const current = navigation.find(
    (item) => `/${item.id}` === location.pathname,
  );
  const ThemeIcon = theme === "light" ? Sun : theme === "dark" ? Moon : Monitor;
  const themeName = { light: "浅色", dark: "深色", system: "跟随系统" }[theme];

  useEffect(() => {
    document.title = `${current?.name ?? "页面未找到"} · PageNest`;
    document.getElementById("main-content")?.focus({ preventScroll: true });
  }, [location.pathname, current?.name]);

  return (
    <div className="app-shell">
      <a
        className="skip-link"
        href="#main-content"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById("main-content")?.focus();
        }}
      >
        跳至主内容
      </a>
      <header className="topbar">
        <Link className="brand" to="/" aria-label="PageNest 工作台">
          <span className="brand-mark">
            <FileText size={21} strokeWidth={1.8} />
          </span>
          <span>
            PageNest<span className="brand-period">.</span>
          </span>
        </Link>
        <div className="topbar-divider" />
        <span className="topbar-caption">你的文档，有序安放。</span>
        <div className="topbar-actions">
          <span className="search-unavailable" title="全局搜索将在后续版本提供">
            <Search size={15} />
            <span>搜索工具</span>
            <span className="search-status">即将推出</span>
          </span>
          <span className="topbar-line" />
          <Button
            variant="ghost"
            size="icon"
            aria-label={`主题：${themeName}，点击切换`}
            title={`主题：${themeName}`}
            onClick={() =>
              setTheme(
                theme === "light"
                  ? "dark"
                  : theme === "dark"
                    ? "system"
                    : "light",
              )
            }
          >
            <ThemeIcon size={18} />
          </Button>
          <Button asChild variant="ghost" size="icon">
            <Link to="/settings" aria-label="打开设置">
              <Settings2 size={18} />
            </Link>
          </Button>
        </div>
      </header>
      <aside className="sidebar" aria-label="主导航">
        <div className="sidebar-label">
          工作空间 <span>WORKSPACE</span>
        </div>
        <nav>
          {navigation.map((item, index) => (
            <NavLink
              end={item.id === ""}
              key={item.id}
              to={`/${item.id}`}
              aria-label={item.name}
              title={item.name}
              className={({ isActive }) =>
                `nav-item ${isActive ? "active" : ""} ${index === 5 ? "nav-separated" : ""}`
              }
            >
              <item.icon size={18} strokeWidth={1.7} />
              <span>{item.name}</span>
              {index > 0 && index < 5 && item.id !== "pdf-editor" && item.id !== "compression" && (
                <span className="nav-dot" aria-label="功能待开发" />
              )}
              {item.id === "" && <span className="nav-key">⌂</span>}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="engine-card">
            <span className="engine-symbol">
              <Monitor size={18} />
            </span>
            <div>
              <strong>本地处理引擎</strong>
              <span>
                <i /> 尚未接入
              </span>
            </div>
            <Link to="/settings" aria-label="查看本地引擎设置">
              <ArrowUpRight size={16} />
            </Link>
          </div>
          <div className="sidebar-footer">
            <span>
              PageNest <small>v0.2.0</small>
            </span>
            <span className="preview-label">预览版</span>
          </div>
        </div>
      </aside>
      <div className="workspace">
        <div className="workspace-bar">
          <div>
            <span>工作空间</span>
            <ChevronRight size={13} />
            <strong>{current?.name ?? "页面未找到"}</strong>
          </div>
          <span className="local-status">
            <span /> 本地优先 <ShieldCheck size={13} />
          </span>
        </div>
        <main id="main-content" tabIndex={-1}>
          <Outlet />
        </main>
        <footer className="main-footer">
          <span>让每一份文档，都各得其所。</span>
          <span>
            为专注而设计 <span className="footer-dot">·</span> PageNest
          </span>
        </footer>
      </div>
    </div>
  );
}
