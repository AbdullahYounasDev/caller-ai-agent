import "./helpers/no-db.mjs";
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { normalize, checkFile, isEditable, MAX_UPLOAD_BYTES, ACCEPTED_EXTENSIONS } from "@/lib/agent/extract";

describe("normalize", () => {
  test("CRLF and lone CR become LF", () => {
    assert.equal(normalize("a\r\nb\rc"), "a\nb\nc");
  });

  test("NUL, soft hyphens, zero-width characters and BOM are removed (they split words in an embedding)", () => {
    assert.equal(normalize("a\0b"), "ab");
    assert.equal(normalize("con­tract"), "contract");
    assert.equal(normalize("zero​width‌‍"), "zerowidth");
    assert.equal(normalize("﻿Hello"), "Hello");
  });

  test("runs of spaces/tabs collapse and trailing space goes", () => {
    assert.equal(normalize("a \t  b   \nc"), "a b\nc");
  });

  test("blank lines are load-bearing: 3+ collapse to exactly one blank line, never zero", () => {
    assert.equal(normalize("a\n\n\n\n\nb"), "a\n\nb");
    assert.equal(normalize("a\n\nb"), "a\n\nb");
  });

  test("trims the whole text; nullish and empty give an empty string", () => {
    assert.equal(normalize("\n\n  hi  \n\n"), "hi");
    for (const v of [null, undefined, "", "  \n "]) assert.equal(normalize(v), "");
  });
});

describe("checkFile", () => {
  const ok = (over) => checkFile({ fileName: "a.pdf", mimeType: "application/pdf", byteSize: 100, ...over });

  test("accepted extensions, case-insensitive; extension decides, mime only corroborates", () => {
    for (const f of ["a.pdf", "A.PDF", "a.docx", "a.txt", "a.md", "a.csv"]) assert.equal(ok({ fileName: f }).ok, true, f);
    assert.deepEqual(ok({ fileName: "A.PDF" }), { ok: true, ext: ".pdf" });
    assert.equal(ok({ fileName: "a.docx", mimeType: "application/octet-stream" }).ok, true);
    assert.equal(ok({ fileName: "a.md", mimeType: "" }).ok, true);
  });

  test("unsupported or missing extensions are refused with the accepted list in the reason", () => {
    for (const f of ["a.exe", "a.pdf.exe", "archive.tar.gz", "noext", "", undefined, "a.xlsx"]) {
      const r = ok({ fileName: f });
      assert.equal(r.ok, false, String(f));
      assert.ok(r.reason.startsWith("unsupportedType:"), r.reason);
    }
    assert.equal(ok({ fileName: "a.exe" }).reason, `unsupportedType:${ACCEPTED_EXTENSIONS.join(" ")}`);
  });

  test("size: over the cap is tooLarge, exactly the cap is fine, zero is empty, unknown is skipped", () => {
    assert.equal(ok({ byteSize: MAX_UPLOAD_BYTES + 1 }).reason, "tooLarge");
    assert.equal(ok({ byteSize: MAX_UPLOAD_BYTES }).ok, true);
    assert.equal(ok({ byteSize: 0 }).reason, "empty");
    assert.equal(ok({ byteSize: undefined }).ok, true);
  });

  test("a declared image/video/audio type is rejected early, even on a .pdf name", () => {
    for (const m of ["image/png", "video/mp4", "audio/mpeg"]) {
      assert.equal(ok({ mimeType: m }).ok, false, m);
    }
  });
});

describe("isEditable (§6.7)", () => {
  test("typed text is editable; crawled URLs never are", () => {
    assert.equal(isEditable({ kind: "text" }), true);
    assert.equal(isEditable({ kind: "text", fileName: "x.pdf" }), true, "typed text wins over a stray name");
    assert.equal(isEditable({ kind: "url", fileName: "page.md" }), false);
  });

  test("uploaded files: only .txt and .md", () => {
    for (const f of ["a.txt", "a.md", "A.TXT", "notes.MD"]) assert.equal(isEditable({ kind: "file", fileName: f }), true, f);
    for (const f of ["a.pdf", "a.docx", "a.csv", "", null, undefined]) assert.equal(isEditable({ kind: "file", fileName: f }), false, String(f));
  });

  test("nothing / unknown kind", () => {
    assert.equal(isEditable(null), false);
    assert.equal(isEditable(undefined), false);
    assert.equal(isEditable({}), false);
  });
});
