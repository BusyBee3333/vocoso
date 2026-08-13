# Precision: why the grounding check can be a gate

A check that cries wolf gets ignored, and an ignored check is worse than no
check — it costs the same to run and buys nothing. So the grounding rule is
tuned for precision over recall, deliberately, and this is the record of how.

## What happened when it met a real codebase

The oracle was pointed at a production CRE copilot's surface fixtures. It
immediately failed nine of them, and every finding was wrong:

```
grounding: contacts-frame.title retypes the authoritative value "Contacts"
grounding: board-frame.title   retypes the authoritative value "pipeline"
grounding: focus-primary.label retypes the authoritative value "Complete"
grounding: maria-frame.title   retypes the authoritative value "contact"
grounding: domain-records.empty retypes the authoritative value "DNS records"
```

Every one of those strings really is a value somewhere in the authoritative
state. Every one is also simply the correct English for the place it appears.
"Contacts" in a panel heading is not a leak, and a tool that says it is will be
switched off within a day.

There was a second class of false positive too: every reference into
`/draft/...` was reported as a phantom binding. Those are bindings to what the
user is currently typing — the correct way to route input into an operation —
and they *cannot* resolve at compose time, because nothing has been typed yet.

## The fixes

**1. Facts must look like data, not vocabulary.** A value is only protected if
it carries a marker that ordinary prose does not:

- a digit — ids, prices, dates, counts, versions
- an identifier separator — `contact-maria`, `a@b.com`, `host.example`, `a/b`
- twenty or more characters — too long to collide by accident
- two or more capitalised words — a proper noun phrase, not a UI word

That keeps every identifier, code, price, date, address, phone number, email,
and name, and drops the dictionary. Against the same fixtures it kept 9 of 9
real leaks (`priority-1`, `contact-maria`, `cresync-example.test`,
`4180 Causeway Commerce Blvd`, `Send the Elm Street survey`, …) and dropped all
5 false positives.

**2. Word-boundary matching.** `contact-maria` no longer matches inside
`precontact-mariauniverse`.

**3. Draft and UI paths are not resolved.** `draftPathPrefixes` defaults to
`["/draft", "/ui", "/local"]`. References below them are legal by construction
and exempt from resolution.

## The cost, stated plainly

A single-word value that genuinely was retyped is now missed. If a task status
of `Complete` is copied into a button label, VoCoSo will not flag it.

That is the right trade for a gate — a false positive kills adoption, a missed
single-word status is low-harm — but it is a real gap, and it is configurable:

```js
surfaces: { factShape: "any" }   // protect every value over minFactLength
```

Use `"any"` when your facts genuinely are single dictionary words (a status
enum, a category, a tag) and you would rather triage false positives than miss
one. Use the default everywhere else.

## Result

| | clean fixtures | one fact moved into a label |
| --- | --- | --- |
| the host's own runtime gate | accepts (correct) | **accepts (misses it)** |
| VoCoSo, before these fixes | rejects 9/10 (wrong) | catches |
| VoCoSo, after | accepts all (correct) | **catches 9/9** |

Reproduce it with `vocoso check <spec.json> --state <state.json>` against any
spec your own app has produced.
