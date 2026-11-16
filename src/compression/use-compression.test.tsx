import { act, renderHook } from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { usePdfCompression } from "./use-compression";
import { PdfCompressionController } from "./controller";
import { runCompression } from "./engine";

vi.mock("./engine", () => ({ runCompression: vi.fn() }));
function nativeSupport(images = true) {
  vi.stubGlobal("Worker", class {}); vi.stubGlobal("CompressionStream", class {}); vi.stubGlobal("DecompressionStream", class {});
  vi.stubGlobal("OffscreenCanvas", images ? class {} : undefined); vi.stubGlobal("createImageBitmap", images ? vi.fn() : undefined);
}

describe("isolated compression session hook", () => {
  it("enables only browser-supported modes without starting a worker automatically", () => {
    vi.stubGlobal("Worker", undefined);
    const { result } = renderHook(() => usePdfCompression());
    expect(result.current.state.availableModes).toEqual([]);
    expect(runCompression).not.toHaveBeenCalled();
  });

  it("keeps lossless available when image decoding/encoding APIs are missing", () => {
    nativeSupport(false);
    const { result } = renderHook(() => usePdfCompression());
    expect(result.current.state.availableModes).toEqual(["lossless"]);
  });

  it("owns one reactive session across renders and disposes file capabilities on unmount", () => {
    nativeSupport();
    const dispose = vi.spyOn(PdfCompressionController.prototype, "dispose");
    const { result, rerender, unmount } = renderHook(() => usePdfCompression());
    const controller = result.current.controller;
    act(() => controller.addFiles([new File(["artificial"], "artificial.pdf")]));
    expect(result.current.state.files).toHaveLength(1);
    rerender(); expect(result.current.controller).toBe(controller);
    unmount();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().files).toEqual([]);
    controller.addFiles([new File(["artificial"], "later.pdf")]);
    expect(controller.getSnapshot().files).toEqual([]);
  });

  it("survives the StrictMode setup/cleanup/setup cycle with an active final session", () => {
    nativeSupport();
    const wrapper = ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>;
    const { result } = renderHook(() => usePdfCompression(), { wrapper });
    act(() => result.current.controller.addFiles([new File(["artificial"], "artificial.pdf")]));
    expect(result.current.state.files).toHaveLength(1);
    expect(result.current.state.availableModes).toEqual(["lossless", "high", "balanced", "strong"]);
  });
});
