// TEST ONLY fake challenge handler (tabcap-hook/1). It recognises the tabcap
// e2e s15 test page by a marker in its text and returns a canned answer;
// anything else goes to the human. tabcap itself ships no handlers.

export {};

const MARKER = "tabcap-e2e-verify-wall";
const CANNED = "4217";

const raw = await Bun.stdin.text();
let input: unknown = null;
try {
  input = JSON.parse(raw);
} catch {
  input = null;
}
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const rec = (v: unknown): Record<string, unknown> => (isObj(v) ? v : {});
const page = rec(rec(input)["page"]);
const text = typeof page["text"] === "string" ? page["text"] : "";
const out =
  rec(input)["hook"] === "challenge" && text.includes(MARKER)
    ? { decision: "answer", answer: { code: CANNED }, note: `canned answer for the test page; saw site=${String(rec(input)["site"])}`, echo: text.slice(0, 200) }
    : { decision: "handoff", note: "not the test page" };
process.stdout.write(JSON.stringify(out) + "\n");
