# docx-inspect

A small command-line utility that dumps the internal structure of a Word
`.docx` file as a plain-text report — useful for understanding how a document
is formatted, debugging [`python-docx`](https://python-docx.readthedocs.io/)
output, or reproducing a layout in a template.

It reports:

- Document defaults (font, size, spacing)
- Page setup (paper size, margins, orientation)
- Style definitions, including East Asian (`w:eastAsia`) fonts that
  `python-docx`'s `font.name` does not expose
- Numbering / list definitions
- Headers & footers
- The body outline (paragraphs and tables, in order)
- Per-table layout (column widths, borders, cell text)
- Image dimensions

## Requirements

- Python 3.11
- `python-docx` (see `requirements.txt`)

```bash
python -m venv .venv
# Windows
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
# macOS / Linux
./.venv/bin/python -m pip install -r requirements.txt
```

## Usage

```bash
python inspect_word.py input.docx [output.txt]
```

With no output path it writes `input_inspect.txt` next to the input. Open the
result in any text editor.

`.docx` only — for the legacy `.doc` format, re-save as `.docx` first.

## Output sections

```
1. Document defaults
2. Page setup
3. Styles            (styles used in the body are flagged)
4. Numbering / lists
5. Headers & footers
6. Body outline
7. Tables
8. Images
```

## License

MIT
