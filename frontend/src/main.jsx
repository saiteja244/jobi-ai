import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App.jsx";
import { loadApiConfig } from "./services/api";

async function bootstrap() {
  await loadApiConfig();

  createRoot(document.getElementById("root")).render(
    <StrictMode>
      <App />
    </StrictMode>
  );
}

bootstrap();
