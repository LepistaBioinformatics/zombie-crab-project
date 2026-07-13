import ReactMarkdown from "react-markdown";
import Typography from "@mui/material/Typography";
import Box from "@mui/material/Box";
import Link from "@mui/material/Link";

// Renders assistant/user message content as markdown (picoclaw replies are
// often formatted with headings, lists, code blocks, etc.) instead of a
// plain pre-wrapped string. `color: inherit` throughout so this still picks
// up the parent Paper's contrast color for the user's own (primary-colored)
// bubble.
export default function MessageContent({ content }: { content: string }) {
  return (
    <ReactMarkdown
      components={{
        p: ({ children }) => (
          <Typography variant="body2" color="inherit" sx={{ "&:not(:last-child)": { mb: 1 } }}>
            {children}
          </Typography>
        ),
        a: ({ children, href }) => (
          <Link href={href} target="_blank" rel="noopener noreferrer" color="inherit">
            {children}
          </Link>
        ),
        ul: ({ children }) => (
          <Box component="ul" sx={{ m: 0, mb: 1, pl: 3 }}>
            {children}
          </Box>
        ),
        ol: ({ children }) => (
          <Box component="ol" sx={{ m: 0, mb: 1, pl: 3 }}>
            {children}
          </Box>
        ),
        li: ({ children }) => (
          <Typography component="li" variant="body2" color="inherit">
            {children}
          </Typography>
        ),
        code: ({ children, className }) => {
          // react-markdown gives block-level code a `language-*` className
          // (from the fenced ```lang block); inline code has none -- that's
          // the distinction used here, not a separate `inline` prop (v9
          // dropped it).
          const isBlock = Boolean(className);
          return (
            <Box
              component="code"
              sx={{
                fontFamily: "var(--font-mono), ui-monospace, SFMono-Regular, Menlo, monospace",
                fontSize: "0.85em",
                bgcolor: isBlock ? "transparent" : "action.selected",
                px: isBlock ? 0 : 0.6,
                borderRadius: 0.5,
              }}
            >
              {children}
            </Box>
          );
        },
        pre: ({ children }) => (
          <Box
            component="pre"
            sx={{
              m: 0,
              mb: 1,
              p: 1.5,
              bgcolor: "action.selected",
              borderRadius: 1,
              overflowX: "auto",
            }}
          >
            {children}
          </Box>
        ),
      }}
    >
      {content}
    </ReactMarkdown>
  );
}
