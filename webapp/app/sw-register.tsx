"use client";

import { useEffect } from "react";

// Registers the service worker once on mount. Rendered from the root layout so
// every route participates in the PWA shell caching.
export default function SwRegister() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // Registration failures are non-fatal: the app still works online.
    });
  }, []);

  return null;
}
