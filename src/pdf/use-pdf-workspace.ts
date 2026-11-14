import { useEffect, useState, useSyncExternalStore } from "react";
import { PdfWorkspace } from "./workspace";

export function usePdfWorkspace() {
  const [workspace] = useState(() => new PdfWorkspace());
  const state = useSyncExternalStore(workspace.subscribe, workspace.getSnapshot);
  useEffect(() => {
    workspace.activate();
    return () => workspace.dispose();
  }, [workspace]);
  return { workspace, state };
}
