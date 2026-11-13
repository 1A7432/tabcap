// `tabcap evaluate --file <path>` (docs/04 §54.1): the expression comes from a
// file, so a long script needs no shell quoting. The CLI reads it (the path is
// relative to the caller's working directory, already resolved by
// withLocalPaths) and sends its text, as one block statement (asBlock), as
// `expression`; the daemon and the recording's `cmd` event see what ran.
//
// The file is untrusted input: UTF-8 (a byte order mark is dropped), or UTF-16
// with a byte order mark (what Windows PowerShell 5.1 writes with `>` and
// `Out-File`); anything else is refused, never guessed.

import { readFileSync } from "node:fs";
import { TabcapError } from "../shared/envelope.ts";

export const EVAL_FILE_MAX_BYTES = 8 * 1024 * 1024;

export type ReadBytes = (path: string) => Uint8Array;

const defaultRead: ReadBytes = (p) => {
  try {
    return readFileSync(p);
  } catch (e) {
    throw new TabcapError("not-found", `cannot read ${p}: ${e instanceof Error ? e.message : String(e)}`, "Check the path after --file (it is relative to the directory the command runs in).");
  }
};

/** The text of a script file; throws `bad-input` for bytes that are neither UTF-8 nor UTF-16 with a byte order mark. */
export function decodeScript(bytes: Uint8Array, path: string): string {
  const b0 = bytes[0];
  const b1 = bytes[1];
  const utf16 = b0 === 0xff && b1 === 0xfe ? "utf-16le" : b0 === 0xfe && b1 === 0xff ? "utf-16be" : null;
  try {
    if (utf16 !== null) return new TextDecoder(utf16, { fatal: true }).decode(bytes.subarray(2));
    // TextDecoder drops a UTF-8 byte order mark by itself.
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new TabcapError(
      "bad-input",
      `${path} is not ${utf16 === null ? "UTF-8" : "valid UTF-16"} text`,
      "Save the script as UTF-8 (Windows PowerShell 5.1: `Set-Content -Encoding utf8`; its default is the system code page).",
    );
  }
}

/** `--file <path>` → `expression` with the file's text; arguments without --file pass through. */
export function evaluateArgs(args: Record<string, unknown>, read: ReadBytes = defaultRead): Record<string, unknown> {
  const file = args["file"];
  if (typeof file !== "string" || file === "") return args;
  const usage = "tabcap evaluate --file <path> [--await] | tabcap evaluate <expr> [--await] | tabcap evaluate --function '<js function>' [--args '<json array>']";
  if (typeof args["expression"] === "string" && args["expression"] !== "") throw new TabcapError("usage", "give either an expression or --file, not both", `Usage: ${usage}`);
  if (typeof args["function"] === "string") throw new TabcapError("usage", "--file holds an expression script; it does not go with --function", `Usage: ${usage}`);
  const bytes = read(file);
  if (bytes.length > EVAL_FILE_MAX_BYTES) throw new TabcapError("bad-input", `${file} is ${bytes.length} bytes; --file takes at most ${EVAL_FILE_MAX_BYTES}`, "Load a script that large from the page itself, or split it.");
  const text = decodeScript(bytes, file);
  if (text.trim() === "") throw new TabcapError("bad-input", `${file} is empty`, "Put the JavaScript to run in the file.");
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) if (k !== "file") rest[k] = v;
  return { ...rest, expression: asBlock(text) };
}

/**
 * The script as one block statement. Its value is still the value of its last expression statement, and its
 * top-level `let` / `const` / `class` stay inside the block, so the same file runs again on the same document
 * (as a plain script the second run fails with "Identifier … has already been declared"); `var`, function
 * declarations and assignments to `window` reach the page as before. The brace sits on line 1, so line numbers
 * in errors are the file's own; the closing brace is on a line of its own because the file may end in a comment.
 */
export const asBlock = (script: string): string => `{${script}\n}`;
