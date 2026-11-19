---
name: memory-dream
description: Procedure for periodic memory dream consolidation. Run by the "Memory Dream" routine.
metadata:
  visible: false
---

# Memory dream

Fold what has happened since the last pass back into the memory store: merge what
belongs together, correct what has changed, drop what is no longer true.

Your system prompt already carries the memory format, the four types, and the
catalogue. This is the procedure to keep them organized and accessible.

Work the phases in order and finish with the report.

## 1. Orient

`list_files` on your memory directory, then read the memories that cover the topics
you are about to touch. You are improving a store that already exists.

Also read every memory `modified` since `review_since` in the trigger metadata
(`grep_files` for `^modified:`). Mid-conversation edits can contradict themselves: a
new fact beside the line it replaces, or a body changed under a stale description.

## 2. Gather

Read what was said since `review_since`. This runs in the sandbox, so it is never held
for a confirmation:

```
bun ~/.pipali/skills/memory-dream/scripts/transcripts.ts --since <review_since>
```

Without `review_since` the script covers the last 7 days. `--limit <n>` caps how many
conversations it prints, newest first.

Each conversation is headed by its title and id. When a transcript leaves out what you
need, such as what a tool call did, the whole conversation is at
`GET http://127.0.0.1:6464/api/chat/<id>/history`.

What is worth carrying out of a transcript:

- Corrections. The user telling you that something you did was wrong, or how they
  would rather you did it.
- Preferences stated in passing. Tools, formats, hours, names, the way they like work
  handed back to them.
- Facts that contradict a memory you already hold.
- Durable context about their work, setup or people, of the kind that will still be
  true next month.

What is not:

- Anything answered and finished inside the conversation.
- What their files, repositories or history already record.
- One-off task detail. A question they asked once is not a standing interest.

## 3. Consolidate

For each thing worth keeping:

- A memory already covers the topic: edit that file. Two files saying nearby things
  are harder to find than one saying both. Recall cuts a body off at 8,000 characters.
- Nothing covers it: write a new memory.
- A memory is contradicted: fix it at the source, in the file, rather than adding a
  memory that argues with it.
- Relative dates ("yesterday", "last week") become absolute dates.
- State what is true now, not a change log ("changed to X on <date>"). Keep the why
  where it guides future behavior.
- Link related memories with `[[their-filename]]`.

Deleting is removing the file - `shell_command` with `rm`. The catalogue is derived
from the directory, so nothing else needs updating.

## 4. Prune

The catalogue holds 25,000 bytes of lines - roughly 120 memories with descriptions
under 150 characters - and leaves older memories out past that: `unlisted_memories`
in the trigger metadata counts them. Bring the store back within it by merging
overlapping files, deleting what has gone stale, and shortening long descriptions.

Then reread the descriptions. A description is the only thing a future recall sees,
so one that could describe half the store makes its memory unreachable however good
the body is. Sharpen the vague ones.

## Rules

- Do not edit `USER.md`. Those are the user's own words about themselves. If a memory
  contradicts it, note the contradiction in the memory.
- When you are unsure whether to delete something, keep it. A stale memory costs a
  line in the catalogue; a deleted load-bearing one costs the user their context.
- Verify before you record. A memory naming a file, path or tool that no longer exists
  is worse than no memory. So is a temp path that will not last, or something only
  proposed recorded as installed, sent or decided. A path the sandbox cannot read, like
  Windows app data, only looks missing.

## Report

Close with a short summary the user will read on the routine's card: what you added,
what you merged, what you deleted, and why. A few lines. If you changed nothing, say
that and say what you looked at. If the store is still larger than the catalogue holds,
say so and by roughly how many memories.
