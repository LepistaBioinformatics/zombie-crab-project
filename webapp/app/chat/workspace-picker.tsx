"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Logo from "@/app/logo";
import Box from "@mui/material/Box";
import Container from "@mui/material/Container";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import Card from "@mui/material/Card";
import CardActionArea from "@mui/material/CardActionArea";
import Chip from "@mui/material/Chip";
import Alert from "@mui/material/Alert";
import CircularProgress from "@mui/material/CircularProgress";
import { createConversation } from "@/lib/chatSession";
import { fragmentHash, type Workspace } from "./fragment";
import LogoutButton from "./logout-button";

interface Subscription {
  tenantId: string;
  subsAccId: string;
  accName: string;
  role: string;
  perm: string;
  verified: boolean;
  scaffolded: boolean;
}

export default function WorkspacePicker({ email }: { email: string }) {
  const router = useRouter();
  const [subscriptions, setSubscriptions] = useState<Subscription[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [entering, setEntering] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/subscriptions");
        if (res.status === 401) {
          router.push("/signin");
          return;
        }
        if (!res.ok) {
          const data = await res.json().catch(() => null);
          setError(data?.error ? String(data.error) : "Couldn't load your workspaces.");
          return;
        }
        const data = await res.json();
        setSubscriptions(Array.isArray(data.subscriptions) ? data.subscriptions : []);
      } catch {
        setError("Can't reach the gateway right now.");
      }
    })();
  }, [router]);

  async function onPick(sub: Subscription) {
    if (entering) return;
    setEntering(true);
    const workspace: Workspace = { t: sub.tenantId, s: sub.subsAccId, r: sub.role as Workspace["r"] };
    const conversation = await createConversation(workspace);
    router.push(`/chat/session${fragmentHash(workspace, conversation.id)}`);
  }

  return (
    <Box display="flex" flexDirection="column" minHeight="100vh" bgcolor="background.default">
      <Stack
        direction="row"
        alignItems="center"
        justifyContent="space-between"
        spacing={1}
        px={3}
        py={2}
        borderBottom={1}
        borderColor="divider"
      >
        <Stack direction="row" alignItems="center" spacing={1}>
          <Logo size={32} />
          <Typography variant="subtitle1" fontWeight={600} noWrap>
            zombie-crab chat
          </Typography>
        </Stack>
        <Stack direction="row" alignItems="center" spacing={1.5}>
          <Typography variant="body2" color="text.secondary" noWrap title={email}>
            {email}
          </Typography>
          <LogoutButton />
        </Stack>
      </Stack>

      <Container maxWidth="sm" sx={{ py: 5, flex: 1 }}>
        <Typography variant="h5" gutterBottom>
          Choose a workspace
        </Typography>
        <Typography variant="body2" color="text.secondary" mb={3}>
          Pick a subscription to start chatting. Each workspace is isolated to its tenant and agent.
        </Typography>

        {error && <Alert severity="error">{error}</Alert>}

        {!error && subscriptions === null && (
          <Box display="flex" justifyContent="center" pt={4}>
            <CircularProgress size={28} />
          </Box>
        )}

        {!error && subscriptions !== null && subscriptions.length === 0 && (
          <Alert severity="info">
            You aren&apos;t licensed into any workspaces yet -- ask an operator to add you to one.
          </Alert>
        )}

        {!error && subscriptions !== null && subscriptions.length > 0 && (
          <Stack spacing={1.5}>
            {subscriptions.map((sub) => (
              <Card key={`${sub.subsAccId}:${sub.role}`} variant="outlined">
                <CardActionArea onClick={() => onPick(sub)} disabled={entering} sx={{ p: 2 }}>
                  <Stack direction="row" alignItems="flex-start" justifyContent="space-between" spacing={1}>
                    <Box minWidth={0}>
                      <Typography variant="subtitle1" fontWeight={600} noWrap>
                        {sub.accName || sub.subsAccId}
                      </Typography>
                      <Typography variant="body2" color="text.secondary">
                        agente {sub.role}
                      </Typography>
                      <Typography variant="caption" color="text.secondary" noWrap display="block">
                        tenant {sub.tenantId}
                        {sub.perm ? ` · ${sub.perm}` : ""}
                      </Typography>
                    </Box>
                    <Chip
                      label={sub.verified ? "verified" : "unverified"}
                      size="small"
                      variant="outlined"
                      color={sub.verified ? "primary" : "default"}
                      sx={{ height: 20, fontSize: 11 }}
                    />
                  </Stack>
                </CardActionArea>
              </Card>
            ))}
          </Stack>
        )}
      </Container>
    </Box>
  );
}
