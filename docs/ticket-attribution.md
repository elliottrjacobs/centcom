# Ticket agent and device attribution

Agent identity and device are independent. Use one stable identity for an agent across machines (`codex`, `claude-code`) and a distinct identity for each named bot (`research-bot`). Report the execution location separately as `device`, such as `Laptop`, `Desktop`, or `Build server`.

The ticket's assignee owns the work. Each activity event records the agent that performed that action and its optional device. These can differ from the assignee. A device is caller-reported attribution, not a verified hardware identity.

## Reporting from agents

CLI ticket commands accept `--as` and `--device`:

```sh
centcom ticket comment CEN-26 --as codex --device "Mac mini" --body "Reviewed the implementation."
CENTCOM_AGENT=codex CENTCOM_DEVICE="MacBook" centcom ticket start CEN-26
```

Device precedence is `--device`, then `CENTCOM_DEVICE`, then the hostname of the computer running the CLI. The local stdio MCP command uses the same client default. A remote HTTP MCP request has no default device: it must not attribute the caller to the backend host.

MCP `create_ticket`, `update_ticket`, and `comment_on_ticket` accept the separate optional `device` argument:

```json
{"id":"CEN-26","agent":"research-bot","device":"Build server","body":"Review complete."}
```

For REST, provide `device` alongside `createdBy` on create, `by` on update, or `agent` on comments. Delete accepts `by` and `device` query parameters. `agent` on a REST ticket create/update remains the assignee. Device values must contain 1–100 characters without control characters; surrounding whitespace is trimmed. Older callers may omit device.

## Apps and history

Mac/browser Settings → This device stores the device label locally. It starts blank because the browser cannot reliably identify the computer. iOS Settings → This device defaults to the system device name and supports renaming. Leaving the name blank omits attribution.

Ticket activity displays the acting agent and its device together. Ticket details show the last reported device and who reported it. This is the latest known report, not a claim that the agent is currently running there. An action without a device does not erase an earlier report.

Existing history and agent ids are preserved. Names such as `codex-laptop` are not split or migrated automatically, and missing devices remain unknown. Updating no fields produces no activity event; add a comment when recording work without a ticket field change.
