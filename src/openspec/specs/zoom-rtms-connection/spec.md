# zoom-rtms-connection

## Purpose

Establish and maintain the Zoom side of live transcription: a webhook endpoint (URL validation and signature verification), the RTMS signaling/media WebSocket handshake, transcript stream subscription, keep-alive, reconnection, and teardown when the meeting ends.

## Requirements

### Requirement: Zoom webhook endpoint with URL validation
The server SHALL expose a Zoom webhook endpoint that answers Zoom's `endpoint.url_validation` challenge by returning the plain token and its HMAC-SHA256 hash computed with the configured webhook secret token.

#### Scenario: URL validation challenge succeeds
- **WHEN** Zoom sends an `endpoint.url_validation` event with a `plainToken`
- **THEN** the endpoint responds 200 with the `plainToken` and the correctly computed `encryptedToken`, and Zoom marks the endpoint validated

### Requirement: Webhook signature verification
The webhook endpoint SHALL verify the `x-zm-signature` header (and its timestamp) on every non-validation event using the webhook secret token, and MUST reject events with missing or invalid signatures without acting on them.

#### Scenario: Invalid signature rejected
- **WHEN** a webhook request arrives whose signature does not match the computed signature for its body and timestamp
- **THEN** the server responds with an error status and does not start, stop, or modify any RTMS connection

### Requirement: RTMS stream connection on meeting start
When a `meeting.rtms_started` event is received and the Zoom integration is enabled, the server SHALL complete the RTMS handshake: connect to the signaling WebSocket, authenticate with a signature derived from the configured client credentials and the event's meeting UUID and stream id, connect to the media WebSocket it is directed to, and subscribe to the transcript data stream.

#### Scenario: Successful connection
- **WHEN** a valid `meeting.rtms_started` event arrives with meeting UUID, stream id, and server URLs
- **THEN** the server establishes signaling and media connections, subscribes to transcript data, and reports the live source as connected

#### Scenario: Integration disabled
- **WHEN** `meeting.rtms_started` arrives while the Zoom integration feature flag is off
- **THEN** the server acknowledges the webhook but establishes no connection

### Requirement: Keep-alive and reconnection
The RTMS client SHALL respond to keep-alive requests on its sockets, and on unexpected socket loss while the meeting is still live it SHALL attempt reconnection with bounded exponential backoff, reporting the live source as disconnected while retrying.

#### Scenario: Socket drop mid-meeting
- **WHEN** the media WebSocket closes unexpectedly before any `meeting.rtms_stopped` event
- **THEN** the live source is reported disconnected and the client retries the handshake with backoff until it reconnects or the meeting ends

### Requirement: Teardown on meeting end
When a `meeting.rtms_stopped` event is received for the active stream, the RTMS client SHALL close its sockets, stop reconnection attempts, and report the live source as no longer connected. The session itself SHALL NOT be auto-finished.

#### Scenario: Meeting ends
- **WHEN** `meeting.rtms_stopped` arrives for the currently connected stream
- **THEN** all RTMS sockets are closed, no reconnects are attempted, the live source state leaves connected, and the session status remains unchanged
