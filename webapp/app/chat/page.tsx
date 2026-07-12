import Link from "next/link";
import Box from "@mui/material/Box";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import Card from "@mui/material/Card";
import CardActionArea from "@mui/material/CardActionArea";
import CardContent from "@mui/material/CardContent";
import Container from "@mui/material/Container";
import { getSession } from "@/lib/session";
import { INSTANCES } from "@/lib/mycelium";
import LogoutButton from "./logout-button";

export default async function ChatPickerPage() {
  const session = await getSession();

  return (
    <Container maxWidth="sm" sx={{ py: 6 }}>
      <Stack spacing={4}>
        <Stack direction="row" justifyContent="space-between" alignItems="center">
          <Box>
            <Typography variant="h5" fontWeight={600}>
              Pick an instance
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Signed in as {session?.email}
            </Typography>
          </Box>
          <LogoutButton />
        </Stack>

        <Typography variant="body2" color="text.secondary">
          Both instances are shown regardless of role -- access is enforced by the gateway when
          you send a message, not filtered here.
        </Typography>

        <Stack spacing={2}>
          {INSTANCES.map((instance) => (
            <Card key={instance} variant="outlined">
              <CardActionArea component={Link} href={`/chat/${instance}`}>
                <CardContent>
                  <Typography variant="h6" textTransform="capitalize">
                    {instance}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    picoclaw-{instance}
                  </Typography>
                </CardContent>
              </CardActionArea>
            </Card>
          ))}
        </Stack>
      </Stack>
    </Container>
  );
}
