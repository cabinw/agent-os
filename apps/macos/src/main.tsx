import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HubProduct } from "./HubProduct.js";
import "./styles/global.css";

const root = document.getElementById("root");
if (root === null) throw new Error("Agent OS root element is missing");

createRoot(root).render(
  <StrictMode>
    <HubProduct />
  </StrictMode>,
);
