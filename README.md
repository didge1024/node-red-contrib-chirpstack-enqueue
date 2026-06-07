# node-red-contrib-chirpstack-enqueue

A Node-RED node for enqueuing **unicast downlinks** to ChirpStack devices via the **v4 gRPC API**.

## Features

- Send unicast downlinks to a specific device EUI or device name
- Automatic device name resolution (searches accessible applications)
- Hex / base64 / UTF-8 / Buffer payload auto-detection
- Optional confirmed downlinks
- Per-message overrides for server, API key, device, fPort, and more

---

## Nodes

### `chirpstack-server` (Config Node)

Stores shared connection settings:

- **Server** — ChirpStack gRPC endpoint (e.g. `chirpstack:8080`)
- **API Token** — Bearer token (stored as Node-RED credentials)

---

### `chirpstack-enqueue`

Enqueues a unicast downlink for a specific device.

**Inputs**

| Property | Source | Description |
|----------|--------|-------------|
| payload | `msg.payload` or `msg.payload.data` | Data to send (hex, base64, UTF-8, or Buffer) |
| devEui | `msg.devEui` or `msg.devName` | Device EUI (16-char hex) or device name |
| applicationId | `msg.applicationId` | Optional — scope name lookup to one application |
| fPort | `msg.fPort` or `msg.payload.fPort` | LoRaWAN FPort (1–223) |
| confirmed | `msg.confirmed` or `msg.payload.confirmed` | Request downlink acknowledgment |
| apiKey | `msg.apiKey` | Override Bearer token for this message |
| server | `msg.server` | Override gRPC server (creates a temporary client) |

**Outputs**

- `msg.payload.success` — `true` if enqueue succeeded
- `msg.payload.id` — UUID of the enqueued downlink
- `msg.payload.fCnt` — frame counter (if returned)
- `msg.payload.devEui` — resolved device EUI
- `msg.error` — error details on failure

**Device Name Resolution**

If the device identifier is not a 16-character hex EUI, the node treats it as a device name. It calls `ApplicationService.List` to find all applications accessible to the token, then searches each for a matching device name. Provide an **Application ID** to skip the listing and search only that application.

---

## Installation

```bash
npm install node-red-contrib-chirpstack-enqueue
```

Or copy into your Node-RED user directory:

```
~/.node-red/node_modules/node-red-contrib-chirpstack-enqueue/
```

Then restart Node-RED.

---

## Payload Detection

The node auto-detects the format of `msg.payload`:

| Format | Detection | Example |
|--------|-----------|---------|
| Buffer | `Buffer.isBuffer()` | `Buffer.from([0x01, 0x02])` |
| Hex string | Even-length, all hex chars | `"0102030405060708"` |
| Base64 | Valid base64 pattern | `"AQIDBA=="` |
| UTF-8 | Fallback | `"hello"` |

> **Note:** Short all-alphanumeric strings (e.g. `"ON"`) are detected as base64, not UTF-8. Use a hex string or Buffer to send short ASCII text reliably.

---

## License

MIT
