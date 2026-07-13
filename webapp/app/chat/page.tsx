import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";

// The sidebar (app/chat/layout.tsx) handles picking an agent and starting or
// resuming a conversation -- this route is just what renders in the main
// pane when nothing is selected yet (fresh signin, or before the first
// conversation exists).
export default function ChatEmptyState() {
  return (
    <Box
      display="flex"
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
      height="100%"
      color="text.secondary"
    >
      <Typography variant="h6" gutterBottom>
        No conversation selected
      </Typography>
      <Typography variant="body2">Start a new chat with an agent from the sidebar.</Typography>
    </Box>
  );
}
