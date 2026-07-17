"use client";

import { useEffect, useState } from "react";

const DEFAULT_APP_NAME = "zombie-crab";

// Renders the instance app name from the branding API (FR-9), falling back to
// the default until the fetch resolves or if it fails. A plain <span> so it
// drops into headers/labels; styling comes from the passed className.
export default function BrandName({ className }: { className?: string }) {
  const [name, setName] = useState(DEFAULT_APP_NAME);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/branding")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data?.appName) setName(data.appName as string);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return <span className={className}>{name}</span>;
}
