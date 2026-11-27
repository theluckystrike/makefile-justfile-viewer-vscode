# Changelog

## 0.1.0

- First release: `Makefile`, `GNUmakefile`, `*.mk`, `justfile`, `Justfile` and `*.just` files in a read-only offline graph viewer, parsed locally in plain JavaScript with zero `make` or `just` execution and zero cloud calls.
- Target and recipe dependency DAG, `.PHONY` and variable table, recipe command summary, and static findings (missing `.PHONY`, recursive `=` vs `:=` shell hazards, `curl | sh`, unquoted `rm -rf` variables, duplicate targets, undefined variable references).
- Zovo Pro tools with 1 free try each: Markdown Makefile/Justfile safety and `.PHONY` audit, two-file build diff, and Mermaid target DAG plus Markdown and CSV target and variable catalog export. Get Zovo Pro first shows what Pro includes and the tries left, in an editor tab.
