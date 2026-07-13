import Box from "@mui/material/Box";
import { getSession } from "@/lib/session";
import Sidebar from "./sidebar";

const SIDEBAR_WIDTH = 280;

export default async function ChatLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();

  return (
    <Box display="flex" height="100vh">
      <Box
        component="nav"
        width={SIDEBAR_WIDTH}
        flexShrink={0}
        borderRight={1}
        borderColor="divider"
        display="flex"
        flexDirection="column"
      >
        <Sidebar email={session?.email ?? ""} />
      </Box>
      <Box flex={1} minWidth={0}>
        {children}
      </Box>
    </Box>
  );
}
