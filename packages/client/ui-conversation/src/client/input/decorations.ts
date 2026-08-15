/**
 * Draft decoration pure core (chips render from the occurrence
 * table at placeholder offsets; the claim token renders as a mirror-layer
 * highlight, the claim hint as ghost text). Zero React — the skeleton renders
 * the instructions; tests drive this directly.
 */
import type { InputState } from './contract.ts'

/** The claim-token highlight range (always draft-leading while the watch holds). */
export interface TokenRange {
  readonly start: number
  readonly end: number
}

/** One chip render instruction: the placeholder at `offset` draws as `label`. */
export interface ChipRender {
  /** Stable render key (same-labeled chips stay independent). */
  readonly occurrenceId: number
  /** Placeholder offset in the draft (the chip occupies [offset, offset+1)). */
  readonly offset: number
  readonly label: string
  /** Owner-resolution failure styling bit. */
  readonly invalid: boolean
}

/**
 * One plain-text reference range (the plain-text-reference decision;
 * see .agents/notes/implemented/architecture/2026-07-25-web-input-machine-and-slash-pipeline.md):
 * a `/name` or `@name` token
 * whose name is on the trigger's lexicon. Pure derivation — editing the text
 * out of match shape simply drops the range next scan.
 */
export interface TextRefRange {
  readonly start: number
  readonly end: number
  readonly trigger: '/' | '@'
}

/**
 * One recognized file-path range in the draft (the plain-text-path decision).
 * Path-shaped tokens are highlighted so the user sees the composer recognise
 * a file path they typed; Ctrl/⌘+click on the highlighted range opens the
 * path through the host (`workspaces.openPath`). Pure derivation — editing
 * the text out of path shape simply drops the range next scan.
 */
export interface PathRefRange {
  readonly start: number
  readonly end: number
  /** The recognised path token (leading `./`, `../`, `~/` or `/` prefixes preserved). */
  readonly path: string
}

/** Decoration product: claim token range + chip instructions + text-ref ranges + path ranges + the ghost hint. */
export interface DraftDecorations {
  /** Claim token range while claimed/submitting and the prefix watch holds; null otherwise. */
  readonly token: TokenRange | null
  /** Chip render instructions in draft order (occurrence table is offset-sorted). */
  readonly chips: readonly ChipRender[]
  /** Scan-derived plain-text reference ranges (empty without a lexicon). */
  readonly textRefs: readonly TextRefRange[]
  /** Scan-derived file-path ranges (independent of the lexicon). */
  readonly pathRefs: readonly PathRefRange[]
  /** Ghost hint shown while the claim's args are blank; null otherwise. */
  readonly hint: string | null
}

/** Token matcher: a trigger char at line start or after whitespace, then a word-ish name (never crosses \n). */
const TEXT_REF_RE = /(^|\s)([/@])([\w-]+)/g

/**
 * Scan the draft for plain-text reference tokens against the hot lexicons.
 * Word-boundary discipline: the trigger must sit at the draft
 * start or after whitespace ('x/name' never matches); the name must be an
 * exact lexicon member.
 * @param draft - draft text.
 * @param lexicon - per-trigger name lists (a missing trigger scans nothing).
 * @returns matched ranges in draft order.
 */
export function scanTextRefs(
  draft: string, lexicon: ReadonlyMap<'/' | '@', readonly string[]>,
): TextRefRange[] {
  if (lexicon.size === 0 || draft === '') return []
  const out: TextRefRange[] = []
  TEXT_REF_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = TEXT_REF_RE.exec(draft)) !== null) {
    const trigger = m[2] as '/' | '@'
    const name = m[3] ?? ''
    if (lexicon.get(trigger)?.includes(name)) {
      const start = m.index + (m[1]?.length ?? 0)
      out.push({ start, end: start + 1 + name.length, trigger })
    }
  }
  return out
}

/**
 * Path-token matcher (forward-slash family): a leading `/`, `./`, `../` or
 * `~/` prefix then a path-ish run (no whitespace, no common CJK/ASCII
 * punctuation).
 */
const FORWARD_PATH_RE = /(^|\s)((?:\/|\.{1,2}\/|~\/)[^\s，。、；：,;:（）()\[\]{}"'<>]+)/g
/**
 * Path-token matcher (backslash family): UNC `\\server\share\…` (at least
 * server + share), or a drive path `X:\…` / `X:/…` (forward-slash drive
 * paths ride here too — the forward matcher cannot see them because the `/`
 * is glued to the drive letter's `:`).
 */
const BACKSLASH_PATH_RE = /(^|\s)((?:\\\\[^\s\\]+\\[^\s\\]+(?:\\[^\s\\]+)*)|(?:[A-Za-z]:[\\/][^\s，。、；：,;:（）()\[\]{}"'<>]+))/g
/** Trailing punctuation (or a stray separator) that can belong to a sentence, not the path. */
const TRAILING_PUNCT = /[/\\.,;:。，；：]+$/

/**
 * Whether a matched path token is worth highlighting: not a URL-ish
 * `//`/`///` remnant and at least two non-empty path segments (a bare
 * single-segment `/name` is a command token, never a path).
 */
function plausiblePath(token: string): boolean {
  if (token.startsWith('//')) return false
  const segments = token.split(/[\\/]/).filter(segment => segment !== '')
  return segments.length >= 2
}

/** Normalize one matched token: trim trailing punctuation, drop empty results. */
function toPathRef(match: RegExpExecArray): PathRefRange | null {
  const raw = match[2] ?? ''
  const path = raw.replace(TRAILING_PUNCT, '')
  if (path === '' || !plausiblePath(path)) return null
  const start = match.index + (match[1]?.length ?? 0)
  return { start, end: start + path.length, path }
}

/**
 * Scan the draft for path-shaped tokens: absolute (`/a/b`, `\\server\share`,
 * `X:\…`), `./`/`../`/`~/`-relative, or `.\`/`..\`/`~\`-relative forms with
 * at least two segments. Pure text scan — no filesystem resolution, so
 * nothing here can fail on a stale or moved file; the range only says "this
 * draft span looks like a file path".
 * @param draft - draft text.
 * @returns matched ranges in draft order.
 */
export function scanPathRefs(draft: string): PathRefRange[] {
  if (draft === '') return []
  const out: PathRefRange[] = []
  for (const re of [FORWARD_PATH_RE, BACKSLASH_PATH_RE]) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(draft)) !== null) {
      const ref = toPathRef(m)
      if (ref !== null) out.push(ref)
    }
  }
  out.sort((a, b) => a.start - b.start)
  return out
}

/** The empty lexicon (default: zero text-ref decorations, old call sites unchanged). */
const EMPTY_LEXICON: ReadonlyMap<'/' | '@', readonly string[]> = new Map()

/**
 * Derive the mirror-layer decorations from the input state.
 * @param state - published input state.
 * @param lexicon - optional per-trigger reference lexicons (plain-text-reference scan).
 * @returns token range, chip instructions, text-ref ranges, and the ghost hint.
 */
export function deriveDecorations(
  state: InputState, lexicon: ReadonlyMap<'/' | '@', readonly string[]> = EMPTY_LEXICON,
): DraftDecorations {
  const { draft, claim, phase, occurrences } = state
  const claimActive = (phase === 'claimed' || phase === 'submitting')
    && claim !== undefined && draft.startsWith(claim.token)
  const token: TokenRange | null = claimActive ? { start: 0, end: claim.token.length } : null
  const chips = occurrences.map(o => ({
    occurrenceId: o.occurrenceId,
    offset: o.offset,
    label: o.label,
    invalid: o.invalid === true,
  }))
  const hint = claimActive && claim.hint !== undefined && draft.slice(claim.token.length).trim() === ''
    ? claim.hint
    : null
  return { token, chips, textRefs: scanTextRefs(draft, lexicon), pathRefs: scanPathRefs(draft), hint }
}
