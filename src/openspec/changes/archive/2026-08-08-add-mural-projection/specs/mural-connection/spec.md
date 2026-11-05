# mural-connection

## ADDED Requirements

### Requirement: OAuth authorization with Mural
The server SHALL implement Mural's OAuth 2.0 Authorization Code flow with PKCE, using client credentials supplied via environment variables. The server SHALL expose a connect endpoint that redirects the user to Mural's authorization page requesting `murals:read` and `murals:write` scopes, and a callback endpoint that exchanges the authorization code for tokens. Tokens MUST be stored server-side only and MUST never be sent to the browser.

#### Scenario: Successful authorization
- **WHEN** the user initiates the Mural connect flow and approves access on Mural's authorization page
- **THEN** the server exchanges the code for access and refresh tokens, persists them server-side, and the UI reflects a connected state

#### Scenario: Authorization denied or failed
- **WHEN** the user denies authorization or the code exchange fails
- **THEN** the server records no tokens, surfaces a clear error in the connect flow, and the session continues to function without Mural

### Requirement: Token refresh
The server SHALL refresh the Mural access token before its 15-minute expiry using the stored refresh token, and SHALL also refresh reactively when a Mural API call returns 401 and retry the call once. If refresh fails, the connection SHALL be marked degraded without disrupting the session.

#### Scenario: Proactive refresh
- **WHEN** a Mural API call is about to be made and the access token expires within 2 minutes
- **THEN** the server refreshes the token first and proceeds with the call using the new token

#### Scenario: Refresh failure
- **WHEN** a token refresh attempt fails
- **THEN** the projector is marked degraded, the failure is logged, and canvas processing, SSE broadcast, and all agents continue unaffected

### Requirement: Session-to-mural binding
The server SHALL allow a session to be bound to a target mural (by mural id), verify the mural is reachable with the current token, and persist the binding in the session snapshot. On binding, the server SHALL trigger a full backfill projection of the current canvas onto the mural.

#### Scenario: Bind and backfill
- **WHEN** a session with existing canvas content is bound to a mural
- **THEN** the entire current canvas is projected onto the mural and subsequent canvas revisions are projected incrementally

#### Scenario: No binding
- **WHEN** no mural is bound to the session
- **THEN** the projector stays idle and the application behaves exactly as before this change
