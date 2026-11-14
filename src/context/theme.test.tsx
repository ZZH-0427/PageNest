import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { THEME_STORAGE_KEY, ThemeProvider, useTheme } from "./theme";

function ThemeControls() {
  const { theme, resolvedTheme, setTheme } = useTheme();
  return (
    <>
      <output aria-label="theme">
        {theme}:{resolvedTheme}
      </output>
      <button onClick={() => setTheme("light")}>Light</button>
      <button onClick={() => setTheme("dark")}>Dark</button>
      <button onClick={() => setTheme("system")}>System</button>
    </>
  );
}

describe("theme preferences", () => {
  it("switches themes, updates the document and saves the preference", () => {
    render(
      <ThemeProvider>
        <ThemeControls />
      </ThemeProvider>,
    );
    expect(screen.getByLabelText("theme")).toHaveTextContent("system:light");
    fireEvent.click(screen.getByText("Dark"));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    fireEvent.click(screen.getByText("Light"));
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("restores a saved preference", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "dark");
    render(
      <ThemeProvider>
        <ThemeControls />
      </ThemeProvider>,
    );
    expect(screen.getByLabelText("theme")).toHaveTextContent("dark:dark");
  });

  it("reacts to system changes only when the system theme is selected", () => {
    let changeListener: ((event: { matches: boolean }) => void) | undefined;
    const removeEventListener = vi.fn();
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockReturnValue({
        matches: false,
        addEventListener: (_event: string, callback: typeof changeListener) => {
          changeListener = callback;
        },
        removeEventListener,
      }),
    );
    const view = render(
      <ThemeProvider>
        <ThemeControls />
      </ThemeProvider>,
    );
    act(() => changeListener?.({ matches: true }));
    expect(screen.getByLabelText("theme")).toHaveTextContent("system:dark");
    fireEvent.click(screen.getByText("Light"));
    act(() => changeListener?.({ matches: false }));
    act(() => changeListener?.({ matches: true }));
    expect(screen.getByLabelText("theme")).toHaveTextContent("light:light");
    fireEvent.click(screen.getByText("System"));
    expect(screen.getByLabelText("theme")).toHaveTextContent("system:dark");
    view.unmount();
    expect(removeEventListener).toHaveBeenCalledWith("change", changeListener);
  });

  it("continues to work when browser storage is unavailable", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("Blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Blocked");
    });
    render(
      <ThemeProvider>
        <ThemeControls />
      </ThemeProvider>,
    );
    fireEvent.click(screen.getByText("Dark"));
    expect(screen.getByLabelText("theme")).toHaveTextContent("dark:dark");
  });
});
