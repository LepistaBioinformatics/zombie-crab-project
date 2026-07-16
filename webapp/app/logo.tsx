import Image from "next/image";

// Two images, toggled purely by the `prefers-color-scheme` media query (no
// JS, no flash). The app uses the media dark strategy (no `.dark` class), so
// the toggle is an explicit arbitrary-media Tailwind variant rather than
// `dark:`.
export default function Logo({ size = 32 }: { size?: number }) {
  return (
    <>
      <span className="contents motion-safe:contents [@media(prefers-color-scheme:dark)]:hidden">
        <Image
          src="/logo-light.jpg"
          alt="zombie-crab"
          width={size}
          height={size}
          style={{ borderRadius: size / 4 }}
        />
      </span>
      <span className="hidden [@media(prefers-color-scheme:dark)]:contents">
        <Image
          src="/logo-dark.jpg"
          alt="zombie-crab"
          width={size}
          height={size}
          style={{ borderRadius: size / 4 }}
        />
      </span>
    </>
  );
}
