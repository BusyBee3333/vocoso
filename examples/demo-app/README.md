# Demo assistant

A ~200-line fake assistant so you can watch VoCoSo work before wiring it to
anything of your own. No API key, no account, no model calls.

```sh
npm i -D playwright && npx playwright install chromium

# the happy path - passes
npx vocoso run examples/demo-app/scripts/books-a-table.json \
  -c examples/demo-app/vocoso.config.mjs

# the same conversation against a deliberately broken build - fails, and says why
npx vocoso run examples/demo-app/scripts/catches-a-bug.json \
  -c examples/demo-app/vocoso.config.mjs
```

VoCoSo starts the demo server itself (`app.start.command`), so there is nothing
to run first.

## The bugs you can switch on

The demo server takes a `?bug=` query parameter. Each one produces a failure
that is invisible in a screenshot and obvious to the oracle:

| `?bug=` | what the assistant does | what VoCoSo says |
| --- | --- | --- |
| `grounding` | types the restaurant name into a label instead of binding it | `grounding: where.label retypes the authoritative value "Northgate Supper Club"` |
| `catalog` | renders a `MapView` the host does not implement | `catalog: map: "MapView" is not a component this host renders` |
| `phantom` | binds a field to `/results/0/result/tableNumber`, which does not exist | `reference-unresolved: ... does not resolve against the result state` |
| `literal` | hardcodes the confirmation code into an operation input | `action-literal: calendar.add.reference is a literal the model invented` |
| `silent` | answers in words and never calls the tool | `toolCalled:reservations.search ... was never called` |

The `grounding` case is the one worth dwelling on. The surface renders
perfectly. A screenshot test passes. A human reviewing it sees the right
restaurant name. It is still broken, because the name is now a string the model
typed rather than a value from your system - and the next time the reservation
changes, the UI will confidently show the old one.
