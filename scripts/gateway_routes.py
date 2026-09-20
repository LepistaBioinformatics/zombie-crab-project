#!/usr/bin/env python3
"""Every member-facing proxy route must be reachable through the gateway.

The gateway matches a request against an explicit per-role path list and answers
400 "Request path does not match any service" for anything absent. A route added
to crab-shell-proxy and not to that list is therefore not merely unprotected --
it does not exist, for every caller outside the docker network. It fails in
production only, it fails identically for a typo and for an omission, and the
error names neither the route nor the gateway.

That has happened three times: /v1/chat/cancel (Stop did nothing, under either
harness) and /v1/turns/active and /v1/turns/running with it.

So: read the routes out of crab-shell-proxy's mux, read the paths out of every
deployment config, and fail when one is in the first and not the second.

NOT_EXPOSED is the other half. Some routes are deliberately unreachable from
outside -- a webhook the gateway itself calls, the MCP endpoint an agent
container reaches on the docker network. Listing them here is what makes the
difference between "not exposed" and "forgotten" a decision somebody wrote down.
"""

import re
import sys
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MUX = ROOT / "crab" / "crab-shell-proxy" / "internal" / "httpapi"
CONFIGS = [
    ROOT / "deploy" / "prod" / "config.base.toml",
    ROOT / "deploy" / "standalone" / "config.standalone.toml",
]

# Reached on the docker network or by the gateway itself, never by a member's
# browser. Each entry is a decision, not a backlog.
NOT_EXPOSED = {
    # The subscriptionAccount.created webhook. Mycelium posts it to the proxy
    # directly; it authenticates with CRAB_WEBHOOK_SECRET, not a member session.
    ("POST", "/v1/accounts"),
    # The memory-graph MCP endpoint. An agent container calls it over zombie_net
    # with an mcptoken minted for its own workspace.
    ("POST", "/v1/mcp"),
    ("GET", "/v1/mcp"),
    # harness-sphere's inventory. Gated by CRAB_TELEMETRY_TOKEN and reached on
    # zombie_net; unset, the route is not registered at all. Never a member's.
    ("GET", "/v1/instances"),
    # The member's own scheduled-task WRITES, and this one is a deferral rather
    # than a decision about authority.
    #
    # Nothing in the webapp calls them yet -- the tasks panel lists and does not
    # edit -- and they cannot simply be added. /v1/cron/* already answers for
    # /v1/cron/tasks, and mycelium's matcher filters by PATH ALONE and then
    # errors on more than one hit ("Multiple routes found for the specified
    # path", routes_read.rs match_single_path_or_error). A second block for the
    # same path would not add methods to it; it would 500 the listing that works
    # today.
    #
    # So exposing them means splitting the wildcard into /v1/cron/runs and
    # /v1/cron/tasks -- and then deciding what a read-only member may do, since
    # one block carries one permission and GET and POST would share it. That is
    # a decision to make with the UI that needs it, not ahead of it.
    ("POST", "/v1/cron/tasks"),
    ("PATCH", "/v1/cron/tasks"),
    ("DELETE", "/v1/cron/tasks"),
}

ROUTE = re.compile(r'mux\.HandleFunc\(\s*"(GET|POST|PUT|PATCH|DELETE) (/v1/[^"]*)"')


def proxy_routes() -> set[tuple[str, str]]:
    found = set()
    for path in sorted(MUX.glob("*.go")):
        if path.name.endswith("_test.go"):
            continue
        for method, route in ROUTE.findall(path.read_text()):
            found.add((method, route))
    return found


def gateway_paths(config: Path) -> dict[str, set[tuple[str, str]]]:
    """role -> {(method, path)}, with Go's {id} wildcards left as the config writes them."""
    doc = tomllib.loads(config.read_text())
    out: dict[str, set[tuple[str, str]]] = {}
    for role, value in doc.items():
        if not isinstance(value, list):
            continue
        for service in value:
            if not isinstance(service, dict) or "path" not in service:
                continue
            entries = out.setdefault(role, set())
            for block in service["path"]:
                for method in block["methods"]:
                    entries.add((method, block["path"]))
    return out


def covers(pattern: str, route: str) -> bool:
    """Whether a gateway path block answers for a proxy route.

    Mycelium matches with the wildmatch crate, where `*` spans path separators --
    so /v1/models/* answers for /v1/models/mine/selection. A proxy route's own
    {id} segment is a wildcard on the other side: /v1/projects/{id} is reached
    through /v1/projects/*.
    """
    if pattern.endswith("*"):
        return route.startswith(pattern[:-1])
    return pattern == re.sub(r"\{[^}]*\}", "*", route) or pattern == route


def main() -> int:
    routes = {r for r in proxy_routes() if r not in NOT_EXPOSED}
    # Admin routes live under their own prefix and are covered by one block each;
    # they are checked the same way as everything else.
    failures = []
    for config in CONFIGS:
        if not config.exists():
            failures.append(f"{config}: missing")
            continue
        by_role = gateway_paths(config)
        if not by_role:
            failures.append(f"{config}: declares no service with a path list")
            continue
        for role, allowed in sorted(by_role.items()):
            for method, route in sorted(routes):
                if not any(m == method and covers(p, route) for m, p in allowed):
                    failures.append(
                        f"{config.relative_to(ROOT)}: role {role!r} cannot reach "
                        f"{method} {route}"
                    )
            # AMBIGUITY IS A 500, not a 400, and it is the trap the next person
            # adding a route falls into: mycelium matches on the path alone and
            # then refuses when more than one block answers for it
            # ("Multiple routes found for the specified path"). So a block added
            # beside an existing wildcard does not extend it -- it breaks it.
            for method, route in sorted(routes):
                hits = {p for _, p in allowed if covers(p, route)}
                if len(hits) > 1:
                    failures.append(
                        f"{config.relative_to(ROOT)}: role {role!r} has {len(hits)} blocks "
                        f"matching {route} ({', '.join(sorted(hits))}) — mycelium answers "
                        f"500, not the first match"
                    )

    if failures:
        print("Routes the proxy serves that the gateway would answer 400 for:\n")
        for line in failures:
            print("  " + line)
        print(
            "\nAdd a [[<role>.path]] block for each, or list it in NOT_EXPOSED in "
            f"{Path(__file__).relative_to(ROOT)} if it is deliberately unreachable."
        )
        return 1

    print(f"{len(routes)} proxy routes, all reachable in every deployment config.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
