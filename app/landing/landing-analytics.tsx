"use client";

import { useEffect } from "react";

declare global {
  interface Window {
    dataLayer?: Array<Record<string, unknown>>;
  }
}

export function LandingAnalytics() {
  useEffect(() => {
    const track = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-cta]") : null;
      if (!target) return;
      const detail = {
        event: "botcrm_cta_click",
        cta: target.dataset.cta,
        destination: target instanceof HTMLAnchorElement ? target.getAttribute("href") : undefined,
        path: window.location.pathname,
      };
      window.dataLayer?.push(detail);
      window.dispatchEvent(new CustomEvent("botcrm:cta", { detail }));
    };
    document.addEventListener("click", track);
    return () => document.removeEventListener("click", track);
  }, []);

  return null;
}
