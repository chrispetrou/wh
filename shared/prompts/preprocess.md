# diff preprocessing spec

Deterministic transformation from raw git output to the explain payload.
Implemented twice (Rust in cli/, TypeScript in web/); both implementations
must reproduce `shared/fixtures/explain/*/expected.txt` byte for byte.

## inputs

Three text inputs, produced with (or equivalent to):

```
git diff -M --no-color --no-ext-diff <range>     # the diff
git diff -M --numstat <range>                    # per-file stats
git log --format='%h %s' <range>                 # commit lines, may be empty
```

The web implementation gets the same three artifacts from the GitHub API
and normalizes them to these shapes before preprocessing.

## payload format

```
commits: <N>
- <commit line, verbatim, input order>
...
files: <N> (+<A> -<D>)
excluded:
- <path> (<reason>)
...
---
<kept file sections, sorted by path, possibly truncated>
```

- `commits:` block only when at least one commit line was given. Lines are
  kept verbatim in input order.
- `files:` is always present. N = number of numstat entries. A and D are the
  sums of the added/deleted columns; a binary `-` column counts as 0. ASCII
  `+`/`-` signs (the landing's `−` glyph is ui-only).
- `excluded:` block only when non-empty, entries sorted by path (byte order),
  reason is the kind that matched (see below).
- `---` on its own line, then the kept sections concatenated. Every section
  ends with a newline; the payload ends with exactly one trailing newline.

## file sections

- Split the diff at lines starting with `diff --git `. A section runs from
  its header line up to (not including) the next header or end of input.
- Section path: everything after the last ` b/` in the header line. (Paths
  that git quotes, e.g. containing spaces, are used verbatim including
  quotes; rare enough that neither implementation unquotes.)
- Numstat rename syntax resolves to the new path for classification and
  display: `dir/{old => new}/f.txt` becomes `dir/new/f.txt`, and a bare
  `old => new` becomes `new`.

## exclusion

A section is excluded when:

1. it contains a line starting with `Binary files ` or `GIT binary patch`
   (reason `binary`), or
2. its path matches a rule in `exclude.txt` (reason = the rule's kind).

`exclude.txt` is the single source of truth for path rules, one rule per
line: `kind<TAB>matcher<TAB>value`. Matchers:

- `name`: last path segment equals value
- `segment`: any path segment equals value
- `suffix`: path ends with value

Excluded sections are dropped from the body and listed in the `excluded:`
block. Their numstat entries still count toward the `files:` line.

## size caps

Two line-count caps, defaults `per_file_cap=400` and `total_cap=4000`.
Fixture directories may override them in `params.txt` (`key=value` lines)
to keep fixtures small.

- Per file: if a kept section has more than `per_file_cap` lines, keep the
  first `per_file_cap` lines and append `... truncated (<n> more lines)`
  where n is the number of dropped lines.
- Total: walk the kept sections in sorted order with a running line total
  (counting each section after per-file truncation, marker included). If
  adding a section would push the total over `total_cap`, emit the single
  line `... omitted <path> (size cap)` instead (which counts 1 line), and
  keep applying the same check to the remaining sections.
