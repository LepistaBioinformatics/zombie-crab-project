"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Logo from "@/app/logo";
import Box from "@mui/material/Box";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import TextField from "@mui/material/TextField";
import Button from "@mui/material/Button";
import List from "@mui/material/List";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemText from "@mui/material/ListItemText";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import AddCommentIcon from "@mui/icons-material/AddComment";
import SwapHorizIcon from "@mui/icons-material/SwapHoriz";
import {
  createConversation,
  listConversations,
  onConversationsUpdated,
  type ConversationSummary,
} from "@/lib/chatSession";
import { useFragment, toWorkspace, setFragmentSid, historyQuery } from "./fragment";
import LogoutButton from "./logout-button";

export default function Sidebar({ email }: { email: string }) {
  const router = useRouter();
  const fragment = useFragment();
  const workspace = fragment ? toWorkspace(fragment) : null;
  const activeSessionId = fragment?.sid;

  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<ConversationSummary[] | null>(null);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    if (!workspace) return;
    const refresh = () => listConversations(workspace).then(setConversations);
    refresh();
    return onConversationsUpdated(refresh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace?.t, workspace?.s, workspace?.r]);

  // Full-content search: fires a debounced fetch of every conversation's
  // history and filters by substring match (title or message content) --
  // see .specs/features/chat-ui-redesign/spec.md "Full-content search".
  useEffect(() => {
    const q = query.trim().toLowerCase();
    if (!q || !workspace) {
      setSearchResults(null);
      return;
    }

    let cancelled = false;
    const timeout = setTimeout(async () => {
      setSearching(true);
      const all = await listConversations(workspace);
      const results = await Promise.all(
        all.map(async (conversation) => {
          if (conversation.title.toLowerCase().includes(q)) return conversation;
          try {
            const res = await fetch(
              `/api/chat/${conversation.role}/history?${historyQuery(workspace, conversation.id)}`,
            );
            if (!res.ok) return null;
            const data = await res.json();
            const messages: { content?: string }[] = Array.isArray(data.messages) ? data.messages : [];
            const matches = messages.some(
              (m) => typeof m.content === "string" && m.content.toLowerCase().includes(q),
            );
            return matches ? conversation : null;
          } catch {
            return null;
          }
        }),
      );
      if (!cancelled) {
        setSearchResults(results.filter((c): c is ConversationSummary => c !== null));
        setSearching(false);
      }
    }, 300);

    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, workspace?.t, workspace?.s, workspace?.r]);

  const visible = searchResults ?? conversations;

  async function onNewChat() {
    if (!workspace) return;
    const conversation = await createConversation(workspace);
    setFragmentSid(conversation.id);
  }

  return (
    <Stack height="100%">
      <Stack direction="row" alignItems="center" spacing={1} p={2}>
        <Logo size={32} />
        <Typography variant="subtitle1" fontWeight={600} noWrap>
          zombie-crab chat
        </Typography>
      </Stack>

      <Box px={2} pb={1}>
        <Chip
          label={`agente ${workspace?.r ?? ""}`}
          size="small"
          variant="outlined"
          color="primary"
          sx={{ textTransform: "capitalize", height: 20, fontSize: 11 }}
        />
      </Box>

      <Stack direction="row" spacing={1} px={2} pb={1}>
        <Button
          fullWidth
          variant="outlined"
          startIcon={<AddCommentIcon />}
          onClick={onNewChat}
          disabled={!workspace}
        >
          New chat
        </Button>
        <Button
          variant="outlined"
          onClick={() => router.push("/chat")}
          title="Switch workspace"
          sx={{ minWidth: 0, px: 1.5 }}
        >
          <SwapHorizIcon fontSize="small" />
        </Button>
      </Stack>

      <Box px={2} pb={1}>
        <TextField
          fullWidth
          size="small"
          placeholder="Search conversations"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </Box>

      <Stack direction="row" alignItems="center" spacing={1} px={2} pb={0.5}>
        <Box width={8} height={8} bgcolor="primary.main" flexShrink={0} />
        <Typography variant="caption" color="text.secondary" fontWeight={600} letterSpacing={0.6}>
          CONVERSATIONS
        </Typography>
      </Stack>

      <Box flex={1} overflow="auto">
        {searching && (
          <Box display="flex" justifyContent="center" py={2}>
            <CircularProgress size={20} />
          </Box>
        )}
        {!searching && visible.length === 0 && (
          <Typography variant="body2" color="text.secondary" textAlign="center" py={2}>
            {query.trim() ? "No matches." : "No conversations yet."}
          </Typography>
        )}
        <List dense disablePadding>
          {visible.map((conversation) => {
            const active = conversation.id === activeSessionId;
            return (
              <ListItemButton
                key={conversation.id}
                selected={active}
                onClick={() => setFragmentSid(conversation.id)}
                sx={{
                  borderLeft: 4,
                  borderColor: active ? "primary.main" : "transparent",
                }}
              >
                <ListItemText
                  primary={conversation.title}
                  primaryTypographyProps={{ noWrap: true }}
                  secondary={
                    <Chip
                      label={conversation.role}
                      size="small"
                      variant="outlined"
                      sx={{ textTransform: "capitalize", height: 18, fontSize: 11 }}
                    />
                  }
                />
              </ListItemButton>
            );
          })}
        </List>
      </Box>

      <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1} p={2}>
        <Typography variant="body2" color="text.secondary" noWrap title={email}>
          {email}
        </Typography>
        <LogoutButton />
      </Stack>
    </Stack>
  );
}
