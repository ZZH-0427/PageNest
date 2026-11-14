# Artificial PDF fixtures

`pdf-fixtures.mjs` generates deterministic PDF files from hand-written PDF objects.
The content contains only colored vector panels, English test labels and page
numbers. No user documents, personal information or third-party samples are used.

Fixtures cover a single page, mixed portrait/landscape pages (including `/Rotate`),
100 pages, different documents sharing a basename, an encrypted PDF, a broken PDF,
plain text disguised as a PDF and an empty file. The encrypted fixture uses the
public test password `demo`; its obsolete RC4 algorithm is used only to produce a
legacy test file, never to protect application data. It follows PDF 32000-1:2008
sections 7.6.2 and 7.6.3.

The real-engine test generates bytes in memory. For browser testing, generate the
same files into the ignored `temp/` directory:

```sh
node src/test/fixtures/synthetic/pdf-fixtures.mjs temp/pdf-fixtures
```

Select both `same-name-a/shared.pdf` and `same-name-b/shared.pdf` to exercise
distinct files with the same name. Do not commit the generated files in `temp/`.
The generator source and this explanation are the reviewable public fixtures.
