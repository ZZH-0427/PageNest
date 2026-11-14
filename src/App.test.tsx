import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { App } from "./App";
import { ThemeProvider } from "./context/theme";
import { FilesProvider } from "./context/files";

function renderApp(route = "/") {
  return render(
    <ThemeProvider>
      <FilesProvider>
        <MemoryRouter initialEntries={[route]}>
          <App />
        </MemoryRouter>
      </FilesProvider>
    </ThemeProvider>,
  );
}

describe("PageNest workstation", () => {
  test("starts with the dashboard and supports sidebar navigation", async () => {
    const user = userEvent.setup();
    renderApp();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "让文档处理",
    );
    const nav = screen.getByRole("navigation");
    await user.click(within(nav).getByRole("link", { name: "格式转换" }));
    expect(
      screen.getByRole("heading", { level: 1, name: "格式转换" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /开始处理/ })).toBeDisabled();
    await user.click(within(nav).getByRole("link", { name: "任务记录" }));
    expect(screen.getByText("这里，等待你的第一个任务。")).toBeInTheDocument();
  });

  test.each([
    ["/converter", "格式转换"],
    ["/compression", "文件压缩"],
    ["/pdf-editor", "PDF 页面管理"],
    ["/ocr", "智能文字识别"],
    ["/tasks", "任务记录"],
    ["/settings", "设置"],
  ])("renders %s directly", (route, heading) => {
    renderApp(route);
    expect(
      screen.getByRole("heading", { level: 1, name: heading }),
    ).toBeInTheDocument();
  });

  test("selects real file metadata, preserves it across pages, and removes it", async () => {
    const user = userEvent.setup();
    renderApp();
    const file = new File(["synthetic test"], "example.pdf", {
      type: "application/pdf",
    });
    await user.upload(screen.getByLabelText("选择本地文件"), file);
    expect(screen.getByText("example.pdf")).toBeInTheDocument();
    expect(screen.getByText("仅文件信息")).toBeInTheDocument();
    await user.click(
      within(screen.getByRole("navigation")).getByRole("link", {
        name: "PDF 页面管理",
      }),
    );
    expect(screen.getByText("example.pdf")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "移除 example.pdf" }));
    expect(screen.queryByText("example.pdf")).not.toBeInTheDocument();
  });

  test("changes theme from settings and saves preference", async () => {
    const user = userEvent.setup();
    renderApp("/settings");
    await user.click(screen.getByRole("radio", { name: "深色" }));
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(screen.getByRole("radio", { name: "深色" })).toBeChecked();
    await user.click(screen.getByRole("radio", { name: "浅色" }));
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
  });

  test("explains unknown routes and offers recovery", () => {
    renderApp("/unknown");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "这个页面还没有安放好",
    );
    expect(screen.getByRole("link", { name: "返回工作台" })).toHaveAttribute(
      "href",
      "/",
    );
  });
});
