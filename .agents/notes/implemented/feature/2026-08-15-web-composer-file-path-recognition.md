# Agent Note: Web composer highlights file paths and opens them on Ctrl/⌘+click

Status: implemented

English | [中文](2026-08-15-web-composer-file-path-recognition.zh.md)

## Problem

The composer's only attachment surface is image intake; everything else in the draft is plain text. A user who works by naming files — the documented way to hand the agent a document — typed a path and got no feedback that the composer recognised it: the path rendered like any other prose, and the only way to act on it was to send the whole message and wait for the agent's file tools. The plain-text-reference mechanism (`decorations.scanTextRefs`, the slash-pipeline note) already highlights `/name` and `@name` tokens against a hot lexicon, but paths are unbounded names that no lexicon can enumerate, so the mechanism cannot cover them. Users in this deployment actually type UNC and drive paths (`\\wsl.localhost\Ubuntu-22.04\…`, `C:\…`) as well as POSIX forms, so a forward-slash-only rule would miss the form the primary user's real files use.

## Decision

The composer scans the draft for path-shaped tokens as pure text and highlights them, and opens the path on Ctrl/⌘+click.

`decorations.scanPathRefs(draft)` recognises two structural families with at least two non-empty segments: the forward-slash family (`/a/b`, `./x/y`, `../x/y`, `~/x/y`) and the backslash family (UNC `\\server\share\…`, drive `X:\…` and `X:/…`). It never matches single-segment `/name` command tokens, URL remnants (`https://…`, protocol-relative `//…`), a bare drive root (`C:\`), or lone backslashes, and it trims trailing sentence punctuation (`open /tmp/a/b.docx.` highlights `/tmp/a/b.docx`). The scan is purely structural — no filesystem resolution at keystroke time — so a stale or moved path still highlights, the highlight can never fail on the file's state, and the host owns reality.

`DraftDecorations` gains `pathRefs`; the InputBar backdrop renders each range as a `.pathRef` mark (a light tint plus dotted underline, distinct from the command/mention `.textRef` mark, same two-layer advance contract) and gives it a title tooltip. Two overlap rules keep the decoration sources disjoint: a chip placeholder (U+FFFC) is a path-continuation boundary, so a path token can never span a chip; and a same-start text-ref that is a strict prefix of a path ref (`/plan` on the lexicon inside `/plan/assets`) is dropped at derivation — the path is the more specific reading — so what renders is exactly what Ctrl/⌘+click hit-tests. Because the textarea overlays the backdrop, the open gesture lives on the textarea: Ctrl/⌘+click with the caret inside a highlighted range calls the new `openPath` callback injected through `ComposerBarInjected`. `apply.ts` wires it to `ctx.workspaces.openPath` through the same `resolveWorkspacePath(cwd, path)` resolution the assistant file-mention open uses — the scan preserves `./`/`../`/`~/` prefixes and the host opener has no session context, so the token resolves against the session cwd before the host handoff — with the same silent catch as assistant file mentions, so a path the host cannot resolve opens nothing and never surfaces a composer error.

The feature is decoration plus a host-side open verb. It introduces no file row, no file input, no upload protocol, and no change to the plus-button Command launcher: a user who wants the agent to *read* a file still sends the path as a message (the agent's file tools are the reader); the highlight and open exist to confirm recognition and to reach the file in the host OS without leaving the draft.

## Alternatives considered

**Resolve each path against a client-side workspace file index and highlight only existing files.** Requires a directory listing per keystroke or a full workspace index in the browser, cannot know existence for UNC or drive paths (which are not under the connected workspace), and makes the decoration async and failure-prone. The structural scan keeps the render path synchronous, side-effect-free, and truthful only about shape; existence is the host's job at open time.

**Extend the lexicon roster so `scanTextRefs` covers paths.** A hot lexicon is an exact-name membership list; paths are unbounded names that would have to be enumerated per draft, which is exactly what the plain-text-reference decision avoids. Path recognition is structural, not roster-based, so it lives in its own scan beside `scanTextRefs` rather than inside it.

**Open on plain click (no modifier).** The textarea's primary click job is caret placement; hijacking it for paths would break editing. Ctrl/⌘+click is the IDE-standard opt-in that leaves ordinary clicks alone and is discoverable from the highlight's affordance.

**Highlight forward-slash forms only.** The primary user in this deployment reaches files through WSL UNC paths (`\\wsl.localhost\…`) and Windows drive paths, so backslash and drive forms are in scope from the first shipped version.

**Highlight paths in sent messages too (MessageItem).** Transcript decoration is a natural follow-up but a separate surface with its own rendering; v1 ships composer-only so the scan and the open gesture land together.

## Testing

`packages/client/ui-conversation` unit coverage pins the scanner in `input-machine.client.spec.ts` under `describe('decorations: scanPathRefs')`:

- an absolute path matches at line start and after whitespace (`/root/a/b.txt`);
- multiple paths and the `./`, `../`, `~/` relative forms match in draft order;
- a single-segment `/name` is a command token, never a path (`/goal /commit-helper` → none);
- URL remnants and protocol-relative tokens are not paths (`https://a/b/c` → none);
- a UNC backslash path matches with its exact range and preserved separators (`\\wsl.localhost\Ubuntu-22.04\root\HMC\HMC1\待核对清单.xlsx`);
- Windows drive paths match in both slash directions (`C:\Users\me\file.txt`, `D:/tmp/other.log`);
- a bare drive root or lone backslashes are not paths (`C:\` and `\\nope` → none);
- trailing sentence punctuation is trimmed from the path (`/tmp/a/b.docx.` → `/tmp/a/b.docx`);
- `deriveDecorations` carries `pathRefs` through, and the exact-equality assertions on `deriveDecorations` in the same file were updated to include `pathRefs: []`.

The `InputBar` component suite (`input-bar.client.spec.tsx`) passes with its fixture props extended to thread `openPath` through, and the full `ui-conversation` suite (27 files, 425 cases) is green, so the new `openPath` prop, the backdrop branch, and the click handler introduce no regression.

## Consequences

- A path in the composer is recognisable at a glance and reachable without sending; the Ctrl/⌘+click affordance is discoverable from the highlight and harmless when the path is wrong (silent no-op, mirroring assistant file mentions).
- `ComposerBarInjected` grows one optional member (`openPath`); every alternate bar implementation or composer takeover that constructs these props must accept the new key, which the type enforces.
- The highlight is advisory: it proves shape, never existence. A user can still type a path the host cannot open; the agent's file tools remain the authoritative reader when the message is sent.
- The path scan sits beside — not inside — the plain-text-reference mechanism owned by the [web input machine and slash pipeline note](../architecture/2026-07-25-web-input-machine-and-slash-pipeline.md); the two scans are independent (roster membership vs structural shape) and neither supersedes the other.
