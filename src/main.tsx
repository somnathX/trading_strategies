import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { Live } from "./ui/Live";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {location.pathname.replace(/\/$/, "") === "/live" ? <Live /> : <App />}
  </StrictMode>,
);
