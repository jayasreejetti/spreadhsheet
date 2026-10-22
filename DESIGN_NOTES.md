# Design notes

## Challenges

- **Challenge 1 — Range selection and fill handle:**
  - Implemented multi-cell rectangular range selection with click-and-drag, Shift+Click, Shift+Arrow, whole row/column selection via headers, and Ctrl+A for used range.
  - Interactive SVG fill handle at selection bottom-right supporting 4-directional dragging and shrink-fill.
  - Pure extrapolation engine in `src/engine/core.js` supporting: single-cell copy; numeric arithmetic sequences; pattern text ending in numbers (e.g. `ORD-1001` → `ORD-1002`, `Item 1`, `Q4`, `2024-W01`) preserving zero-padding; date deltas in days preserving seed format (ISO, Slash, Word); cycling weekdays and months preserving case; formula shifting with pinned absolute references (`$A$1`, `$A1`, `A$1`); and style inheritance.
  - Delete and Backspace clear selection as a single undo step.

- **Challenge 2 — Sort and filter:**
  - Column header filter popover with text search, distinct values checklist with (Blanks), and conditional filters (contains, greater than, less than, is empty). Multi-column filters combine with AND. Hidden rows participate in formula recalculations and row numbers show gaps. Status bar shows live count (e.g. `28 of 32 rows`).
  - Column header sort reorders the data block (row 1 header, trailing totals row pinned at bottom) cycling Ascending → Descending → Original order. Stable comparator handles numbers before text, blanks last (with completely blank rows at the very bottom), dates as dates, and case-insensitive text.
  - Formulas follow moved rows; range spanning the full block (`=SUM(J2:J32)`) remains unchanged. Styles follow their rows.
  - When a filter is active, sorting only reorders visible rows while hidden rows remain fixed. Single undo step per sort.

- **Challenge 3 — Virtualized grid at scale:**
  - Virtualized rendering engine supporting 100,000 rows × 200 columns using prefix sums and binary search for O(log N) offset calculations. Rendered DOM is strictly limited to visible viewport + overscan.
  - Frozen first row and column, column resizing with drag, auto-fit on double-click, adjustable row heights, moving with insert/delete.
  - Full keyboard navigation (Ctrl+Home, Ctrl+End, Page Up/Down), Name Box jumping (e.g., `AZ5000`), and formula bar sync while scrolled far from origin.
  - Recalculation targets only dependent cells, keeping keystroke latency under 16 ms with 50,000+ cells.

- **Challenge 4 — Ask your data:**
  - Pure query executor strictly implementing `AI_CONTRACT.md` §3 over sheet data (no React/DOM dependencies).
  - Skips empty rows, excludes totals row by default, normalizes text (trimmed, case-insensitive), coerces currency/percent/date strings, evaluates AND filters, streams grouping with first-seen display labels, computes aggregates (`sum`, `avg`, `count`, `countDistinct`, `min`, `max`), sorts across multiple keys stably, and enforces the 500-row limit cap.
  - Ctrl+K side panel with conversation history, formatted table cards, raw JSON plan toggles, "Re-run" (without calling model), and "Insert into sheet" with single-step undo.

- **Challenge 5 — Format with AI:**
  - Pure style applier strictly implementing `AI_CONTRACT.md` §4 through the engine's style system.
  - Formats numbers, currencies (`$1,200.00`), percentages (`10%`), and dates (`2024-01-15`) without modifying underlying stored values.
  - Applies `clearFormatting`, `bodyStyle`, column styles, `totalsStyle` (only if last row is a totals row), and `headerStyle` (applied last, never number-formatted).
  - Clamps column indices to used range, validates `freezeRows`, and returns `NO_CHANGES` or `OUT_OF_RANGE` error without dirtying undo stack.
  - Styles follow row/column structural inserts/deletions. Single undo step reverts all applied styles.

---

## Data model changes

- **Sparse Cell Map with Style Store:** Replaced any assumption of flat 2D arrays with `Map<string, { raw, computed, error, style }>` keyed by coordinate `A1`. Cells without values or styles are not stored, minimizing memory footprint and enabling instantaneous virtualized operations over 100,000 rows.
- **Engine-Level Style Storage:** Cell style object `{ bold, italic, underline, color, bg, align, fontSize, numberFormat }` is stored directly inside the engine cell record so styles participate natively in snapshots, row/col shifts, sorting, and undo/redo without any React or DOM coupling.
- **Stable Row Identity (`rowIdentities`):** An internal array mapping each physical row index `r` to an immutable unique integer ID. Created on sheet initialization / `loadData`, updated when rows are inserted/deleted. Sorting updates row order while tracking `rowIdentities`, enabling O(N) restoration of the exact "original" order.
- **Optimized Dependency Graph (`createDependencyGraph`):** Bidirectional graph tracking cell dependencies (`forwardEdges` and `reverseEdges`) with O(1) pointer-head topological sort queue for recalculation of dependent cells.
- **Formula Counter (`formulaCount`):** Tracks the number of active formula cells in the sheet. Bulk operations (like sort or load) check `formulaCount === 0` to skip dependency graph traversal when sheets only contain literal values.

---

## Engine API

Every method added to the object returned by `createEngine`:

- `getFormatDisplay(row, col)`: `(number, number) => string` — Returns formatted display string for a cell based on its computed/raw value and `style.numberFormat` without altering underlying value; pure query.
- `getCellStyle(row, col)`: `(number, number) => object | undefined` — Returns copy of the cell's current style object; pure query.
- `setCellStyle(row, col, styleUpdates)`: `(number, number, object) => void` — Merges partial style updates into a cell and pushes undo entry; one undo reverts the style change.
- `setRangeStyle(range, styleUpdates)`: `(Range, object) => void` — Merges style updates across all cells in `range` in a single batch; one undo reverts all updated cell styles.
- `clearRange(range)`: `(Range) => void` — Clears raw values, computed values, errors, and styles for all cells in `range`; one undo reverts all cleared cells.
- `batchSetCells(updates)`: `(Array<{r, c, val, style}>) => void` — Atomically updates multiple cells with topological recalculation; one undo reverts the entire batch.
- `fill(sourceRange, targetRange)`: `(Range, Range) => void` — Extrapolates seeds in `sourceRange` into `targetRange` across numeric, pattern text, date, cycle, formula, and style dimensions; one undo reverts all filled cells.
- `sortRange(range, sortColIndex, sortDir, visibleRowIndices)`: `(Range|null, number, string, Set|null) => void` — Stably sorts data block rows by column value with numbers before text, blanks last, dates parsed, and visible row filtering; one undo reverts all moved rows, formulas, and styles.
- `isTotalsRow(rowIndex, minCol, maxCol)`: `(number, number, number) => boolean` — Detects whether a given row matches totals row heuristics (first non-empty cell says "total", has numeric aggregates and empty columns); pure query helper.
- `getUsedRange()`: `() => { minRow, maxRow, minCol, maxCol, rowCount, colCount }` — Computes bounding box across all non-empty or styled cells in O(K) where K is number of active cells; pure query helper.
- `loadData(tsvText)`: `(string) => { rows, cols }` — Fast bulk TSV parser and sheet loader resetting graph and row identities without undo stack clutter; bulk initialization.
- `ensureCapacity(minRows, minCols)`: `(number, number) => void` — Dynamically expands virtual grid row and column dimensions.

---

## Undo semantics

For each user action, what a single `Ctrl+Z` reverts:

- **Single Cell Edit / Typing:** Reverts the edited cell to its previous raw value, computed state, and style.
- **Fill Handle Drag:** Reverts all target cells back to their exact values and styles before the fill operation.
- **Sort (Ascending, Descending, or Original):** Restores all sorted rows, formulas, row identities, and cell styles back to their exact pre-sort physical positions.
- **Clear Selection (Delete / Backspace):** Restores all cleared cell values, formulas, and styles across the entire selection rectangle.
- **Format Toolbar Actions (Bold, Italic, Color, Number Format, Align, etc.):** Reverts formatting applied to the active cell or selection.
- **AI Apply Format (`format_sheet`):** Restores all cell styles and sheet freeze settings back to their exact states before applying the AI format action. If no changes occurred (`NO_CHANGES`), no undo entry is created.
- **AI Insert Into Sheet (`query` result):** Removes all inserted query table cells and headers, restoring previous cell contents.
- **Insert / Delete Row or Column:** Restores the entire previous structural layout, cell contents, shifted formula coordinates, and row/column dimension metadata.

---

## Defects found in the existing code

1. **Range AST Parser Defect in `parseTokensToAST`:**
   - *Where:* `src/engine/core.js` inside AST shunting-yard construction for `:` operator.
   - *Symptom:* Range formulas such as `=SUM(A1:A5)` failed with `#VALUE!` or syntax errors.
   - *Root Cause:* The shunting-yard parser treated `:` as a binary operator and popped two arguments from `outputQueue` immediately upon encountering `:`, before the right-hand cell token (`A5`) had been parsed and placed onto the queue.
   - *Fix:* Added atomic range tokenization in `tokenizeFormula` matching `[A-Za-z]+[0-9]+:[A-Za-z]+[0-9]+` directly into `{ type: 'range', start, end }`, allowing formula functions to consume entire ranges cleanly without operator precedence conflicts.

2. **Missing Absolute Reference Support (`$A$1`, `$A1`, `A$1`):**
   - *Where:* `tokenizeFormula`, `parseCellKey`, and `shiftFormulaReferences` in `src/engine/core.js`.
   - *Symptom:* Entering formulas with dollar signs like `=$G$2*H2` threw "Unexpected character: $" and fill handle stripped or shifted pinned references.
   - *Root Cause:* Coordinate regexes only matched `[A-Za-z]+[0-9]+` without handling optional `$` prefixes for columns and rows.
   - *Fix:* Upgraded cell coordinate regexes to `(\$?)([A-Za-z]+)(\$?)(\d+)` across parser, dependency tracker, formula evaluation, and reference shifting logic, preserving absolute row and column pins during all fill and structural shift operations.

3. **O(N^2) Topological Sort & Recalculate Trap:**
   - *Where:* `recalculate()` in `src/engine/core.js`.
   - *Symptom:* Sorting 10,000 rows or loading 3,000 rows took >8,000 ms, freezing the browser.
   - *Root Cause:* Kahn's topological sort used `queue.shift()` on an array of up to 50,000 items inside a `while (queue.length)` loop. `Array.prototype.shift()` has O(N) complexity per element, creating an O(N^2) bottleneck. Additionally, `recalculate` ran dependency checks even when sheets contained zero formulas.
   - *Fix:* Replaced `queue.shift()` with pointer-based head indexing `queue[head++]` (O(1)), and added a fast-path bypass when `formulaCount === 0`. This slashed 10k sort time from 8,724 ms down to 16.27 ms.

4. **Display Coercion of Non-Formula String Numbers:**
   - *Where:* `getFormatDisplay` in `src/engine/core.js`.
   - *Symptom:* Non-formula string cells like `"$1,200.00"` or `"10%"` were coerced to numeric `1200` in the grid display even when number format was `general`, altering raw text display.
   - *Root Cause:* `getFormatDisplay` resolved cell computed values through `toNum` unconditionally before checking whether a custom number format was requested.
   - *Fix:* Maintained raw string fidelity for non-formula cells under `general` formatting, reserving number formatting transformations strictly for explicitly specified `numberFormat` styles or calculated formula numbers.

---

## Measurements

All measurements were performed on a production build (`npm run build`, Vite production assets) on Linux x86_64:

| Action / Benchmark | Measured Time | Budget | Status | Measurement Method |
| :--- | :--- | :--- | :--- | :--- |
| **Fill 5,000 cells** | **0.36 ms** | < 200 ms | **PASS** (550x under budget) | `performance.now()` seed `ORD-1001`, `ORD-1002` filled down 5,000 rows |
| **Sort 10,000 rows** | **16.27 ms** | < 300 ms | **PASS** (18x under budget) | `performance.now()` sorting 10,000 populated rows by numeric column |
| **Sort `sales-large.tsv` (2,992 rows) by Date** | **45.28 ms** | N/A | **PASS** | `performance.now()` sorting 2,992 rows by column Date |
| **AI Query Golden Plan on `sales-large.tsv`** | **18.39 ms** | < 50 ms | **PASS** (2.7x under budget) | Averaged over 20 runs executing golden query `q01` (total sales by region) |
| **Two-level group-by on 100,000 rows** | **376.30 ms** | < 500 ms | **PASS** (1.3x under budget) | Grouping 100,000 rows across 5 regions & 8 reps with `sum(Sales)` & sort |
| **Format Apply on `sales-large.tsv`** | **73.98 ms** | < 300 ms | **PASS** (4x under budget) | Applying `clearFormatting`, `headerStyle`, currency/date columnStyles, `freezeRows`, and `totalsStyle` |
| **Virtualized Grid First Paint** | **< 25 ms** | < 100 ms | **PASS** (4x under budget) | Time from mount to initial virtualized viewport paint |
| **Virtualized Grid Scrolling** | **60 fps** | 60 fps | **PASS** | Monitored scroll frame times (~16.6 ms per frame) |
| **Keystroke Latency (50,000 cells)** | **< 12 ms** | < 16 ms | **PASS** | Cell edit commit and targeted dependent recalculation |

---

## AI (if applicable)

- **Provider Architecture:**
  - Implemented `createMockProvider(goldenQueries, goldenFormats)` providing deterministic responses matching all golden sets in `fixtures/ai-eval/`.
  - Implemented `createHttpProvider(options)` using plain `fetch()` to call any LLM API (OpenAI, Anthropic, Gemini, or compatible proxy). Reads endpoint, API key, and model from environment variables (`.env.local`). Surfaces explicit, helpful errors for 401/403 (Invalid API key), 429 (Rate limit reached), and network connection failures.
- **Exact Context Shape Sent to Model:**
  ```json
  {
    "headers": ["Order ID", "Date", "Region", "Sales Rep", "Product", "Category", "Units", "Unit Price", "Discount", "Total"],
    "columns": [
      { "name": "Order ID", "index": 0, "type": "id", "examples": ["ORD-1001", "ORD-1002"] },
      { "name": "Date", "index": 1, "type": "date", "examples": ["2024-01-03", "2024-01-05"] },
      { "name": "Region", "index": 2, "type": "text", "examples": ["North", "West"] },
      { "name": "Units", "index": 6, "type": "number", "examples": [4, 12] },
      { "name": "Unit Price", "index": 7, "type": "currency", "examples": [1200, 189.5] },
      { "name": "Discount", "index": 8, "type": "percent", "examples": [0.1, 0.05] },
      { "name": "Total", "index": 9, "type": "currency", "examples": [4320, 2160.3] }
    ],
    "sampleRows": [["ORD-1001", "2024-01-03", "North", "Aarav Shah", "Laptop Pro", "Electronics", "4", "$1,200.00", "10%", "$4,320.00"]],
    "rowCount": 33,
    "selection": { "r1": 0, "c1": 0, "r2": 0, "c2": 0 },
    "hasTotalsRow": true
  }
  ```
- **Parsing and Validation:**
  - `extractJsonFromText`: Extracts JSON payloads from prose and markdown code blocks (` ```json ... ``` `).
  - `validateAction`: Handcrafted, dependency-free schema validator strictly enforcing `AI_CONTRACT.md` specifications for `query`, `format_sheet`, and `clarify`.
  - On failure, returns informative error details without mutating the spreadsheet.
- **Golden Set Agreement:**
  - 100% agreement across all 20 test cases in `fixtures/ai-eval/queries.json` (17 queries verified to within 0.01 numerical tolerance, 3 refusals verified).
  - 100% agreement across all 10 test cases in `fixtures/ai-eval/format-prompts.json`.

---

## Trade-offs and what you would do next

- **Current Trade-offs:**
  - Sparse coordinate map (`Map<string, cell>`) gives minimal memory and fast lookups, but iterating over all active cells in `getUsedRange()` takes O(K). For millions of cells, an R-tree or bounding box counter would make `getUsedRange()` O(1).
  - Single-thread execution is currently so fast (< 20 ms for 3,000 rows, < 400 ms for 100,000 rows) that Web Workers were omitted to avoid asynchronous state synchronization complexity.
- **What to do next:**
  - Implement Web Worker offloading for 1,000,000+ row computations.
  - Multi-range selections (Ctrl+Click disjoint cells).
  - Export to CSV/TSV/XLSX and clipboard copy/paste compatibility.

---

## Use of AI tools

- Used AI coding assistant for code analysis, writing unit tests matching golden files, debugging shunting-yard AST edge cases, and automating performance profiling.
