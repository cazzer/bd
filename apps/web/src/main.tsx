import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { ConnectGate } from "./components/ConnectScreen.js";
import "./index.css";

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("#root element not found");
}

createRoot(rootEl).render(
  <StrictMode>
    <ConnectGate>
      <App />
    </ConnectGate>
  </StrictMode>,
);
