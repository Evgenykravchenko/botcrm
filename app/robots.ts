import type { MetadataRoute } from "next";

function publicUrl() {
  return (process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3001").replace(/\/$/, "");
}

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: ["/landing", "/docs"], disallow: ["/api/"] }],
    sitemap: `${publicUrl()}/sitemap.xml`,
  };
}
