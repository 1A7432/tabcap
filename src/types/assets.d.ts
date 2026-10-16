// Text assets embedded with `import x from "…" with { type: "text" }` (Bun),
// so the compiled binary carries them (templates/python/).
declare module "*.py" {
  const text: string;
  export default text;
}
declare module "*.toml" {
  const text: string;
  export default text;
}
declare module "*.md" {
  const text: string;
  export default text;
}
// Adapter page scripts (src/daemon/adapters/<name>/page.js), embedded as text.
declare module "*/page.js" {
  const text: string;
  export default text;
}
// Native wire binaries embedded with `import x from "…" with { type: "file" }`:
// the value is a path inside the compiled executable (src/wire/embedded.ts).
declare module "*/wireprint" {
  const path: string;
  export default path;
}
declare module "*/wireprint.exe" {
  const path: string;
  export default path;
}
// PEM files of the wire echo (src/wire/certs/), embedded as text.
declare module "*.pem" {
  const text: string;
  export default text;
}
