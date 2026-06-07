# Design: Device Resolution & Full Message Override

**Date:** 2026-05-21
**Scope:** `chirpstack-enqueue` node — add device name resolution and make all inputs overridable per-message

---

## Overview

Extend the existing `chirpstack-enqueue` node to:
1. Accept a device identifier as either an EUI (16-char hex) or a human-readable device name
2. Resolve names to EUIs by searching all applications accessible to the API token's tenant (optionally scoped to a specific application)
3. Make every configurable value overridable via incoming message properties

The `chirpstack-server` config node remains as the default source for server address and API key. No new nodes are added.

---

## Input Resolution

All values follow the same priority order: **msg property → node config → server config node (server/apiKey only)**.

| Value | msg property | Node config field | Server config fallback |
|---|---|---|---|
| Server address | `msg.server` | — | `serverConfig.server` |
| API key | `msg.apiKey` | — | `serverConfig.apiKey` |
| Device identifier | `msg.devEui` or `msg.devName` | `config.devEui` / `config.devName` | — |
| Application ID | `msg.applicationId` | `config.applicationId` | — |
| fPort | `msg.fPort` / `msg.payload.fPort` | `config.fPort` (default: 10) | — |
| Confirmed | `msg.confirmed` / `msg.payload.confirmed` | `config.confirmed` (default: false) | — |
| Payload data | `msg.payload.data` or `msg.payload` | — | — |

**Device identifier detection:** if the resolved value matches `/^[0-9a-fA-F]{16}$/`, treat it as an EUI. Otherwise treat it as a device name and perform a lookup.

---

## Device Name Resolution Flow

Triggered only when the device identifier is not a 16-char hex EUI.

1. Build gRPC metadata with the resolved API key (Bearer token)
2. Call `ApplicationService.List` — returns all applications the token can access within its tenant
   - If `applicationId` is provided, skip this call and use it directly as the only application to search
3. For each application, call `DeviceService.List` with `applicationId` filter
   - Match on `device.name === resolvedIdentifier`
   - Stop at first match
4. If no match is found across all applications, emit an error and set node status to red
5. Use the matched device's `devEui` for the enqueue call

**Error cases:**
- No applications found → error "No applications accessible for this token"
- Name not found in any application → error "Device name not found: <name>"
- Multiple matches are impossible since stop-at-first-match is used; name uniqueness within a tenant is the user's responsibility

---

## Enqueue Call

Unchanged from current implementation. Uses `DeviceService.enqueue` with:
- `devEui` (resolved)
- `fPort`
- `confirmed`
- `data` (Buffer, auto-detected from hex/base64/UTF-8/Buffer input)

gRPC credentials remain `createInsecure()`. TLS is not in scope.

---

## Output

**On success:**
```js
msg.payload = {
  success: true,
  id: "<uuid>",          // UUID of the enqueued downlink message
  devEui: "<hex>",
  fPort: <number>,
  confirmed: <boolean>,
  timestamp: "<ISO8601>"
}
```

**On error:**
```js
msg.payload = { success: false }
msg.error = {
  message: "<string>",
  code: <grpc-status-code>,   // undefined for non-gRPC errors
  details: "<string>"         // undefined for non-gRPC errors
}
```

---

## Node UI Changes

The `chirpstack-enqueue` HTML template gains:
- **Device identifier field**: single text input replacing the current `devEui` field; label updated to "Device EUI or Name"
- **Application ID field**: optional text input for scoping name lookups
- Help text updated to document `msg.server`, `msg.apiKey`, `msg.devEui`/`msg.devName`, `msg.applicationId` overrides

The `chirpstack-server` config node is unchanged.

---

## Files Changed

| File | Change |
|---|---|
| `chirpstack-enqueue.js` | Add `ApplicationService` import, device resolution function, msg-level auth/server overrides |
| `chirpstack-enqueue.html` | Update device field label, add applicationId field, update help text |

---

## Out of Scope

- TLS / secure gRPC connections
- Caching of name→EUI lookups
- Per-message gRPC client creation (client is still created once at node initialization; server/apiKey overrides require a node redeploy to take effect on the gRPC channel — see note below)

**Note on per-message server/apiKey:** The node initializes a default gRPC client at startup using the server config node. On each incoming message, if `msg.apiKey` differs from the config, it is used in the gRPC metadata for that call only (no new client needed — the Bearer token is per-call metadata). If `msg.server` differs from the configured server address, a temporary gRPC client is created for that message and closed immediately after the call completes. This satisfies the "make everything overridable" requirement at the cost of one extra client creation when server address differs per-message.
