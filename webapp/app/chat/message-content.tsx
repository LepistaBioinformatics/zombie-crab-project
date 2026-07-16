import ReactMarkdown from "react-markdown";
import { cva } from "class-variance-authority";

// Inline code gets a tinted chip; fenced/block code is bare (its <pre> wrapper
// carries the surface).
const codeText = cva("font-mono text-[0.85em]", {
  variants: {
    block: { true: "", false: "rounded bg-black/10 px-1 py-0.5" },
  },
  defaultVariants: { block: false },
});

// Renders assistant/user message content as markdown (picoclaw replies are
// often formatted with headings, lists, code blocks, etc.). Everything uses
// `color: inherit`/`currentColor` so it still reads correctly inside the
// user's own accent-filled bubble as well as the neutral assistant bubble.
export default function MessageContent({ content }: { content: string }) {
  return (
    <div className="text-sm leading-relaxed [&>*:last-child]:mb-0">
      <ReactMarkdown
        components={{
          p: ({ children }) => <p className="mb-2">{children}</p>,
          a: ({ children, href }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2"
            >
              {children}
            </a>
          ),
          ul: ({ children }) => <ul className="mb-2 list-disc pl-6">{children}</ul>,
          ol: ({ children }) => <ol className="mb-2 list-decimal pl-6">{children}</ol>,
          li: ({ children }) => <li>{children}</li>,
          h1: ({ children }) => <h1 className="mb-2 font-display text-lg font-bold">{children}</h1>,
          h2: ({ children }) => <h2 className="mb-2 font-display text-base font-bold">{children}</h2>,
          h3: ({ children }) => <h3 className="mb-1 font-display text-sm font-bold">{children}</h3>,
          code: ({ children, className }) => {
            // react-markdown v9 gives block-level code a `language-*`
            // className (from the fenced ```lang block); inline code has none.
            const isBlock = Boolean(className);
            return <code className={codeText({ block: isBlock })}>{children}</code>;
          },
          pre: ({ children }) => (
            <pre className="mb-2 overflow-x-auto rounded-lg bg-black/10 p-3">{children}</pre>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
