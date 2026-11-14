import { createContext, useContext, useReducer, type ReactNode } from "react";
import { fileToMetadata, mergeFiles } from "../lib/files";
import type { LocalFile } from "../types";

interface FilesState {
  files: LocalFile[];
  error: string | null;
}

type FilesAction =
  | { type: "add"; files: LocalFile[] }
  | { type: "remove"; id: string }
  | { type: "clear" }
  | { type: "dismiss" };

function reducer(state: FilesState, action: FilesAction): FilesState {
  switch (action.type) {
    case "add":
      return mergeFiles(state.files, action.files);
    case "remove":
      return {
        files: state.files.filter((file) => file.id !== action.id),
        error: null,
      };
    case "clear":
      return { files: [], error: null };
    case "dismiss":
      return { ...state, error: null };
  }
}

interface FilesContextValue extends FilesState {
  addFiles: (files: File[]) => void;
  removeFile: (id: string) => void;
  clearFiles: () => void;
  dismissError: () => void;
}

const FilesContext = createContext<FilesContextValue | null>(null);

export function FilesProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, { files: [], error: null });

  return (
    <FilesContext.Provider
      value={{
        ...state,
        addFiles: (files) =>
          dispatch({ type: "add", files: files.map(fileToMetadata) }),
        removeFile: (id) => dispatch({ type: "remove", id }),
        clearFiles: () => dispatch({ type: "clear" }),
        dismissError: () => dispatch({ type: "dismiss" }),
      }}
    >
      {children}
    </FilesContext.Provider>
  );
}

export function useFiles() {
  const context = useContext(FilesContext);
  if (!context) throw new Error("useFiles must be used within FilesProvider");
  return context;
}
