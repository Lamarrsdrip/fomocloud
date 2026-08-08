"use client";
import { useEffect } from "react";

/** Registers the service worker so the app is installable and can receive Web Push. */
export default function PwaRegistrar() {
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch(() => {
      /* Registration failures are non-fatal; the app still works in the browser. */
    });
  }, []);
  return null;
}
