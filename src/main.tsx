import React from "react";
import ReactDOM from "react-dom/client";
import { HashRouter } from "react-router-dom";
import { ThemeProvider } from "./context/theme";
import { FilesProvider } from "./context/files";
import { App } from "./App";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ThemeProvider>
      <FilesProvider>
        <HashRouter>
          <App />
        </HashRouter>
      </FilesProvider>
    </ThemeProvider>
  </React.StrictMode>,
);
