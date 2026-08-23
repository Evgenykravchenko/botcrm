import type { MetadataRoute } from "next";

function publicUrl() {
  return (process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3001").replace(/\/$/, "");
}

export default function sitemap(): MetadataRoute.Sitemap {
  const base = publicUrl();
  return [
    { url: `${base}/landing`, lastModified: new Date(), changeFrequency: "weekly", priority: 1 },
    { url: `${base}/docs`, lastModified: new Date(), changeFrequency: "monthly", priority: 0.6 },
  ];
}
