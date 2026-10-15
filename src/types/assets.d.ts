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
