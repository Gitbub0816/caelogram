import React from "react";
import { createRoot } from "react-dom/client";
import AuthRoot from "./Auth";
import "@fontsource/dm-sans/400.css";
import "@fontsource/dm-sans/500.css";
import "@fontsource/dm-sans/600.css";
import "@fontsource/space-grotesk/400.css";
import "@fontsource/space-grotesk/500.css";
import "./style.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AuthRoot />
  </React.StrictMode>,
);

import "./orbit.css";
import "./galaxy.css";
import "./auth.css";
import "./analytics.css";
