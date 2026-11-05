# Design, worked for one project: asdlc-dashboard

**Illustrative only.** This shows what the `design` skill's steps produce for one project: a
read-only work board for a beads database, run on a Mac, whose Windows feature asks for several
native windows that remember their position and size. Never treat its platform, stack or runtime as
a default for another. Targets marked *assumed* stand in for the operator's real answers.

## Decision record sketch: runtime packaging

**Context.** The workflow's default runtime is a local container. The Windows feature requires
multiple native windows, with position and size that persist on macOS.

**Options.**

1. **Web app served from a local container, opened in a browser.** Meets the default runtime. A
   browser page can't reliably set its own window position, so the window-persistence criterion
   fails or must be reworded, and "multiple windows" becomes multiple browser windows. The container
   also needs read access to each beads database on the host, which means a bind mount per project.
2. **Desktop app shell** (Electron, Tauri, or native Swift, for example). Meets the window criteria.
   Native UI tests need a macOS CI runner. Non-UI tests can still run in a container.
3. **Option 1, with the window criteria reworded or moved to non-goals.**

**Decision.** For the operator at Gate 2.

## NFR selection (excerpt)

| NFR | Applies? | Reason | Target | Fitness function |
|---|---|---|---|---|
| Performance | Baseline | | Board renders 2,000 open issues in under 500 ms on the reference machine (*assumed*) | Render benchmark in CI |
| Observability | Baseline | | Every failure to read a database is logged with the path and the cause | Functional test asserts the log entry when the database is locked |
| Data consistency | Applies | The board must reflect changes made with bd | Changes appear on the board within 2 s (*assumed*) | Integration test changes an issue with bd and asserts the board updates |
| Durability | Applies narrowly | Only the app's own window state; the beads data isn't the app's to keep | Window state survives an app restart | Integration test: save state, restart, restore |
| Security | Floor only | Local, single-user, read-only access to local files | | |
| Availability | Does not apply | Local, single-user, no hosting tier | | |
| Scalability / Elasticity | Does not apply | Single user; scale is covered by the performance target | | |
| Usability | Applies | Most criteria are interaction behaviour | The criteria are the targets | Functional UI tests, plus manual-verify items |
