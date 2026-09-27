import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import Rulebook from "./Rulebook";
import "./styles.css";

const isRulebook = new URLSearchParams(window.location.search).get("view") === "rules";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {isRulebook ? <Rulebook /> : <App />}
  </StrictMode>,
);
