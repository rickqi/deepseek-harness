/**
 * Draft decoration pure core (references render from occurrence ranges; the
 * claim token renders as a mirror-layer
 * highlight, the claim hint as ghost text). Zero React — the skeleton renders
 * the instructions; tests drive this directly.
 */
import type { InputState } from './contract.ts'

/** The claim-token highlight range (always draft-leading while the watch holds). */
export interface TokenRange {
  readonly start: number
  readonly end: number
}

/** One structured inline-reference render instruction. */
export interface ChipRender {
  /** Stable render key (same-labeled chips stay independent). */
  readonly occurrenceId: number
  /** Display-text offset in the draft. */
  readonly offset: number
  /** Display-text length in the draft. */
  readonly length: number
  /** Exact inline text whose native glyph metrics determine layout. */
  readonly text: string
  readonly label: string
  /** Optional domain glyph beside the label. */
  readonly appearance?: 'session' | 'file' | 'folder'
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
  /** Optional icon domain for syntax-recognizable plain references. */
  readonly appearance?: 'folder'
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
  /**
   * Scan-derived lexicon tokens and syntax-recognizable folder ranges.
   * A same-start reference that is a strict prefix of a path ref is dropped
   * here — the path is the more specific reading of the same span — so the
   * rendered sources never overlap.
   */
  readonly textRefs: readonly TextRefRange[]
  /** Scan-derived file-path ranges (independent of the lexicon). */
  readonly pathRefs: readonly PathRefRange[]
  /** Ghost hint shown while the claim's args are blank; null otherwise. */
  readonly hint: string | null
}

/** Token matcher: a trigger char at line start or after whitespace, then a word-ish name (never crosses \n). */
const TEXT_REF_RE = /(^|\s)([/@])([\w-]+)/g
const FOLDER_REF_RE = /(^|\s)(@(?:"[^"\n]*\/|[^\s"]+\/))/g

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
  if (draft === '') return []
  const out: TextRefRange[] = []
  if (lexicon.size > 0) {
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
  }
  FOLDER_REF_RE.lastIndex = 0
  let folder: RegExpExecArray | null
  while ((folder = FOLDER_REF_RE.exec(draft)) !== null) {
    const token = folder[2] ?? ''
    const start = folder.index + (folder[1]?.length ?? 0)
    const end = start + token.length
    if (!out.some(range => range.start < end && range.end > start)) {
      out.push({ start, end, trigger: '@', appearance: 'folder' })
    }
  }
  return out.sort((left, right) => left.start - right.start)
}

/**
 * Path-token matcher (forward-slash family): a leading `/`, `./`, `../` or
 * `~/` prefix then a path-ish run (no whitespace, no chip placeholder
 * U+FFFC, no common CJK/ASCII punctuation).
 */
const FORWARD_PATH_RE = /(^|\s)((?:\/|\.{1,2}\/|~\/)[^\s，。、；：,;:（）()\[\]{}"'\uFFFC<>]+)/g
/**
 * Path-token matcher (UNC family): `\\server\share\…` with at least server
 * + share. Placeholder U+FFFC is excluded from every component so a path
 * token can never span a chip.
 */
const UNC_PATH_RE = /(^|\s)(\\\\[^\s\\\uFFFC]+\\[^\s\\\uFFFC]+(?:\\[^\s\\\uFFFC]+)*)/g
/**
 * Path-token matcher (drive family): `X:\…` / `X:/…` (forward-slash drive
 * paths ride here too — the forward matcher cannot see them because the `/`
 * is glued to the drive letter's `:`).
 */
const DRIVE_PATH_RE = /(^|\s)([A-Za-z]:[\\/][^\s，。、；：,;:（）()\[\]{}"'\uFFFC<>]+)/g
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
  for (const re of [FORWARD_PATH_RE, UNC_PATH_RE, DRIVE_PATH_RE]) {
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
    length: o.length,
    text: draft.slice(o.offset, o.offset + o.length),
    label: o.label,
    ...o.appearance === undefined ? {} : { appearance: o.appearance },
    invalid: o.invalid === true,
  }))
  const hint = claimActive && claim.hint !== undefined && draft.slice(claim.token.length).trim() === ''
    ? claim.hint
    : null
  const pathRefs = scanPathRefs(draft)
  const textRefs = scanTextRefs(draft, lexicon)
    .filter(ref => !pathRefs.some(path => path.start === ref.start && path.end > ref.end))
  return { token, chips, textRefs, pathRefs, hint }
}
