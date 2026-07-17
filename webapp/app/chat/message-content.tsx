import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cva } from "class-variance-authority";

// Inline code gets a tinted chip; fenced/block code is bare (its <pre> wrapper
// carries the surface). `bg-current/*` tints toward the text color so it reads
// on both the neutral assistant bubble and the accent-filled user bubble.
const codeText = cva("font-mono text-[0.85em]", {
  variants: {
    block: { true: "", false: "rounded bg-current/10 px-1 py-0.5" },
  },
  defaultVariants: { block: false },
});

// Renders assistant/user message content as markdown. GitHub-flavored
// (remark-gfm) so tables, strikethrough, task lists and autolinks work. Colors
// inherit from the bubble; borders/fills use currentColor so they adapt to it.
// Wide tables and code blocks scroll horizontally inside the bubble.
export default function MessageContent({ content }: { content: string }) {
  return (
    <div className="text-sm leading-relaxed [&>*:last-child]:mb-0">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
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
          ul: ({ children }) => (
            <ul className="mb-2 list-disc pl-6 marker:text-current/60 [&_ol]:mb-0 [&_ul]:mb-0">
              {children}
            </ul>
          ),
          ol: ({ children }) => (
            <ol className="mb-2 list-decimal pl-6 marker:text-current/60 [&_ol]:mb-0 [&_ul]:mb-0">
              {children}
            </ol>
          ),
          li: ({ children }) => <li className="mb-0.5 [&>ol]:mt-0.5 [&>ul]:mt-0.5">{children}</li>,
          h1: ({ children }) => <h1 className="mb-2 mt-1 font-display text-lg font-bold">{children}</h1>,
          h2: ({ children }) => <h2 className="mb-2 mt-1 font-display text-base font-bold">{children}</h2>,
          h3: ({ children }) => <h3 className="mb-1 mt-1 font-display text-sm font-bold">{children}</h3>,
          h4: ({ children }) => <h4 className="mb-1 font-display text-sm font-semibold">{children}</h4>,
          h5: ({ children }) => (
            <h5 className="mb-1 font-display text-xs font-semibold uppercase tracking-wide">{children}</h5>
          ),
          h6: ({ children }) => (
            <h6 className="mb-1 font-display text-xs font-semibold uppercase tracking-wide text-current/70">
              {children}
            </h6>
          ),
          strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
          em: ({ children }) => <em className="italic">{children}</em>,
          del: ({ children }) => <del className="line-through opacity-70">{children}</del>,
          hr: () => <hr className="my-3 border-current/20" />,
          blockquote: ({ children }) => (
            <blockquote className="mb-2 border-l-2 border-current/30 pl-3 italic opacity-90">
              {children}
            </blockquote>
          ),
          code: ({ children, className }) => {
            // react-markdown v9 gives block-level code a `language-*` className
            // (from the fenced ```lang block); inline code has none.
            const isBlock = Boolean(className);
            return <code className={codeText({ block: isBlock })}>{children}</code>;
          },
          pre: ({ children }) => (
            <pre className="mb-2 overflow-x-auto rounded-lg bg-current/10 p-3">{children}</pre>
          ),
          table: ({ children }) => (
            <div className="mb-2 overflow-x-auto">
              <table className="w-max min-w-full border-collapse text-left text-[0.9em] [&_tbody_tr:nth-child(even)]:bg-current/5 [&_thead]:bg-current/15">
                {children}
              </table>
            </div>
          ),
          thead: ({ children }) => <thead className="border-b-2 border-current/40">{children}</thead>,
          tbody: ({ children }) => <tbody>{children}</tbody>,
          tr: ({ children }) => <tr className="border-b border-current/15">{children}</tr>,
          th: ({ children }) => (
            <th className="whitespace-nowrap px-3 py-1.5 font-semibold">{children}</th>
          ),
          td: ({ children }) => <td className="px-3 py-1.5 align-top">{children}</td>,
          input: (props) => (
            <input {...props} disabled className="mr-1 align-middle accent-accent" />
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
