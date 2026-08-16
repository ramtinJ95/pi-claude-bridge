# Pi 0.84 compatibility baseline

The fork requires Pi 0.84.2 or newer and develops against exact 0.84.2 versions
of `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and
`@earendil-works/pi-tui`. Pi 0.84.2 requires Node.js 22.19 or newer, so the
extension now declares the same runtime floor.

The offline unit suite launches the repository-local Pi CLI in an isolated
temporary agent directory, loads `src/index.ts`, and verifies that the
`claude-bridge` models are registered. Test output also records the installed Pi
packages, Agent SDK, and the Claude Code version bundled by that SDK.

## Provider lifecycle hooks

Pi 0.84.2 says custom `streamSimple` providers must:

1. Call `SimpleStreamOptions.onPayload` before sending the provider request and
   use any returned replacement payload.
2. Call `SimpleStreamOptions.onResponse` after receiving the HTTP response and
   before consuming its body.

The bridge cannot currently implement either contract faithfully:

| Hook | Support | Reason |
| --- | --- | --- |
| `onPayload` | Unsupported | The Agent SDK accepts a Claude query and owns construction of the provider wire request. It does not expose that final payload or a supported replacement hook. |
| `onResponse` | Unsupported | The Agent SDK does not expose the underlying HTTP response, status, or headers before consuming the body. |

Consequently, Pi extensions using `before_provider_request` or
`after_provider_response` do not observe Claude Bridge provider traffic. The
bridge deliberately does not invoke those callbacks with a synthetic query
object, fake HTTP status, or invented headers: doing so would violate payload
replacement semantics and make telemetry misleading.

`tests/unit-provider-hook-contract.mjs` pins both sides of this adapter gap and
asserts that the actual provider adapter does not invoke either callback. It
also pins the exact Agent SDK version for which its declarations were manually
reviewed. Any SDK upgrade must update that review gate after checking for
request, response, fetch, transport, or differently named interception APIs;
the absence of three familiar property names is not treated as proof. Until a
supported adapter API exists, resolving the gap is not a truthful bridge-only
shim.
