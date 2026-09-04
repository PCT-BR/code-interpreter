# Railway Deployment

This repository is a multi-service Code API stack. Railway's automatic
Railpack detection is not enough because the root `package.json` has no app
start script and the real entry points live in component Dockerfiles.

The supported Railway shape is a control-plane deployment with a remote bridge:

- `code-interpreter`: public/private Code API HTTP service
- `codeapi-file-server`: file relay backed by MinIO
- `codeapi-tool-call-server`: programmatic tool-call callback server
- `codeapi-minio`: S3-compatible object storage for Code API files
- `codeapi-redis`: Redis for queues, bridge pairing, leases, and replay state
- a separate VM/VPS running `@librechat/code` as the actual sandbox worker

The sandbox worker should run outside Railway because the native sandbox modes
need `/dev/kvm`, `unshare`, cgroups, and NsJail-related host support that
Railway app containers should not be assumed to provide.

## Prepare Railway

Run a dry-run first:

```bash
node scripts/railway-ready.mjs --dry-run
```

Apply the setup:

```bash
node scripts/railway-ready.mjs --apply
```

The script:

- creates the missing Railway services;
- creates a Redis database service;
- sets `RAILWAY_DOCKERFILE_PATH` for each component;
- generates Code API internal, bridge, JWT, MinIO, and manifest secrets;
- configures LibreChat to sign Code API JWTs.

It deliberately does not print generated secret values.

## LibreChat

LibreChat should point to the Code API service over Railway private networking:

```dotenv
LIBRECHAT_CODE_BASEURL=http://code-interpreter.railway.internal:3112/v1
```

For attached stateful environments, add an Agents environment in
`librechat.yaml`:

```yaml
endpoints:
  agents:
    capabilities:
      - execute_code
      - stateful_code_sessions
    statefulCodeSessions:
      environments:
        - id: pct-vm
          name: PCT VM
          type: attached
          baseURL: http://code-interpreter.railway.internal:3112/v1
          default: true
```

## VM/VPS Worker

After the Railway services are deployed, create a single-use bridge pairing
code:

```bash
curl -fsS http://code-interpreter.railway.internal:3112/v1/bridge/pairings \
  -H "Authorization: Bearer $CODEAPI_BRIDGE_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"workerId":"pct-vm"}'
```

Redeem that pairing code on the VM/VPS with `@librechat/code`.

Use a Linux VM with the sandbox dependencies documented in
`docs/remote-bridge/README.md`. The VM keeps execution local and connects
outbound to Code API, so it does not need a public inbound port.
