import { Route, Routes, Link } from "react-router-dom";
import { Layout } from "./components/layout";
import { Dashboard } from "./pages/dashboard";
import { ToolPage } from "./pages/tool";
import { Tasks } from "./pages/tasks";
import { Settings } from "./pages/settings";
import { tools } from "./config/tools";
import { Button } from "./components/ui/button";
import { PdfEditor } from "./pages/pdf-editor";
import { PdfCompression } from "./pages/pdf-compression";

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Dashboard />} />
        {tools.map((tool) => (
          <Route
            key={tool.id}
            path={tool.id}
            element={tool.id === "pdf-editor" ? <PdfEditor /> : tool.id === "compression" ? <PdfCompression /> : <ToolPage tool={tool} />}
          />
        ))}
        <Route path="tasks" element={<Tasks />} />
        <Route path="settings" element={<Settings />} />
        <Route
          path="*"
          element={
            <div className="page empty-panel">
              <h1>这个页面还没有安放好。</h1>
              <p>请通过左侧导航选择工作空间。</p>
              <Button asChild>
                <Link to="/">返回工作台</Link>
              </Button>
            </div>
          }
        />
      </Route>
    </Routes>
  );
}
