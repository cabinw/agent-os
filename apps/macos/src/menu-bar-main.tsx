import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MenuBarPanel } from "./MenuBar.js";
import "./styles/global.css";
import "./styles/menu-bar-global.css";

const root = document.getElementById("root");
if (root === null) throw new Error("Agent OS menu-bar root is missing");
createRoot(root).render(
  <StrictMode>
    <MenuBarPanel />
  </StrictMode>,
);
