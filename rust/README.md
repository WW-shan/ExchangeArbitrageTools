These fixtures are 200 MB of recorded production order books. They are
regenerated locally, never committed:

  npx tsx rust/record-depth.cjs   # or node rust/record-depth.cjs
  node rust/diff-depth.mjs
  node rust/bench-depth.mjs

`cases.jsonl` lives next to `Cargo.toml`.
