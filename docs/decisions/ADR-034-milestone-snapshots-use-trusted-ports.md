# ADR-034: Milestone Snapshots Use Trusted Ports

Status: accepted

## Context

`project.snapshot.captured` and the Library filmstrip existed without a capture
pipeline. Its `image` field accepted any string, and the macOS application has
no desktop-capture permission. Expanding OS permissions would capture more than
the project surface and weaken the local trust boundary.

## Decision

Only `knowledge.created(type=milestone)` automatically triggers a visual
checkpoint. A capture service subscribes to immutable events and composes three
trusted ports:

```
milestone event
  → ProjectSnapshotRenderer.capture
  → ProjectSnapshotStorage.persist
  → ProjectSnapshotWriter.append(project.snapshot.captured)
```

Frames are bounded PNG/JPEG rasters. Storage returns a canonical relative
`snapshots/` URI; absolute paths, remote URLs, traversal and duplicate separators
are rejected before append. The resulting event is caused by the milestone and
uses `snapshot:<milestone-event-id>` as its idempotency token.

The renderer adapter owns which already-authorized project surface it captures.
The formal service does not grant screen-recording permission and does not put
image bytes in the permanent event log.

## Alternatives

**Capture every completed task.** Rejected: routine work would create noisy and
expensive visual history.

**Store data URLs in events.** Rejected: large binary payloads do not belong in
the append-only coordination log.

**Grant macOS desktop capture.** Rejected: the milestone needs a project visual,
not ambient access to other applications.

## Consequences

- Milestone knowledge is the single automatic trigger.
- Renderer and storage failures produce no snapshot event.
- Retry safety is delegated to the durable writer using the stable token.
- Platform adapters can evolve without changing the event contract.
