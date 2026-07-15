"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Logo from "@/app/logo";
import Box from "@mui/material/Box";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import TextField from "@mui/material/TextField";
import Button from "@mui/material/Button";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import List from "@mui/material/List";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemText from "@mui/material/ListItemText";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import AddCommentIcon from "@mui/icons-material/AddComment";
import { INSTANCES, type Instance } from "@/lib/mycelium";
import {
  createConversation,
  listConversations,
  onConversationsUpdated,
  type ConversationSummary,
} from "@/lib/chatSession";
import LogoutButton from "./logout-button";

export default function Sidebar({ email }: { email: string }) {
  const router = useRouter();
  const params = useParams<{ sessionId?: string }>();
  const activeSessionId = params?.sessionId;

  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [newChatAnchor, setNewChatAnchor] = useState<HTMLElement | null>(null);
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<ConversationSummary[] | null>(null);
  const [searching, setSearching] = useState(false);

  function refresh() {
    listConversations().then(setConversations);
  }

  useEffect(() => {
    refresh();
    return onConversationsUpdated(refresh);
  }, []);

  // Full-content search: fires a debounced fetch of every conversation's
  // history and filters by substring match (title or message content) --
  // see .specs/features/chat-ui-redesign/spec.md "Full-content search".
  useEffect(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      setSearchResults(null);
      return;
    }

    let cancelled = false;
    const timeout = setTimeout(async () => {
      setSearching(true);
      const all = await listConversations();
      const results = await Promise.all(
        all.map(async (conversation) => {
          if (conversation.title.toLowerCase().includes(q)) return conversation;
          try {
            const res = await fetch(
              `/api/chat/${conversation.instance}/history?session_id=${encodeURIComponent(conversation.id)}`,
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
  }, [query]);

  const visible = searchResults ?? conversations;

  async function onPickAgent(instance: Instance) {
    setNewChatAnchor(null);
    const conversation = await createConversation(instance);
    router.push(`/chat/${instance}/${conversation.id}`);
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
        <Button
          fullWidth
          variant="outlined"
          startIcon={<AddCommentIcon />}
          onClick={(e) => setNewChatAnchor(e.currentTarget)}
        >
          New chat
        </Button>
        <Menu anchorEl={newChatAnchor} open={!!newChatAnchor} onClose={() => setNewChatAnchor(null)}>
          {INSTANCES.map((instance) => (
            <MenuItem key={instance} onClick={() => onPickAgent(instance)} sx={{ textTransform: "capitalize" }}>
              {instance}
            </MenuItem>
          ))}
        </Menu>
      </Box>

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
                onClick={() => router.push(`/chat/${conversation.instance}/${conversation.id}`)}
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
                      label={conversation.instance}
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
