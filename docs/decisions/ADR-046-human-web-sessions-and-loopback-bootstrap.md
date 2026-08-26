# ADR-046: Human Web Sessions and Loopback Bootstrap

## Context

The Hub accepts a long-lived human bearer. The browser previously kept that
bearer in memory and required it again after every refresh. This is acceptable
for a protocol spike but is not a product entry: local users must read terminal
output, and production users repeatedly handle an operator credential.

The public shell must remain inert before authentication. Agent and Runner
credentials must never become browser sessions. Cross-origin applications must
not receive the human bearer through a URL, browser storage or server log.

## Decision

The Hub exchanges a valid human bearer for an opaque, bounded, in-memory web
session. The browser receives only an HttpOnly, SameSite=Strict cookie. The raw
bearer is submitted once in a TLS request body, cleared by the client and is
never returned. Restarting the Hub invalidates every web session.

Only a loopback request to a local-mode Hub with no configured human token may
bootstrap a session without a credential. Remote mode, production mode and an
explicit human token disable this route. This makes local first use zero
configuration without weakening the deployed trust boundary.

Cookie-authenticated writes require the existing exact Origin check. Bearer
authentication remains available for non-browser clients and compatibility.
Agent and Runner routes continue to require their existing bearer principals.

The macOS development surface reaches the Hub through a same-origin Vite proxy.
It consumes the existing authenticated event stream and command routes. It does
not introduce another state API or reducer.

## Alternatives

- Store the bearer in localStorage. Rejected: script compromise turns into a
  durable credential leak.
- Put the bearer in a URL query or persistent fragment. Rejected: links,
  history and screenshots become credential carriers.
- Add username/password storage to the Hub. Rejected for this milestone: it
  creates a second identity store without account recovery or administration.
- Auto-authenticate every loopback request. Rejected: unrelated local pages
  could drive the Hub. Bootstrap is a narrow session issuance action and all
  later writes retain Origin enforcement.

## Consequences

- Local entry is one click and production entry handles the bearer once.
- Sessions are deliberately lost on restart and must be re-established.
- Horizontal Hub replicas require a future shared or signed session mechanism.
- A full account system remains a separate product capability.
