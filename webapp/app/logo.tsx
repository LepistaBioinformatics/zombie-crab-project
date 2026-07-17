// Two images, toggled purely by the `prefers-color-scheme` media query (no
// JS, no flash). The app uses the media dark strategy (no `.dark` class), so
// the toggle is an explicit arbitrary-media Tailwind variant rather than
// `dark:`. Sources are the branding logo endpoints, which return the custom
// upload or the bundled default; a plain <img> avoids next/image config for an
// API route.
export default function Logo({ size = 32 }: { size?: number }) {
  return (
    <>
      <span className="contents [@media(prefers-color-scheme:dark)]:hidden">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/api/branding/logo/light"
          alt="zombie-crab"
          width={size}
          height={size}
          style={{ borderRadius: size / 4 }}
        />
      </span>
      <span className="hidden [@media(prefers-color-scheme:dark)]:contents">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/api/branding/logo/dark"
          alt="zombie-crab"
          width={size}
          height={size}
          style={{ borderRadius: size / 4 }}
        />
      </span>
    </>
  );
}
